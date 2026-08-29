// generate-minutes.js
// 既存の recording.wav から議事録を生成するスタンドアロンスクリプト
// Usage: node generate-minutes.js [recordings/2026-03-14] [--force-transcribe] [--page blk_xxx]
//
//   既に transcript.txt がある場合は Whisper を呼ばずにそれを使う（やり直しで課金しないため）。
//   文字起こしからやり直したいときだけ --force-transcribe を付ける。
//   生成後は BlockNotion へ投稿し、MINUTES_CHANNEL_ID があれば Discord にもリンクを流す。
//   --page を付けると新規作成ではなく既存ページの中身を差し替える（リンクを貼り直さずに済む。
//   このとき Discord へは投稿しない）。
//
//   議事録の書き方（タイムスタンプ形式・原文の流れを残す）は index.js と共通で summarize.js にある。

import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { Client, GatewayIntentBits } from "discord.js";
import {
  postMinutesToBlockNotion,
  replaceMinutesPage,
  sessionDateFromLabel,
} from "./post-minutes.js";
import { summarizeTranscript, formatTimestamp } from "./summarize.js";
import { buildMinutesPostHeader } from "./usage-metrics.js";
import { readOpenAICreditBalance } from "./billing-balance.js";
import { SAMPLE_RATE, detectSpeechSegments, sliceSegments } from "./audio.js";
import { buildTranscribePrompt, transcribeSegments } from "./transcribe.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Discord投稿 ---
// index.js と同じ形（「議事録 <日付>」メッセージ + そのスレッドにBlockNotionのリンク）で投稿する。
// スタンドアロン実行では interaction が無いので、投稿先は MINUTES_CHANNEL_ID のみ。
async function postMinutesLinkToDiscord({ sessionName, minutesUrl, usedTokens }) {
  const channelId = process.env.MINUTES_CHANNEL_ID;
  if (!channelId || !process.env.DISCORD_TOKEN) {
    console.log(
      "MINUTES_CHANNEL_ID / DISCORD_TOKEN が未設定のため、Discordへの投稿はスキップします。"
    );
    return;
  }

  // 残高は取れなくても投稿自体は続ける（ヘッダーが「取得不可」になるだけ）。
  let creditBalanceUsd = null;
  try {
    creditBalanceUsd = await readOpenAICreditBalance();
  } catch (err) {
    console.warn("クレジット残高の取得に失敗しました:", err.message);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(process.env.DISCORD_TOKEN);
    const channel = await client.channels.fetch(channelId);
    const headerMessage = await channel.send(
      buildMinutesPostHeader(sessionName, usedTokens, creditBalanceUsd)
    );
    const thread = await headerMessage.startThread({ name: `議事録 ${sessionName}` });
    await thread.send(`📝 議事録: ${minutesUrl}`);
    console.log("議事録スレッドをDiscordに作成しました。");
  } finally {
    await client.destroy();
  }
}

