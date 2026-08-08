// post-minutes.js
// 生成済みの議事録・文字起こしを TempestPhoenix の BlockNotion へ投稿する。
//
// 投稿フロー（postMinutesToBlockNotion）:
//   1) "議事録" ページ（MINUTES_PARENT_ID）の子として、議事録ページを作成
//   2) 議事録本文（Markdown）をブロックへ変換して本文に流し込む
//   3) 文字起こしがあれば、議事録ページの子として全文ページを作成
//      （BlockNotion はサブページを本文中にリンクとして描くので、リンクの追記は要らない）
//   → 作成した議事録ページの { id, url, title } を返す
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
 * 議事録と文字起こしを BlockNotion に投稿する。
 * @param {{ label: string, summary: string, transcript?: string, parentId?: string|null }} input
 *   label: "2026-06-13" のような日付ラベル。タイトルは「議事録 <label>」になる。
 *   summary: 議事録本文（Markdown）。
 *   transcript: 文字起こし全文（あれば子ページを作る）。
 *   parentId: 議事録ページの親（未指定なら TP_MINUTES_PARENT_ID）。
 * @returns {Promise<{ id: string, url: string, title: string }>} 作成した議事録ページ
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
  const title = `議事録 ${label}`;

  // 1) 議事録ページを作成し、2) 本文を流し込む
  const minutes = await client.createPage({ title, parentId: rootParent });
  await client.appendBlocks(minutes.id, markdownToBlocks(summary));

  // 3) 文字起こしがあれば、議事録ページの子として全文ページを作る。
  //    サブページは本文の末尾にリンクとして現れるので、区切り線だけ先に置く。
  if (transcript && transcript.trim()) {
    await client.appendBlocks(minutes.id, [{ type: "divider", props: {} }]);
    const transcriptPage = await client.createPage({
      title: `文字起こし ${label}`,
      parentId: minutes.id,
    });
    await client.appendBlocks(transcriptPage.id, transcriptToBlocks(transcript));
  }

  return { id: minutes.id, url: client.pageUrl(minutes.id), title };
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
