// audio.js
// 録音した PCM を扱う共通処理（WAV 書き出し／16kHz mono 変換／発話区間の検出）。
// index.js（録音直後）と generate-minutes.js（録音済みWAVからのやり直し）で共有する。

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BIT_DEPTH = 16;
/** 48kHz stereo 16bit の 1ms あたりのバイト数（= 192） */
export const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)) / 1000;

export const TARGET_SAMPLE_RATE = 16000; // Whisper に渡すサンプリングレート

// ============================================================
// WAV ヘッダ
// ============================================================
function wavHeader({ sampleRate, channels, bitDepth, dataSize }) {
  const blockAlign = channels * (bitDepth / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

/** アーカイブ用の 48kHz stereo WAV を作る（ヘッダ + PCM）。 */
export function buildWavFile(pcmBuffer) {
  return Buffer.concat([
    wavHeader({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitDepth: BIT_DEPTH,
      dataSize: pcmBuffer.length,
    }),
    pcmBuffer,
  ]);
}

/** Whisper 用の 16kHz mono WAV を作る（ヘッダ + PCM）。 */
export function buildMonoWavFile(pcmMonoBuffer) {
  return Buffer.concat([
    wavHeader({
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      bitDepth: 16,
      dataSize: pcmMonoBuffer.length,
    }),
    pcmMonoBuffer,
  ]);
}

// ============================================================
// 48kHz stereo → 16kHz mono（アンチエイリアス付き）
// ============================================================
// 単純に 3 サンプルに 1 つ間引くと 8kHz 以上が 0〜8kHz へ折り返す。
// 実測ではこの折り返し成分が信号比 -24dB あり、本来の 6〜8kHz 帯（-29dB）より大きかった。
// 子音の識別を邪魔するので、間引く前に 8kHz のローパスを掛ける。
const LPF_TAPS = 63;
const LPF_CUTOFF_HZ = 7600;

const lpfTaps = (() => {
  const taps = new Float64Array(LPF_TAPS);
  const fc = LPF_CUTOFF_HZ / SAMPLE_RATE;
  const mid = (LPF_TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < LPF_TAPS; i++) {
    const n = i - mid;
    // 理想ローパスの sinc に Hamming 窓を掛ける（窓関数法）
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (LPF_TAPS - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < LPF_TAPS; i++) taps[i] /= sum; // DC ゲインを 1 に正規化
  return taps;
})();

/**
 * 48kHz stereo 16bit PCM を 16kHz mono 16bit PCM に変換する。
 * @param {Buffer} pcmBuffer
 * @returns {Buffer}
 */
export function decimateToMono16k(pcmBuffer) {
  const frames = Math.floor(pcmBuffer.length / 4);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    mono[i] = (pcmBuffer.readInt16LE(i * 4) + pcmBuffer.readInt16LE(i * 4 + 2)) / 2;
  }

  const mid = (LPF_TAPS - 1) >> 1;
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let o = 0; o < outFrames; o++) {
    const center = o * 3;
    let acc = 0;
    // 端はゼロ埋め扱い（前後 0.6ms 程度なので影響しない）
    const from = Math.max(0, mid - center);
    const to = Math.min(LPF_TAPS, frames - center + mid);
    for (let t = from; t < to; t++) acc += mono[center - mid + t] * lpfTaps[t];
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc))), o * 2);
  }
  return out;
}

// ============================================================
// 発話区間の検出（エネルギーベース VAD）
// ============================================================
/**
 * 48kHz stereo PCM から、実際に音が鳴っている区間を切り出す。
 *
 * 無音（サンプル値 0 の並び）をそのまま Whisper に渡すと、30 秒窓ごとに
 * 「ご視聴ありがとうございました」のような定型句を捏造する。実際に
 * recordings/2026-08-29 では冒頭 6 分ぶんが丸ごとその幻聴になっていた。
 * ここで無音を落としてから渡すのが、文字起こし精度への一番効く対策。
 *
 * @param {Buffer} pcmBuffer 48kHz stereo 16bit
 * @param {object} [options]
 * @returns {{ startMs: number, endMs: number }[]} 元音声上の区間（時系列順）
 */
