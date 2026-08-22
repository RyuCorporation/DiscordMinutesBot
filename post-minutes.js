// post-minutes.js
// 生成済みの議事録・文字起こしを TempestPhoenix の BlockNotion へ投稿する。
//
// 投稿フロー（postMinutesToBlockNotion）:
//   1) "議事録" ページ（MINUTES_PARENT_ID）の下から、その日の日付ページ（"議事録 2026-08-22"）を
//      探す。無ければ作る。既にあれば中身はそのままで、以降のページを末尾に足していく。
//      日付ページは手で作られることがあるので、表記ゆれは parseDatePageTitle が吸収する。
//   2) 日付ページの子として「議事録」ページを作り、本文（Markdown）をブロックへ変換して流し込む
//      （同じ日に2回目以降があれば「議事録 (2)」…と連番）
//   3) 文字起こしがあれば、同じ日付ページの子として「文字起こし」ページを作成（議事録の兄弟）
//      （BlockNotion はサブページを本文中にリンクとして描くので、リンクの追記は要らない）
//   → 作成した議事録ページの { id, url, title, datePage, transcriptId } を返す
//
// スタンドアロン: node post-minutes.js <議事録ファイル.md> [タイトル] [文字起こしファイル]
//
// 必要な環境変数（.env）:
//   TP_API_BASE, TP_AGENT_API_KEY, TP_MINUTES_PARENT_ID, TP_SITE_BASE（省略可）
//
// TP_MINUTES_PARENT_ID（"議事録" ページの ID）は既定値を持たせない。
// 本リポジトリは public なので、投稿先ページの ID をソースに埋めない。

import "dotenv/config";
import fs from "fs";
import path from "path";
import { clientFromEnv } from "./blocknotion/client.js";
import { markdownToBlocks, transcriptToBlocks } from "./blocknotion/markdown-to-blocks.js";

/**
 * セッションラベル（"2026-08-16" や "2026-08-16_2"）から会議日の表記を作る。
 * 文字起こしには日付が含まれないので、議事録生成のプロンプトへ日付を渡すために使う。
 * 日付として読めないラベルは null を返す（プロンプトへ何も足さない）。
 * @param {string} label
 * @returns {string|null} 例: "2026年8月16日"
 */
export function sessionDateFromLabel(label) {
  const m = String(label ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : null;
}

/**
 * 日付ページのタイトルから日付（YYYY-MM-DD）を読み取る。日付ページでなければ null。
 * 手で作られたページを拾えるよう、先頭の「議事録」と日付の表記ゆれを許容する:
 *   "議事録 2026-08-22" / "2026-08-22" / "2026/8/22" / "2026年8月22日" / "2026-08-22（土）"
 * 日付以外の語が付くタイトル（"アジェンダ" など）は日付ページとみなさない。
 * @param {string} title
 * @returns {string|null} 例: "2026-08-22"
 */
export function parseDatePageTitle(title) {
  const m = String(title ?? "")
    .trim()
    .replace(/^議事録\s*/, "")
    .match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s*[（(][^）)]*[）)])?$/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/** セッションラベル（"2026-08-16_2"）から日付キー（"2026-08-16"）を取り出す。 */
