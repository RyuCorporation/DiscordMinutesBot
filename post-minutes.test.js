import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionDateFromLabel,
  dateKeyFromLabel,
  datePageTitleFromLabel,
  parseDatePageTitle,
  nextEntryTitles,
} from "./post-minutes.js";

test("sessionDateFromLabel converts a session label to a meeting date", () => {
  assert.equal(sessionDateFromLabel("2026-08-16"), "2026年8月16日");
});

test("sessionDateFromLabel handles same-day suffixes", () => {
  assert.equal(sessionDateFromLabel("2026-03-05_9"), "2026年3月5日");
});

test("sessionDateFromLabel returns null for labels without a date", () => {
  assert.equal(sessionDateFromLabel("adhoc"), null);
  assert.equal(sessionDateFromLabel(undefined), null);
});

test("dateKeyFromLabel drops the same-day suffix", () => {
  assert.equal(dateKeyFromLabel("2026-08-22"), "2026-08-22");
  assert.equal(dateKeyFromLabel("2026-08-22_3"), "2026-08-22");
});

test("datePageTitleFromLabel matches the hand-written page naming", () => {
  assert.equal(datePageTitleFromLabel("2026-08-22"), "議事録 2026-08-22");
  assert.equal(datePageTitleFromLabel("2026-08-22_3"), "議事録 2026-08-22");
});

test("parseDatePageTitle accepts hand-written date page titles", () => {
  assert.equal(parseDatePageTitle("議事録 2026-08-20"), "2026-08-20");
  assert.equal(parseDatePageTitle("2026-08-22"), "2026-08-22");
  assert.equal(parseDatePageTitle("2026/8/22"), "2026-08-22");
  assert.equal(parseDatePageTitle("議事録 2026年8月22日"), "2026-08-22");
  assert.equal(parseDatePageTitle(" 2026-08-22（土） "), "2026-08-22");
});

test("parseDatePageTitle rejects titles that are not a date page", () => {
  assert.equal(parseDatePageTitle("アジェンダ"), null);
  assert.equal(parseDatePageTitle("文字起こし 2026-08-22"), null);
  assert.equal(parseDatePageTitle("2026-08"), null);
});

test("nextEntryTitles numbers repeat meetings on the same day", () => {
  assert.deepEqual(nextEntryTitles(["アジェンダ"]), {
    minutes: "議事録",
    transcript: "文字起こし",
  });
  assert.deepEqual(nextEntryTitles(["アジェンダ", "議事録", "文字起こし"]), {
    minutes: "議事録 (2)",
    transcript: "文字起こし (2)",
  });
  assert.deepEqual(
    nextEntryTitles(["議事録", "文字起こし", "議事録 (2)", "文字起こし (2)"]),
    { minutes: "議事録 (3)", transcript: "文字起こし (3)" }
  );
});