export function detectSpeechSegments(pcmBuffer, options = {}) {
  const {
    frameMs = 20,
    thresholdRms = 180, // これ未満のフレームは無音扱い
    hangoverMs = 250,   // 発話の前後に残す余白（語頭・語尾を切らないため）
    mergeGapMs = 400,   // これ以下の間隔しか空いていない区間は繋いだままにする
    minSegMs = 300,     // これ未満の断片はノイズとみなして捨てる
  } = options;

  const framesPerBlock = (SAMPLE_RATE * frameMs) / 1000;
  const totalFrames = Math.floor(pcmBuffer.length / 4);
  const blockCount = Math.floor(totalFrames / framesPerBlock);

  const voiced = new Uint8Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    let sum = 0;
    const base = b * framesPerBlock;
    for (let i = 0; i < framesPerBlock; i++) {
      const off = (base + i) * 4;
      const m = (pcmBuffer.readInt16LE(off) + pcmBuffer.readInt16LE(off + 2)) / 2;
      sum += m * m;
    }
    voiced[b] = Math.sqrt(sum / framesPerBlock) >= thresholdRms ? 1 : 0;
  }

  // 前後に余白を付ける
  const hang = Math.ceil(hangoverMs / frameMs);
  const extended = new Uint8Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    if (!voiced[b]) continue;
    for (let k = Math.max(0, b - hang); k < Math.min(blockCount, b + hang + 1); k++) {
      extended[k] = 1;
    }
  }

  const raw = [];
  let b = 0;
  while (b < blockCount) {
    if (!extended[b]) {
      b++;
      continue;
    }
    let e = b;
    while (e < blockCount && extended[e]) e++;
    raw.push({ startMs: b * frameMs, endMs: e * frameMs });
    b = e;
  }

  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.startMs - last.endMs <= mergeGapMs) last.endMs = seg.endMs;
    else merged.push({ ...seg });
  }

  return merged.filter((s) => s.endMs - s.startMs >= minSegMs);
}

/** detectSpeechSegments の結果に沿って PCM を切り出す。 */
export function sliceSegments(pcmBuffer, segments) {
  return segments.map(({ startMs, endMs }) => {
    const from = Math.floor((startMs / 1000) * SAMPLE_RATE) * 4;
    const to = Math.min(pcmBuffer.length, Math.floor((endMs / 1000) * SAMPLE_RATE) * 4);
    return { startMs, pcm: pcmBuffer.subarray(from, to) };
  });
}

/**
 * 録音中に貯めたチャンク列を、連続している塊（＝ひとまとまりの発話）に分ける。
 *
 * index.js は発話ごとに subscribe するので、チャンクは基本的に隙間なく並ぶ。
 * パケットロスで時刻が飛んだところだけ区間を切る。無音を挟んで繋ぐより、
 * 区間に分けて Whisper へ渡したほうが幻聴が出ない。
 *
 * @param {{ timestamp: number, chunk: Buffer }[]} chunks 時系列順であること
 * @param {{ mergeGapMs?: number }} [options]
 * @returns {{ startMs: number, pcm: Buffer }[]}
 */
export function groupChunksIntoSegments(chunks, { mergeGapMs = 400 } = {}) {
  const segments = [];
  let parts = [];
  let startMs = 0;
  let expectedMs = 0;

  for (const { timestamp, chunk } of chunks) {
    if (parts.length === 0) {
      startMs = timestamp;
    } else if (timestamp - expectedMs > mergeGapMs) {
      segments.push({ startMs, pcm: Buffer.concat(parts) });
      parts = [];
      startMs = timestamp;
    }
    parts.push(chunk);
    expectedMs = timestamp + chunk.length / BYTES_PER_MS;
  }
  if (parts.length > 0) segments.push({ startMs, pcm: Buffer.concat(parts) });
  return segments;
}