export function dateKeyFromLabel(label) {
  const m = String(label ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(label ?? "");
}

/** 日付ページを新規作成するときのタイトル（手で作られているものと同じ書き方に合わせる）。 */
export function datePageTitleFromLabel(label) {
  return `議事録 ${dateKeyFromLabel(label)}`;
}

/**
 * 日付ページの中に作る議事録・文字起こしのタイトルを決める。
 * 1回目は「議事録」「文字起こし」。同じ日に2回目以降があれば "(2)" "(3)" … と連番を付ける。
 * @param {string[]} existingTitles 日付ページ直下にある子ページのタイトル
 */
export function nextEntryTitles(existingTitles) {
  const taken = new Set(existingTitles);
  if (!taken.has("議事録") && !taken.has("文字起こし")) {
    return { minutes: "議事録", transcript: "文字起こし" };
  }
  for (let n = 2; ; n++) {
    const minutes = `議事録 (${n})`;
    const transcript = `文字起こし (${n})`;
    if (!taken.has(minutes) && !taken.has(transcript)) return { minutes, transcript };
  }
}

/** ブロックのタイトル文字列（props.title は [[text, marks], ...] の形）。 */
function titleOf(block) {
  return (block?.props?.title ?? []).map((seg) => seg?.[0] ?? "").join("");
}

/**
 * その日の日付ページを探し、無ければ作る。
 * 既にあるときは中身に触れないので、議事録・文字起こしはそのページの末尾に足されていく。
 */
async function findOrCreateDatePage(client, parentId, { dateKey, newTitle }) {
  const tree = await client.request("GET", `/api/blocks/${parentId}/tree`);
  const existing = (tree?.children ?? []).find(
    (c) => c.type === "page" && parseDatePageTitle(titleOf(c)) === dateKey
  );
  if (existing) {
    return { id: existing.id, title: titleOf(existing), created: false };
  }

  const page = await client.createPage({ title: newTitle, parentId });
  return { id: page.id, title: newTitle, created: true };
}

/** 日付ページ直下にある子ページのタイトル一覧。連番を決めるのに使う。 */
async function childPageTitles(client, pageId) {
  const tree = await client.request("GET", `/api/blocks/${pageId}/tree`);
  return (tree?.children ?? []).filter((c) => c.type === "page").map((c) => titleOf(c));
}

/**
 * 議事録と文字起こしを BlockNotion に投稿する。
 * 「議事録」ページ → 日付ページ → 議事録／文字起こし の3階層。
 * 日付ページが既にあればそこへ追加するので、同じ日に複数回やっても並んでいく。
 * @param {{ label: string, summary: string, transcript?: string, parentId?: string|null }} input
 *   label: "2026-06-13" のようなセッションラベル。日付ページの特定に使う
 *     （ページのタイトル自体は「議事録」「文字起こし」、同じ日の2回目以降は "(2)" 付き）。
 *   summary: 議事録本文（Markdown）。
 *   transcript: 文字起こし全文（あれば日付ページ直下にもう1ページ作る）。
 *   parentId: 日付ページの親（未指定なら TP_MINUTES_PARENT_ID）。
 * @returns {Promise<{ id: string, url: string, title: string, datePage: object, transcriptId: string|null }>}
 */
export async function postMinutesToBlockNotion({ label, summary, transcript, parentId }) {
  if (!summary || !summary.trim()) {
    throw new Error("投稿する議事録の本文が空です。");
  }
  const rootParent = parentId ?? process.env.TP_MINUTES_PARENT_ID;
  if (!rootParent) {
    throw new Error('環境変数 TP_MINUTES_PARENT_ID が未設定です（BlockNotion の "議事録" ページの ID）');
  }
  const client = clientFromEnv();

  const datePage = await findOrCreateDatePage(client, rootParent, {
    dateKey: dateKeyFromLabel(label),
    newTitle: datePageTitleFromLabel(label),
  });
  console.log(
    datePage.created
      ? `日付ページを作成: ${datePage.title}`
      : `既存の日付ページに追加: ${datePage.title}`
  );

  // 同じ日付ページに既に議事録があれば "(2)" "(3)" … と連番になる
  const titles = nextEntryTitles(datePage.created ? [] : await childPageTitles(client, datePage.id));
  const title = titles.minutes;
  const minutes = await client.createPage({ title, parentId: datePage.id });
  await client.appendBlocks(minutes.id, markdownToBlocks(summary));

  let transcriptPage = null;
  if (transcript && transcript.trim()) {
    transcriptPage = await client.createPage({
      title: titles.transcript,
      parentId: datePage.id,
    });
    await client.appendBlocks(transcriptPage.id, transcriptToBlocks(transcript));
  }

  return {
    id: minutes.id,
    url: client.pageUrl(minutes.id),
    title,
    datePage: {
      id: datePage.id,
      url: client.pageUrl(datePage.id),
      title: datePage.title,
      created: datePage.created,
    },
    transcriptId: transcriptPage?.id ?? null,
  };
}

/**
 * 既にある議事録ページの中身を差し替える（ページ自体は作り直さない）。
 * ページ ID が変わらないので、Discord に貼ったリンクはそのまま使える。
 * 文字起こしは同じ日付ページの下にある兄弟ページなので、あればそちらも入れ替える。
 * @param {{ pageId: string, label: string, summary: string, transcript?: string }} input
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function replaceMinutesPage({ pageId, label, summary, transcript }) {
  if (!pageId) throw new Error("差し替え先のページ ID が指定されていません。");
  if (!summary || !summary.trim()) {
    throw new Error("投稿する議事録の本文が空です。");
  }
  const client = clientFromEnv();

  const page = await client.getBlock(pageId);
  if (page?.type !== "page") {
    throw new Error(`差し替え先 ${pageId} はページではありません（type: ${page?.type}）。`);
  }

  // 既存の子ブロックを消す（旧構成でぶら下がっている文字起こしページも中身ごと消える）。
  for (const child of page.children ?? []) {
    await client.deleteBlock(child.id);
  }
  await client.appendBlocks(pageId, markdownToBlocks(summary));

  if (transcript && transcript.trim() && page.parentId) {
    // 文字起こしのタイトルは議事録ページに対応させる（"議事録 (2)" なら "文字起こし (2)"、
    // 旧構成の "議事録 2026-08-16" なら "文字起こし 2026-08-16"）。
    const pageTitle = titleOf(page);
    const transcriptTitle = pageTitle.startsWith("議事録")
      ? pageTitle.replace(/^議事録/, "文字起こし")
      : `文字起こし ${label}`;
    const parentTree = await client.request("GET", `/api/blocks/${page.parentId}/tree`);
    const sibling = (parentTree?.children ?? []).find(
      (c) => c.type === "page" && titleOf(c) === transcriptTitle
    );

    let targetId = sibling?.id;
    if (targetId) {
      const existing = await client.getBlock(targetId);
      for (const child of existing.children ?? []) {
        await client.deleteBlock(child.id);
      }
    } else {
      const created = await client.createPage({
        title: transcriptTitle,
        parentId: page.parentId,
      });
      targetId = created.id;
    }
    await client.appendBlocks(targetId, transcriptToBlocks(transcript));
  }

  return { id: pageId, url: client.pageUrl(pageId) };
}

// --- スタンドアロン実行 ---
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("使い方: node post-minutes.js <議事録ファイル.md> [タイトル] [文字起こしファイル]");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`ファイルが見つかりません: ${filePath}`);
    process.exit(1);
  }

  const summary = fs.readFileSync(filePath, "utf-8");
  // ラベル: 引数 > ファイル名から「議事録_」を除いたもの
  const label = process.argv[3] || path.basename(filePath, path.extname(filePath)).replace(/^議事録[_ ]?/, "");

  // 文字起こし: 引数指定 > 同じフォルダの transcript.txt
  let transcript;
  const transcriptArg = process.argv[4];
  const defaultTranscript = path.join(path.dirname(filePath), "transcript.txt");
  const transcriptPath = transcriptArg || (fs.existsSync(defaultTranscript) ? defaultTranscript : null);
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    transcript = fs.readFileSync(transcriptPath, "utf-8");
    console.log(`文字起こし添付: ${transcriptPath}`);
  }

  console.log(`BlockNotion へ投稿中: "議事録 ${label}"`);
  try {
    const result = await postMinutesToBlockNotion({ label, summary, transcript });
    console.log(`投稿成功: ${result.url}`);
  } catch (e) {
    console.error("投稿失敗:", e.name, "-", e.message);
    process.exit(1);
  }
}

// このファイルが直接実行されたときだけ main() を走らせる（import 時は実行しない）。
if (process.argv[1]?.endsWith("post-minutes.js")) {
  main();
}
