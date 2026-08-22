import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMinutesPostHeader,
  totalTokenUsage,
} from "./usage-metrics.js";

test("totalTokenUsage sums Claude token fields without double counting", () => {
  assert.equal(
    totalTokenUsage({
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40,
      total_tokens: 999,
    }),
    190
  );
});

test("buildMinutesPostHeader formats metrics on the same line", () => {
  assert.equal(
    buildMinutesPostHeader("2026-08-09", 1234, -0.19),
    "議事録 2026-08-09｜使用量: 1,234トークン｜残量: -$0.19"
  );
});
