// transcribe.js
// 発話区間の PCM を Whisper に投げて「[開始ms] テキスト」の並びに変換する。
// index.js（話者ごと）と generate-minutes.js（ミックス音声）で共有する。
//
// 設計上の要点:
//  1. 無音は Whisper に渡さない。渡すと 30 秒窓ごとに定型句を捏造する。
//     発話区間だけを連結し、連結後の位置から元のタイムスタンプへ戻す。
//  2. 連結の継ぎ目には完全な無音ではなく極小ノイズを挟む。
//     0 が続くと「無音」と判定されて再び幻聴が出るため。
//  3. 分割は必ず発話区間の境界で行う。以前はバイト数で機械的に切っていたため
//     語の途中で切れていた。

import fs from "fs";
import { toFile } from "openai";
import {
  TARGET_SAMPLE_RATE,
  buildMonoWavFile,
  decimateToMono16k,
} from "./audio.js";

/** 16kHz mono 16bit の 1ms あたりのバイト数（= 32） */
const MONO_BYTES_PER_MS = (TARGET_SAMPLE_RATE * 2) / 1000;

/** 1 リクエストに詰め込む上限。Whisper の上限は 25MB なので余裕を見て 20MB。 */
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
/** 単独で長すぎる区間はここで割る（画面共有中の長い独話など）。 */
const MAX_SEGMENT_MS = 10 * 60 * 1000;
/** 連結の継ぎ目に挟む長さ。 */
const JOIN_PAD_MS = 200;

/**
 * Whisper の prompt に渡す語彙ヒント。
 * config.md に「## 文字起こし語彙」セクションがあればその中身を使う（実名や
 * プロジェクト固有語は公開リポジトリに置けないため）。無ければ汎用の既定値。
 *
 * Whisper の prompt は 224 トークンで打ち切られる。日本語だと 150 文字程度が目安。
 */
const DEFAULT_PROMPT =
  "ゲーム開発の定例ミーティングの音声です。" +
  "Unity, C#, プレハブ, インスペクタ, エディタ拡張, アセット, スポーン, エネミー, " +
  "ギミック, レベルデザイン, ステージ, リポジトリ, プルリクエスト, マージ, " +
  "タスク, スプリント, アジェンダ といった用語が出てきます。";

export function buildTranscribePrompt(configPath = "./config.md") {
  let config = "";
  try {
    config = fs.readFileSync(configPath, "utf-8");
  } catch {
    return DEFAULT_PROMPT;
  }
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s*文字起こし語彙/.test(l));
  if (start === -1) return DEFAULT_PROMPT;

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break; // 次の見出しで終わり
    if (line.trim()) body.push(line.trim());
  }
  const text = body.join(" ").trim();
  return text || DEFAULT_PROMPT;
}

/** 継ぎ目用の極小ノイズ（完全な無音だと幻聴を誘発する）。 */
function joinPad() {
  const samples = (TARGET_SAMPLE_RATE * JOIN_PAD_MS) / 1000;
  const pad = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pad.writeInt16LE(((Math.random() * 6) | 0) - 3, i * 2);
  return pad;
}

/**
 * 発話区間を 1 リクエストぶんずつまとめる。
 * @param {{ startMs: number, mono: Buffer }[]} segments
 * @returns {{ pcm: Buffer, map: { outStartMs: number, outEndMs: number, srcStartMs: number }[] }[]}
 */
