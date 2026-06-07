// generate-minutes.js
// 既存の recording.wav から議事録を生成するスタンドアロンスクリプト
// Usage: node generate-minutes.js [recordings/2026-03-14]

import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- WAV関連ヘルパー（index.jsと同じ） ---
function writeMonoWavFile(filePath, pcmMonoBuffer) {
  const sampleRate = 16000;
  const channels = 1;
  const bitDepth = 16;
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmMonoBuffer.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmMonoBuffer]));
}

function downsampleToMono(pcmBuffer) {
  const bytesPerSampleIn = 2 * 2; // stereo, 16-bit
  const ratio = 3; // 48000 / 16000
  const totalFrames = Math.floor(pcmBuffer.length / bytesPerSampleIn);
  const outFrames = Math.floor(totalFrames / ratio);
  const outBuffer = Buffer.alloc(outFrames * 2); // mono 16-bit

  for (let i = 0; i < outFrames; i++) {
    const srcIndex = i * ratio * bytesPerSampleIn;
    const left = pcmBuffer.readInt16LE(srcIndex);
    const right = pcmBuffer.readInt16LE(srcIndex + 2);
    const mono = Math.round((left + right) / 2);
    outBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * 2);
  }
  return outBuffer;
}

function splitBuffer(buffer, maxBytes = 24 * 1024 * 1024) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += maxBytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + maxBytes, buffer.length)));
  }
  return chunks;
}

// --- メイン処理 ---
async function main() {
  const sessionDir = process.argv[2] || "./recordings/2026-03-14";
  const wavPath = path.join(sessionDir, "recording.wav");

  if (!fs.existsSync(wavPath)) {
    console.error(`ファイルが見つかりません: ${wavPath}`);
    process.exit(1);
  }

  console.log(`音声ファイル読み込み: ${wavPath}`);
  const wavData = fs.readFileSync(wavPath);
  // WAVヘッダー（44バイト）をスキップしてPCMデータを取得
  const pcmBuffer = wavData.subarray(44);

  const durationSec = (pcmBuffer.length / (48000 * 2 * 2)).toFixed(1);
  console.log(`音声長: ${durationSec}秒`);

  // 48kHz stereo → 16kHz mono ダウンサンプル
  console.log("ダウンサンプル中...");
  const monoBuffer = downsampleToMono(pcmBuffer);

  // 24MBチャンクに分割
  const audioChunks = splitBuffer(monoBuffer);
  console.log(`チャンク数: ${audioChunks.length}`);

  // Whisperで文字起こし
  console.log("Whisper文字起こし中...");
  const allSegments = [];

  for (let i = 0; i < audioChunks.length; i++) {
    const tempPath = path.join(sessionDir, `temp_chunk_${i}.wav`);
    writeMonoWavFile(tempPath, audioChunks[i]);

    try {
      console.log(`  チャンク ${i + 1}/${audioChunks.length} を処理中...`);
      const file = fs.createReadStream(tempPath);
      const response = await openai.audio.transcriptions.create({
        model: "whisper-1",
        file,
        language: "ja",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });

      const chunkOffsetSec = (i * 24 * 1024 * 1024) / (16000 * 2);
      for (const seg of response.segments || []) {
        const text = seg.text.trim();
        if (!text) continue;
        allSegments.push({
          startSec: seg.start + chunkOffsetSec,
          text,
        });
      }
    } catch (err) {
      console.error(`Whisperエラー (チャンク ${i}):`, err.message);
    }

    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }

  // タイムスタンプでソート
  allSegments.sort((a, b) => a.startSec - b.startSec);

  // ミックス済み音声なので話者分離なし
  const transcript = allSegments.map((s) => s.text).join("\n");

  if (!transcript) {
    console.error("文字起こし結果が空です。");
    process.exit(1);
  }

  // 文字起こし保存
  const transcriptPath = path.join(sessionDir, "transcript.txt");
  fs.writeFileSync(transcriptPath, transcript);
  console.log(`文字起こし保存: ${transcriptPath}`);

  // ChatGPTで議事録生成
  console.log("議事録を生成中...");
  let systemPrompt = "議事録を作成してください。";
  try {
    systemPrompt = fs.readFileSync("./config.md", "utf-8");
  } catch {
    console.warn("config.md が見つかりません。デフォルトのプロンプトを使用します。");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `以下は会議の文字起こしです。議事録を作成してください。\n（注意: ミックス音声からの文字起こしのため、話者の分離はされていません。文脈から発言者を推測してください。）\n\n${transcript}`,
      },
    ],
  });

  const summary = response.choices[0].message.content;
  const sessionName = path.basename(sessionDir);
  const minutesPath = path.join(sessionDir, `議事録_${sessionName}.md`);
  fs.writeFileSync(minutesPath, summary);
  console.log(`議事録保存: ${minutesPath}`);

  console.log("\n--- 議事録 ---\n");
  console.log(summary);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
