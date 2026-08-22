import assert from "node:assert/strict";
import test from "node:test";
import { formatUsd, parseCreditBalance } from "./billing-balance.js";

test("parseCreditBalance reads a positive API credit balance", () => {
  assert.equal(
    parseCreditBalance("Pay as you go\nAPI credit balance\n$12.34\nAuto-reload credits"),
    12.34
  );
});

test("parseCreditBalance reads a negative API credit balance", () => {
  assert.equal(parseCreditBalance("API credit balance\n-$0.19"), -0.19);
});

test("formatUsd formats balances for Discord", () => {
  assert.equal(formatUsd(-0.19), "-$0.19");
  assert.equal(formatUsd(null), "取得不可");
});
