// markdown-to-blocks.js
// Markdown 本文 → BlockNotion のブロック列（POST /api/blocks/batch の blocks と同じ形）。
//
// BlockNotion は Markdown を受け付けず、本文は「ブロック＋styled-spans」でしか表現できない。
// 変換規則は TempestPhoenix の Importer（src/Importer/MarkdownToBlocks.cs・InlineMarkdown.cs）を
// 移植したもの。移行済みの過去議事録と同じ見た目になるよう、同じ規則を保つこと。
//
// 移行と同じく「一方向」の変換で、ブロック → Markdown へ戻すことは考えない。

// --- インライン記法 → styled-spans ------------------------------------------

// 記法の切り出し。長い区切り（** と ~~）を先に見ないと * や ~ に食われる。
const INLINE_RULES = [
  [/\*\*(?<t>[\s\S]+?)\*\*/, "b"],
  [/~~(?<t>[\s\S]+?)~~/, "s"],
  [/(?<!\*)\*(?!\*)(?<t>[^*\n]+?)\*(?!\*)/, "i"],
  [/`(?<t>[^`\n]+?)`/, "c"],
];

// [ラベル](URL)。画像 ![…](…) は別に扱うのでここでは弾く。
// ラベルは角括弧を1段だけ入れ子で許す（「議事録 [テスト] 2026-06-13」のような題があるため）。
const LINK = /(?<!!)\[(?<label>(?:[^[\]]|\[[^[\]]*\])*)\]\((?<url>[^)\s]+)(?:\s+"[^"]*")?\)/;
// <https://…> の自動リンク。ラベルは URL そのもの。
const AUTO_LINK = /<(?<url>[a-zA-Z][\w+.-]*:\/\/[^>\s]+)>/;
const BREAK = /<br\s*\/?>/gi;

/** スタイル列が同じかどうか（連続する span をまとめるための比較）。 */
function sameStyles(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function walkInline(text, styles, into) {
  if (text.length === 0) return;

  // いちばん手前に現れる記法を探して、そこで3つに割る。
  let best = null;
  let bestStyle = null;
  let bestUrl = null;

  for (const [pattern, style] of INLINE_RULES) {
    const m = pattern.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = m;
      bestStyle = style;
      bestUrl = null;
    }
  }
  const link = LINK.exec(text);
  if (link && (best === null || link.index < best.index)) {
    best = link;
    bestStyle = "a";
    bestUrl = link.groups.url;
  }
  const autoLink = AUTO_LINK.exec(text);
  if (autoLink && (best === null || autoLink.index < best.index)) {
    best = autoLink;
    bestStyle = "a";
    bestUrl = autoLink.groups.url;
  }

  if (best === null) {
    into.push([text, styles]);
    return;
  }

  if (best.index > 0) into.push([text.slice(0, best.index), styles]);

  // リンクのラベル。autolink は label 群を持たないので URL 自身を使う。
  const innerText = bestStyle === "a" ? (best.groups.label ?? bestUrl) : best.groups.t;
  const innerStyles = [...styles, bestUrl == null ? [bestStyle] : [bestStyle, bestUrl]];
  if (bestStyle === "c") {
    // インラインコードの中身は記法として解釈しない（`**` はコードの一部）。
    into.push([innerText, innerStyles]);
  } else {
    walkInline(innerText, innerStyles, into);
  }

  walkInline(text.slice(best.index + best[0].length), styles, into);
}

/** Markdown の断片 → styled-spans（[[text, styles], …]）。 */
export function spans(markdown) {
  const raw = [];
  walkInline((markdown ?? "").replace(BREAK, "\n"), [], raw);

  // 同じスタイルの連続をまとめ、空文字を捨てる。
  const merged = [];
  for (const [text, styles] of raw) {
    if (text.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && sameStyles(last[1], styles)) last[0] += text;
    else merged.push([text, styles]);
  }
  return merged;
}

/** 装飾を落とした平文（表の列名など、spans を置けない場所用）。 */
export function plainText(markdown) {
  return spans(markdown)
    .map(([text]) => text)
    .join("");
}

// --- ブロック記法 ------------------------------------------------------------

const HEADING = /^(?<h>#{1,6})\s+(?<t>.*)$/;
const BULLET = /^(?<indent>\s*)[-*+]\s+(?!\[[ xX]\])(?<t>.*)$/;
const TODO = /^(?<indent>\s*)[-*+]\s+\[(?<mark>[ xX])\]\s+(?<t>.*)$/;
const NUMBERED = /^(?<indent>\s*)\d+[.)]\s+(?<t>.*)$/;
const QUOTE = /^>\s?(?<t>.*)$/;
const DIVIDER = /^\s*([-*_])\s*(\1\s*){2,}$/;
const FENCE = /^\s*```(?<lang>[\w+-]*)\s*$/;
const TABLE_ROW = /^\s*\|.*\|?\s*$/;
const TABLE_SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const IMAGE_ONLY = /^\s*!\[(?<alt>[^\]]*)\]\((?<url>[^)\s]+)\)\s*$/;
// タグ名のあとが「>」「/>」「空白＋属性…>」のときだけ HTML とみなす。
// これを緩くすると autolink（<https://…>）まで拾って URL ごと消してしまう。
const HTML_BLOCK = /^\s*<(?<tag>[a-zA-Z][\w-]*)\s*(\/?>|\s[^>]*>)/;