function packBatches(segments) {
  const batches = [];
  let parts = [];
  let map = [];
  let bytes = 0;
  let outMs = 0;

  const flush = () => {
    if (!map.length) return;
    batches.push({ pcm: Buffer.concat(parts), map });
    parts = [];
    map = [];
    bytes = 0;
    outMs = 0;
  };

  for (const seg of segments) {
    // 長すぎる区間は先に割っておく
    const pieces = [];
    const maxBytes = MAX_SEGMENT_MS * MONO_BYTES_PER_MS;
    for (let off = 0; off < seg.mono.length; off += maxBytes) {
      pieces.push({
        startMs: seg.startMs + off / MONO_BYTES_PER_MS,
        mono: seg.mono.subarray(off, Math.min(off + maxBytes, seg.mono.length)),
      });
    }

    for (const piece of pieces) {
      const pad = joinPad();
      if (bytes + pad.length + piece.mono.length > MAX_BATCH_BYTES) flush();
      parts.push(pad, piece.mono);
      bytes += pad.length + piece.mono.length;
      outMs += JOIN_PAD_MS;
      const durMs = piece.mono.length / MONO_BYTES_PER_MS;
      map.push({ outStartMs: outMs, outEndMs: outMs + durMs, srcStartMs: piece.startMs });
      outMs += durMs;
    }
  }
  flush();
  return batches;
}

/**
 * 連結後の位置（秒）を元音声の位置（ms）に戻す。
 * Whisper のセグメント境界はこちらの区切りと一致しないので、
 * 収まる区間が無ければ一番近い区間の頭に寄せる。
 */
export function mapToSourceMs(map, outSec) {
  const outMs = outSec * 1000;
  for (const m of map) {
    if (outMs >= m.outStartMs && outMs <= m.outEndMs) {
      return m.srcStartMs + (outMs - m.outStartMs);
    }
  }
  let best = null;
  let bestDist = Infinity;
  for (const m of map) {
    const d = Math.min(Math.abs(outMs - m.outStartMs), Math.abs(outMs - m.outEndMs));
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best ? best.srcStartMs : Math.round(outMs);
}

// 無音除去で出なくなるはずだが、念のための保険。
// 会議で自然に出うる「ありがとうございました」等は入れない。
const HALLUCINATION_PATTERNS = [
  /^ご視聴ありがとうございました[。!！]?$/,
  /^ご清聴ありがとうございました[。!！]?$/,
  /^チャンネル登録.*お願い/,
  /^字幕(を|は)?ご覧/,
  /^本日はご覧いただきありがとうございます[。!！]?$/,
  /^音声なしでご覧ください[。!！]?$/,
  /^おだしょー\s*$/,
];

function isHallucination(text) {
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

async function callWhisper(openai, wav, { prompt, attempt = 0 }) {
  try {
    return await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: await toFile(wav, "audio.wav", { type: "audio/wav" }),
      language: "ja",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
      ...(prompt ? { prompt } : {}),
    });
  } catch (err) {
    if (attempt >= 2) throw err;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return callWhisper(openai, wav, { prompt, attempt: attempt + 1 });
  }
}

/**
 * 発話区間を文字起こしする。
 * @param {object} params
 * @param {import("openai").default} params.openai
 * @param {{ startMs: number, pcm: Buffer }[]} params.segments 48kHz stereo PCM の区間
 * @param {string} [params.prompt] 語彙ヒント
 * @param {string} [params.label] ログ用の表示名（話者名など）
 * @returns {Promise<{ startMs: number, text: string }[]>} 時系列順
 */
export async function transcribeSegments({ openai, segments, prompt, label = "" }) {
  const mono = segments
    .map(({ startMs, pcm }) => ({ startMs, mono: decimateToMono16k(pcm) }))
    .filter((s) => s.mono.length > 0);
  if (mono.length === 0) return [];

  const batches = packBatches(mono);
  const results = [];
  let dropped = 0;

  for (let i = 0; i < batches.length; i++) {
    const { pcm, map } = batches[i];
    try {
      const res = await callWhisper(openai, buildMonoWavFile(pcm), { prompt });
      for (const seg of res.segments || []) {
        const text = seg.text.trim();
        if (!text) continue;
        if (isHallucination(text)) {
          dropped++;
          continue;
        }
        results.push({ startMs: Math.round(mapToSourceMs(map, seg.start)), text });
      }
    } catch (err) {
      console.error(`Whisper error (${label || "mixed"} batch ${i}):`, err.message);
    }
  }

  if (dropped > 0) {
    console.log(`  ${label || "mixed"}: 幻聴とみなした行を ${dropped} 件除外しました。`);
  }
  results.sort((a, b) => a.startMs - b.startMs);
  return results;
}
