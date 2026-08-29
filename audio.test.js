import test from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE_RATE,
  BYTES_PER_MS,
  decimateToMono16k,
  detectSpeechSegments,
  sliceSegments,
  groupChunksIntoSegments,
} from "./audio.js";

/** 48kHz stereo 16bit の正弦波を作る。amplitude=0 なら無音。 */
function tone(durationMs, freqHz, amplitude = 8000) {
  const frames = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

function rms(monoBuffer) {
  const n = monoBuffer.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += monoBuffer.readInt16LE(i * 2) ** 2;
  return Math.sqrt(sum / n);
}

test("decimateToMono16k はサンプル数を 1/3 にする", () => {
  const pcm = tone(300, 440);
  const out = decimateToMono16k(pcm);
  assert.equal(out.length / 2, Math.floor(pcm.length / 4 / 3));
});

test("decimateToMono16k は 8kHz 以下をほぼそのまま通す", () => {
  const pcm = tone(300, 500, 8000);
  const out = decimateToMono16k(pcm);
  // 正弦波の RMS は振幅/√2
  assert.ok(rms(out) > 8000 / Math.SQRT2 * 0.9, `RMS=${rms(out)}`);
});

test("decimateToMono16k は 8kHz 超を落とす（エイリアス防止）", () => {
  // アンチエイリアスが無いと 12kHz は 4kHz へ折り返って振幅がそのまま残る
  const pcm = tone(300, 12000, 8000);
  const out = decimateToMono16k(pcm);
  assert.ok(rms(out) < 8000 * 0.05, `折り返しが残っている: RMS=${rms(out)}`);
});

test("detectSpeechSegments は無音に挟まれた発話を 1 区間として拾う", () => {
  const pcm = Buffer.concat([tone(1000, 440, 0), tone(1000, 440, 8000), tone(1000, 440, 0)]);
  const segs = detectSpeechSegments(pcm);
  assert.equal(segs.length, 1);
  // hangover(250ms) のぶん前後に広がる
  assert.ok(segs[0].startMs >= 700 && segs[0].startMs <= 1000, `start=${segs[0].startMs}`);
  assert.ok(segs[0].endMs >= 2000 && segs[0].endMs <= 2300, `end=${segs[0].endMs}`);
});

test("detectSpeechSegments は長い無音で区間を分ける", () => {
  const pcm = Buffer.concat([
    tone(600, 440, 8000),
    tone(3000, 440, 0),
    tone(600, 440, 8000),
  ]);
  assert.equal(detectSpeechSegments(pcm).length, 2);
});

test("detectSpeechSegments は全編無音なら何も返さない", () => {
  assert.deepEqual(detectSpeechSegments(tone(5000, 440, 0)), []);
});

test("sliceSegments は区間ぶんの PCM を切り出す", () => {
  const pcm = Buffer.concat([tone(1000, 440, 0), tone(1000, 440, 8000), tone(1000, 440, 0)]);
  const segs = detectSpeechSegments(pcm);
  const sliced = sliceSegments(pcm, segs);
  assert.equal(sliced.length, 1);
  assert.equal(sliced[0].startMs, segs[0].startMs);
  const expectedFrames = ((segs[0].endMs - segs[0].startMs) / 1000) * SAMPLE_RATE;
  assert.ok(Math.abs(sliced[0].pcm.length / 4 - expectedFrames) < 100);
});

test("groupChunksIntoSegments は連続したチャンクを 1 区間にまとめる", () => {
  const chunk = Buffer.alloc(20 * BYTES_PER_MS); // 20ms ぶん
  const chunks = [
    { timestamp: 0, chunk },
    { timestamp: 20, chunk },
    { timestamp: 40, chunk },
  ];
  const segs = groupChunksIntoSegments(chunks);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].startMs, 0);
  assert.equal(segs[0].pcm.length, chunk.length * 3);
});

test("groupChunksIntoSegments は時刻が飛んだところで区間を切る", () => {
  const chunk = Buffer.alloc(20 * BYTES_PER_MS);
  const segs = groupChunksIntoSegments([
    { timestamp: 0, chunk },
    { timestamp: 20, chunk },
    { timestamp: 5000, chunk },
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].pcm.length, chunk.length * 2);
  assert.equal(segs[1].startMs, 5000);
});

test("groupChunksIntoSegments は空入力で空を返す", () => {
  assert.deepEqual(groupChunksIntoSegments([]), []);
});