const inlineImages = () => /!\[(?<alt>[^\]]*)\]\((?<url>[^)\s]+)\)/g;
const htmlImages = () => /<img\b[^>]*?\bsrc=(?<q>["'])(?<url>[^"']*)\k<q>[^>]*>/gi;

const text = (type, markdown) => ({ type, props: { title: spans(markdown) } });

function code(body, language) {
  return {
    type: "code",
    // コードは装飾を掛けない（フェンスの中の ** はコードの一部）。
    props: { title: body.length === 0 ? [] : [[body, []]], language },
  };
}

/**
 * 画像を含む行を「画像だけの行」とその前後に割る。割るものが無ければ null。
 * 割らずにいると、生 HTML のタグ剥がしで <img> ごと消えてしまう。
 */
function splitImages(line) {
  const matches = [...line.matchAll(inlineImages()), ...line.matchAll(htmlImages())].sort(
    (a, b) => a.index - b.index,
  );
  if (matches.length === 0) return null;

  const parts = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.index > cursor) parts.push(line.slice(cursor, m.index));
    parts.push(`![](${m.groups.url})`);
    cursor = m.index + m[0].length;
  }
  if (cursor < line.length) parts.push(line.slice(cursor));

  // 既に「画像だけの行」なら割らない（割ると同じ行を延々と読み直す）。
  return parts.length === 1 && parts[0] === line ? null : parts;
}

/** database のセルにはブロックを置けないので、セル内の画像はリンクへ倒す。 */
function cellImagesToLinks(cell) {
  const toLink = (url, alt) => {
    const label = (alt ?? "").replace(/[[\]]/g, "").trim();
    return `[${label.length > 0 ? label : url}](${url})`;
  };
  return cell
    .replace(htmlImages(), (m, _q, url) => {
      const alt = /\balt=(["'])([^"']*)\1/i.exec(m);
      return toLink(url, alt ? alt[2] : "");
    })
    .replace(inlineImages(), (_m, alt, url) => toLink(url, alt));
}

function splitRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

/** 表 → database。1列目が行タイトル、2列目以降が schema の列。 */
function table(chunk) {
  const header = splitRow(chunk[0]);
  const bodyRows = chunk.slice(2).map((row) => splitRow(row).map(cellImagesToLinks));

  const schema = {};
  const propIds = [];
  for (let c = 1; c < header.length; c++) {
    const propId = `p${c}`;
    propIds.push(propId);
    schema[propId] = { name: plainText(header[c]), type: "text" };
  }

  const rows = bodyRows.map((cells) => {
    const cellValues = {};
    for (let c = 1; c < header.length; c++) {
      const value = c < cells.length ? cells[c] : "";
      if (value.trim().length > 0) cellValues[propIds[c - 1]] = spans(value);
    }
    return { type: "page", props: { title: spans(cells[0] ?? ""), cells: cellValues } };
  });

  const titleName = plainText(header[0] ?? "");
  return {
    type: "database",
    props: { title: [], titleName: titleName.length > 0 ? titleName : "Title", schema },
    children: rows,
  };
}

/**
 * Markdown 本文をブロック列へ変換する。
 * @param {string} markdown
 * @returns {Array<{type: string, props?: object, children?: any[]}>}
 */
export function markdownToBlocks(markdown) {
  const blocks = [];
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    // --- コードフェンス（複数行を1ブロックに畳む） ---
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      // 閉じフェンスが無いまま終わってもコードとして残す（貼られたものを捨てない）。
      blocks.push(code(body.join("\n"), fence.groups.lang));
      continue;
    }

    // --- 表（区切り行があるものだけ表とみなす） ---
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const chunk = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) chunk.push(lines[i++]);
      i--;
      blocks.push(table(chunk));
      continue;
    }

    // --- 区切り線（表の区切り行と紛れないよう表の後に見る） ---
    if (DIVIDER.test(line)) {
      blocks.push({ type: "divider", props: {} });
      continue;
    }

    // --- 画像を含む行を割る（コードフェンスと表は上で食い終わっている） ---
    const split = splitImages(line);
    if (split) {
      lines.splice(i, 1, ...split);
      i--; // 割った先頭からもう一度読む
      continue;
    }

    const image = IMAGE_ONLY.exec(line);
    if (image) {
      // 画像の実体のアップロードは行わない。URL のまま持たせる。
      blocks.push({ type: "image", props: { url: image.groups.url } });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        props: { title: spans(heading.groups.t), level: Math.min(heading.groups.h.length, 3) },
      });
      continue;
    }

    // --- チェックリスト（箇条書きより先に見る） ---
    const todo = TODO.exec(line);
    if (todo) {
      blocks.push({
        type: "todo",
        props: { title: spans(todo.groups.t), checked: todo.groups.mark.toLowerCase() === "x" },
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      blocks.push(text("list", bullet.groups.t));
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      blocks.push(text("numbered", numbered.groups.t));
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      blocks.push(text("quote", quote.groups.t));
      continue;
    }

    // --- 生 HTML。表現は落ちるが文字は残す ---
    if (HTML_BLOCK.test(line)) {
      const stripped = line.replace(/<[^>]+>/g, "").trim();
      if (stripped.length > 0) blocks.push(text("paragraph", stripped));
      continue;
    }

    blocks.push(text("paragraph", line));
  }

  return blocks;
}

/**
 * 文字起こし（1行 = 1発言）→ 段落ブロック列。
 * Markdown としては解釈しない（発話に出てくる * や # は記法ではなく文字）。
 */
export function transcriptToBlocks(transcript) {
  return (transcript ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ type: "paragraph", props: { title: [[line, []]] } }));
}
