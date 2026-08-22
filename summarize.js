// summarize.js
// Claude CLI (claude -p) をヘッドレス起動してタイムスタンプ形式の議事録を生成する。
// index.js（録音直後の本番経路）と generate-minutes.js（録音済みWAVからのやり直し）で
// 同じ書き方の議事録になるよう、プロンプトごとここに集約している。
//
// 出力方針: 勝手に要約して圧縮せず、原文の流れを残す。
//   話が変わるところでセクションに切り、各セクションに
//   見出し + 開始タイムスタンプ + 要約 + 実際の会話（話者: 発言）を並べる。
//
// ※ system prompt は --append-system-prompt で渡し、文字起こし本文は stdin から流し込む
//   （長文でもコマンドライン長制限に当たらない）

import fs from "fs";
import { spawn } from "child_process";
import { totalTokenUsage } from "./usage-metrics.js";

/**
 * ミリ秒を [HH:MM:SS] / [MM:SS] 形式に変換する。文字起こしの行頭に付けるタイムスタンプ。
 * @param {number} ms
 * @returns {string}
 */
export function formatTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 文字起こしから議事録（Markdown）を生成する。
 * @param {string} transcript 文字起こし本文。各行は「[タイムスタンプ] 話者: 発言」
 *   （hasSpeakers=false のときは「[タイムスタンプ] 発言」）。
 * @param {{ sessionDate?: string|null, hasSpeakers?: boolean }} [options]
 *   sessionDate: 会議の開催日（"2026年8月16日"）。文字起こしに日付が無いため外から渡す。
 *   hasSpeakers: 文字起こしに話者名が付いているか。ミックス音声からの文字起こしは false。
 * @returns {Promise<{ summary: string, usedTokens: number|null }>}
 */
export function summarizeTranscript(transcript, options = {}) {
  const { sessionDate = null, hasSpeakers = true } = options;

  let configPrompt = "";
  try {
    configPrompt = fs.readFileSync("./config.md", "utf-8");
  } catch {
    console.warn("config.md が見つかりません。デフォルトの方針で生成します。");
  }

  // 話者名が無い文字起こし（ミックス音声）では、話者の推測はさせない。
  // 誤った発言の帰属が残るより、話者なしで発言を並べたほうが読み手にとって安全。
  const lineFormat = hasSpeakers
    ? "各行が「[タイムスタンプ] 話者: 発言」形式"
    : "各行が「[タイムスタンプ] 発言」形式（ミックス音声からの文字起こしのため話者名は付いていない）";

  const utteranceRule = hasSpeakers
    ? `  - 話者名: 発言内容
  - 話者名: 発言内容
  （実際の会話を時系列でそのまま列挙。話者名と発言は文字起こしのものを使う）`
    : `  - 発言内容
  - 発言内容
  （実際の会話を時系列でそのまま列挙。発言は文字起こしのものを使う）
  ※ 文字起こしに話者名が無いため、話者は推測せず書かない。発言者名を勝手に補わないこと。`;

  const systemPrompt = `あなたは会議の議事録作成者です。タイムスタンプ付きの文字起こし（${lineFormat}）を受け取り、以下のルールでMarkdownの議事録を作成してください。

# 出力ルール
- 話題が大まかに変わったと思われるところでセクションを区切る（厳密な時間ではなく内容の切れ目で判断）。
- 各セクションは次の構成にする:
  ## [そのセクションの開始タイムスタンプ] セクションの見出し（話題を端的に表す）
  **要約:** そのセクションで話された内容を2〜3文で簡潔にまとめる。
  （空行）
${utteranceRule}
- タイムスタンプは文字起こしに含まれるものをそのまま使う。
- 発言は要約せず、文字起こしの内容を保ったまま列挙する（読みやすさのため明らかな言い間違いや冗長な相槌の整理は可）。
- 会議全体を短くまとめ直した「概要だけの議事録」にはしない。原文の流れを残すことを優先する。
- 雑談だけのセクションは見出しに「雑談」と付けてよい。
- 前置きや「議事録を作成しました」等の説明は一切書かず、議事録本文（Markdown）のみを出力する。${configPrompt ? `\n\n# 追加方針（config.md）\n${configPrompt}` : ""}`;

  // 文字起こしには日付が含まれないので、会議日をこちらから渡す。
  // 渡さないとモデルが日付欄を「2023年X月X日」等のプレースホルダで埋めてしまう。
  const userPrompt =
    "以下はタイムスタンプ付きの会議の文字起こしです。ルールに従ってタイムスタンプ形式の議事録を作成してください。\n" +
    (sessionDate
      ? `この会議の開催日は ${sessionDate} です。日付を書く欄があればこの日付を使い、推測や仮の日付は書かないでください。\n`
      : "") +
    "\n" +
    transcript;

  return new Promise((resolve, reject) => {
    // Windowsでは claude が claude.cmd (バッチ) のため shell 経由で起動する
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", "--append-system-prompt", systemPrompt],
      { shell: true }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Claude CLIの起動に失敗しました: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Claude CLIが異常終了しました (code ${code}): ${stderr.trim()}`)
        );
        return;
      }
      const rawResult = stdout.trim();
      if (!rawResult) {
        reject(new Error(`Claude CLIの出力が空です。stderr: ${stderr.trim()}`));
        return;
      }

      let result;
      try {
        result = JSON.parse(rawResult);
      } catch {
        reject(new Error("Claude CLIのJSON出力を解析できませんでした。"));
        return;
      }

      const summary = result.result?.trim();
      if (!summary) {
        reject(new Error("Claude CLIの議事録本文が空です。"));
        return;
      }

      resolve({
        summary,
        usedTokens: totalTokenUsage(result.usage),
      });
    });

    // 文字起こし本文を stdin から渡して閉じる
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}
