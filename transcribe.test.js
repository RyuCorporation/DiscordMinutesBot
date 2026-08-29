import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildTranscribePrompt, mapToSourceMs, transcribeSegments } from "./transcribe.js";
import { SAMPLE_RATE } from "./audio.js";

function tempConfig(body) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dbot-")), "config.md");
  fs.writeFileSync(p, body);
  return p;
}

test("buildTranscribePrompt は config.md の語彙セクションを使う", () => {
  const p = tempConfig("# 議事録作成方針\n\n## 文字起こし語彙\nアルファ, ベータ\nガンマ\n\n## トーン\n丁寧に\n");
  assert.equal(buildTranscribePrompt(p), "アルファ, ベータ ガンマ");
});

test("buildTranscribePrompt は語彙セクションが無ければ既定値を返す", () => {
  const p = tempConfig("# 議事録作成方針\n\n## トーン\n丁寧に\n");
  const prompt = buildTranscribePrompt(p);
  assert.ok(prompt.includes("ゲーム開発"));
});

test("buildTranscribePrompt は config.md が無くても落ちない", () => {
  assert.ok(buildTranscribePrompt("./does-not-exist.md").length > 0);
});

test("mapToSourceMs は連結後の位置を元の位置に戻す", () => {
  const map = [
    { outStartMs: 200, outEndMs: 1200, srcStartMs: 5000 },
    { outStartMs: 1400, outEndMs: 2400, srcStartMs: 60000 },
  ];
  assert.equal(mapToSourceMs(map, 0.2), 5000);
  assert.equal(mapToSourceMs(map, 0.7), 5500);
  assert.equal(mapToSourceMs(map, 1.4), 60000);
  assert.equal(mapToSourceMs(map, 2.4), 61000);
});

test("mapToSourceMs は区間の隙間に落ちたら一番近い区間の頭に寄せる", () => {
  const map = [
    { outStartMs: 200, outEndMs: 1200, srcStartMs: 5000 },
    { outStartMs: 1400, outEndMs: 2400, srcStartMs: 60000 },
  ];
  assert.equal(mapToSourceMs(map, 1.35), 60000);
  assert.equal(mapToSourceMs(map, 0.0), 5000);
});

/** 48kHz stereo の適当な音（無音ではない）。 */
function noise(durationMs) {
  const frames = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(3000 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

test("transcribeSegments は区間の開始時刻を元音声の時刻に戻す", async () => {
  const calls = [];
  const fakeOpenai = {
    audio: {
      transcriptions: {
        create: async (params) => {
          calls.push(params);
          // 連結後 0.25s（= 継ぎ目パッド 200ms の直後）に出た発言のつもり
          return { segments: [{ start: 0.25, end: 0.5, text: " こんにちは " }] };
        },
      },
    },
  };

  const results = await transcribeSegments({
    openai: fakeOpenai,
    segments: [{ startMs: 123456, pcm: noise(1000) }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "whisper-1");
  assert.equal(calls[0].language, "ja");
  assert.deepEqual(results, [{ startMs: 123506, text: "こんにちは" }]);
});

test("transcribeSegments は定型の幻聴行を落とす", async () => {
  const fakeOpenai = {
    audio: {
      transcriptions: {
        create: async () => ({
          segments: [
            { start: 0.2, text: "ご視聴ありがとうございました" },
            { start: 0.4, text: "実際の発言です" },
            { start: 0.6, text: "チャンネル登録よろしくお願いします" },
          ],
        }),
      },
    },
  };
  const results = await transcribeSegments({
    openai: fakeOpenai,
    segments: [{ startMs: 0, pcm: noise(1000) }],
  });
  assert.deepEqual(results.map((r) => r.text), ["実際の発言です"]);
});

test("transcribeSegments は prompt を渡す（未指定なら渡さない）", async () => {
  const seen = [];
  const fakeOpenai = {
    audio: { transcriptions: { create: async (p) => (seen.push(p), { segments: [] }) } },
  };
  const segments = [{ startMs: 0, pcm: noise(500) }];
  await transcribeSegments({ openai: fakeOpenai, segments, prompt: "語彙" });
  await transcribeSegments({ openai: fakeOpenai, segments });
  assert.equal(seen[0].prompt, "語彙");
  assert.ok(!("prompt" in seen[1]));
});

test("transcribeSegments は空入力で API を呼ばない", async () => {
  let called = false;
  const fakeOpenai = {
    audio: { transcriptions: { create: async () => ((called = true), { segments: [] }) } },
  };
  assert.deepEqual(await transcribeSegments({ openai: fakeOpenai, segments: [] }), []);
  assert.equal(called, false);
});