// --- メイン処理 ---
async function main() {
  const args = process.argv.slice(2);
  const forceTranscribe = args.includes("--force-transcribe");
  // --page blk_xxx / --page=blk_xxx で既存の議事録ページを差し替える（新規作成しない）
  const pageFlagIndex = args.findIndex((a) => a === "--page");
  const replacePageId =
    (pageFlagIndex >= 0 ? args[pageFlagIndex + 1] : null) ??
    args.find((a) => a.startsWith("--page="))?.slice("--page=".length) ??
    null;
  const pageValueIndex = pageFlagIndex >= 0 ? pageFlagIndex + 1 : -1;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== pageValueIndex);
  const sessionDir = positional[0] || "./recordings/2026-03-14";
  const transcriptPath = path.join(sessionDir, "transcript.txt");

  // 既存の文字起こしがあればWhisperを呼ばずに再利用する（議事録だけ作り直すケース）。
  const existingTranscript =
    !forceTranscribe && fs.existsSync(transcriptPath)
      ? fs.readFileSync(transcriptPath, "utf-8").trim()
      : "";
  if (existingTranscript) {
    console.log(`既存の文字起こしを再利用: ${transcriptPath}`);
    await generateAndPost(sessionDir, existingTranscript, { replacePageId });
    return;
  }

  const wavPath = path.join(sessionDir, "recording.wav");
  if (!fs.existsSync(wavPath)) {
    console.error(`ファイルが見つかりません: ${wavPath}`);
    process.exit(1);
  }

  console.log(`音声ファイル読み込み: ${wavPath}`);
  const wavData = fs.readFileSync(wavPath);
  // WAVヘッダー（44バイト）をスキップしてPCMデータを取得
  const pcmBuffer = wavData.subarray(44);

  const durationSec = pcmBuffer.length / (SAMPLE_RATE * 2 * 2);
  console.log(`音声長: ${durationSec.toFixed(1)}秒`);

  // 実際に音が鳴っている区間だけを取り出す。
  // 無音のまま渡すと Whisper が 30 秒窓ごとに定型句を捏造するため。
  console.log("発話区間を検出中...");
  const speech = detectSpeechSegments(pcmBuffer);
  const segments = sliceSegments(pcmBuffer, speech);
  const spokenSec = speech.reduce((a, s) => a + (s.endMs - s.startMs), 0) / 1000;
  console.log(
    `発話区間: ${segments.length}件 / ${spokenSec.toFixed(0)}秒` +
      `（全体の ${((spokenSec / durationSec) * 100).toFixed(0)}%）`
  );

  if (segments.length === 0) {
    console.error("発話区間が見つかりませんでした。");
    process.exit(1);
  }

  console.log("Whisper文字起こし中...");
  const allSegments = await transcribeSegments({
    openai,
    segments,
    prompt: buildTranscribePrompt(),
  });

  // ミックス済み音声なので話者分離はできない。
  // ただしタイムスタンプは議事録の骨組みになるので index.js と同じ形で残す（話者名だけ無い）。
  const transcript = allSegments
    .map((s) => `[${formatTimestamp(s.startMs)}] ${s.text}`)
    .join("\n");

  if (!transcript) {
    console.error("文字起こし結果が空です。");
    process.exit(1);
  }

  // 文字起こし保存
  fs.writeFileSync(transcriptPath, transcript);
  console.log(`文字起こし保存: ${transcriptPath}`);

  await generateAndPost(sessionDir, transcript, { replacePageId });
}

// --- 議事録の生成と投稿（文字起こしができた後の共通処理） ---
// 議事録の書き方は index.js（録音直後の本番経路）と同じ summarize.js に寄せている。
// ミックス音声からの文字起こしには話者名が無いので hasSpeakers: false で渡す。
async function generateAndPost(sessionDir, transcript, { replacePageId = null } = {}) {
  const sessionName = path.basename(sessionDir);

  console.log("議事録を生成中...");
  const { summary, usedTokens } = await summarizeTranscript(transcript, {
    sessionDate: sessionDateFromLabel(sessionName),
    hasSpeakers: false,
  });

  const minutesPath = path.join(sessionDir, `議事録_${sessionName}.md`);
  fs.writeFileSync(minutesPath, summary);
  console.log(`議事録保存: ${minutesPath}`);

  console.log("\n--- 議事録 ---\n");
  console.log(summary);

  // BlockNotion（TempestPhoenix）へ投稿。失敗してもローカルの議事録は残っているので致命的ではない。
  // --page 指定時は既存ページの中身を差し替える（ページ ID が変わらないので既存のリンクが生きる）。
  let minutesUrl = null;
  try {
    if (replacePageId) {
      console.log(`\nBlockNotion の既存ページを差し替え中: ${replacePageId}`);
      const result = await replaceMinutesPage({
        pageId: replacePageId,
        label: sessionName,
        summary,
        transcript,
      });
      console.log(`BlockNotion 差し替え成功: ${result.url}`);
    } else {
      console.log("\nBlockNotion へ投稿中...");
      const result = await postMinutesToBlockNotion({
        label: sessionName,
        summary,
        transcript,
      });
      minutesUrl = result.url;
      console.log(`BlockNotion 投稿成功: ${result.url}`);
    }
  } catch (err) {
    console.error("BlockNotion への反映に失敗（議事録ファイルは保存済み）:", err.name, "-", err.message);
  }

  // Discordへリンクを投稿。新規ページを作ったときだけで、
  // 差し替えのときは既に貼られているリンクが同じページを指すので投稿しない。
  if (minutesUrl) {
    try {
      await postMinutesLinkToDiscord({ sessionName, minutesUrl, usedTokens });
    } catch (err) {
      console.error("Discord投稿エラー:", err.message);
    }
  }
}

// このファイルが直接実行されたときだけ main() を走らせる。
// import しただけで Whisper 再文字起こしが走り、recordings/ の transcript.txt と議事録を
// 上書きしてしまうため（post-minutes.js と同じガード）。
if (process.argv[1]?.endsWith("generate-minutes.js")) {
  main().catch((err) => {
    console.error("エラー:", err);
    process.exit(1);
  });
}
