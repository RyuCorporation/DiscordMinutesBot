// client.js
// TempestPhoenix（BlockNotion）へページを作るための薄いクライアント。
//
// 認証は「エージェントAPIキー → 短命 JWT」の2段。キーそのものはヘッダに乗らない。
//   POST /api/admin/auth/agent-token  { apiKey } -> { accessToken }   （有効期限 1時間）
//   以降は Authorization: Bearer <accessToken>
//
// 本文は Markdown ではなくブロック（markdown-to-blocks.js で変換する）。
//   POST /api/blocks/        ページ（type:"page"）を1つ作る ※末尾スラッシュ必須
//   POST /api/blocks/batch   そのページの子として本文ブロックをまとめて作る
//
// 必要な環境変数:
//   TP_API_BASE       例: https://tp.liucotech.com
//   TP_AGENT_API_KEY  tpx_agent_… （TempestPhoenix の管理画面で発行するエージェントキー）
//   TP_SITE_BASE      省略可。ページ URL の組み立て先（既定は <TP_API_BASE>/notion/）

/** API がエラーステータスを返したとき。 */
export class ApiError extends Error {
  constructor(status, body) {
    super(`BlockNotion API エラー (${status}): ${body || "(本文なし)"}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** APIキーが無効・失効しているなど、認証そのものに失敗したとき。 */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

const TOKEN_TTL_MS = 55 * 60 * 1000; // JWT は1時間有効。少し手前で取り直す
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WAIT_MS = 1000; // nginx の limit_req（20r/s・超過は 503）に当たったときの待ち
const REQUEST_SPACING_MS = 120; // 連投の間隔。Importer と同じ
const MAX_BLOCKS_PER_BATCH = 200; // 長い文字起こしを1リクエストに詰め込みすぎない

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BlockNotionClient {
  constructor({ apiBase, apiKey, siteBase }) {
    if (!apiBase) throw new Error("apiBase は必須です");
    if (!apiKey) throw new Error("apiKey は必須です");
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.siteBase = (siteBase || `${this.apiBase}/notion/`).replace(/\/*$/, "/");
    this.token = null;
    this.tokenFetchedAt = 0;
    this.lastRequestAt = 0;
  }

  /** ページの公開 URL。BlockNotion はハッシュルーティングでスラッグを持たない。 */
  pageUrl(id) {
    return `${this.siteBase}#${id}`;
  }

  /** JWT を取得する（55分キャッシュ）。force で無条件に取り直す。 */
  async accessToken(force = false) {
    if (!force && this.token && Date.now() - this.tokenFetchedAt < TOKEN_TTL_MS) return this.token;

    const res = await fetch(`${this.apiBase}/api/admin/auth/agent-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: this.apiKey }),
    });
    if (res.status === 401) {
      throw new AuthError("TP_AGENT_API_KEY が無効か失効しています（agent-token が 401）。");
    }
    if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));

    const data = await res.json();
    if (!data?.accessToken) throw new AuthError("agent-token の応答に accessToken がありません。");
    this.token = data.accessToken;
    this.tokenFetchedAt = Date.now();
    return this.token;
  }

  /**
   * 共通の POST。
   * 503（レートリミット）は間を空けて再試行し、401 はトークンを取り直して1度だけやり直す。
   */
  async post(path, body) {
    let refreshed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // nginx の limit_req に当てないよう、リクエストの間隔を空ける。
      const since = Date.now() - this.lastRequestAt;
      if (since < REQUEST_SPACING_MS) await sleep(REQUEST_SPACING_MS - since);

      const token = await this.accessToken();
      this.lastRequestAt = Date.now();

      const res = await fetch(`${this.apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

      if (res.ok) return await res.json();

      if (res.status === 401 && !refreshed) {
        // JWT の期限切れとみなして取り直す（キー自体が無効なら accessToken 側が AuthError を投げる）。
        refreshed = true;
        this.token = null;
        continue;
      }
      if (res.status === 503 && attempt < MAX_ATTEMPTS) {
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw new ApiError(res.status, await res.text().catch(() => ""));
    }
    throw new ApiError(503, "レートリミットが解消されませんでした（最大リトライ到達）");
  }

  /**
   * ページを1つ作る。
   * @returns {Promise<{id: string}>} 作成されたページ
   */
  createPage({ title, parentId = null }) {
    // 末尾スラッシュ必須。/api/blocks は nginx が 301 で /api/blocks/ へ送り、
    // リダイレクトの際に POST が GET へ落ちてしまう。
    return this.post("/api/blocks/", {
      type: "page",
      parentId,
      props: { title: [[title, []]] },
    });
  }

  /**
   * ページの子として本文ブロックをまとめて作る。長い本文は分割して順に追記する
   * （afterId を指定しなければ末尾追加なので、分割しても並び順は保たれる）。
   */
  async appendBlocks(parentId, blocks) {
    for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_BATCH) {
      await this.post("/api/blocks/batch", {
        parentId,
        blocks: blocks.slice(i, i + MAX_BLOCKS_PER_BATCH),
      });
    }
  }
}

/** 環境変数からクライアントを作る。 */
export function clientFromEnv(env = globalThis.process?.env ?? {}) {
  if (!env.TP_API_BASE) throw new Error("環境変数 TP_API_BASE が未設定です");
  if (!env.TP_AGENT_API_KEY) throw new Error("環境変数 TP_AGENT_API_KEY が未設定です");
  return new BlockNotionClient({
    apiBase: env.TP_API_BASE,
    apiKey: env.TP_AGENT_API_KEY,
    siteBase: env.TP_SITE_BASE,
  });
}
