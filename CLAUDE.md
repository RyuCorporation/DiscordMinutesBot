# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

このプロジェクトは AIHomeServer（自宅の管理コンソール／オーケストレーター）の管理下にある。
以下「共通規約」は AIHomeServer 配下の各プロジェクトで共通のルール。

---

# 共通規約（AIHomeServer 配下の全プロジェクト共通）

## 言語設定

このリポジトリでは、Claude Code への指示・回答はすべて**日本語**で行うこと。

Think in English, interact with the user in Japanese.

## ツール実行時の制約（マルチバイト・ストリーミング対策）

ツール呼び出しの引数に日本語などのマルチバイト文字を多く含めると、出力ストリームのタグが壊れて呼び出しが失敗することがある（`malformed` エラー／タグ破損）。以下を徹底する。

- **ツール呼び出しの直前に日本語の長文を書かない。** 説明は実行の前後にまとめ、呼び出し自体は素直に発行する。
- **Bash のコマンド・引数は ASCII を基本にする。** コミットメッセージや PR タイトル／本文に日本語を直書きしない（`git commit -m "日本語"`、`gh pr create --title "日本語"` は避ける）。コミットは ASCII の英語メッセージにするか、`git commit -F <file>`／PR は `--body-file <file>` でファイル経由にする（コマンド側は ASCII のまま）。
- **コミットメッセージ・PR 文面は英語で書いてよい**（本バグ回避のため。リポジトリ内のドキュメント本文は日本語のまま）。
- **日本語の本文は Write/Edit でファイルに直接書く。** Bash の引数経由で渡さない。
- **`malformed` が出たら同じ呼び出しを retry する**（断続的な現象で、再送で通ることが多い）。

## バージョン管理（GitFlow）

このリポジトリは **GitFlow** ブランチモデルで管理する（git-flow拡張は使わず標準gitコマンドで運用）。
**本リポジトリの本番ブランチは `master`**（GitFlow 一般の `main` にあたる）、`develop`＝開発統合の起点。
機能開発は `develop` から `feature/*` を切って進め、**Squash マージ**で取り込む。
具体的なコマンド手順は [docs/gitflow.md](docs/gitflow.md) を参照すること。
**`master` や `develop` へ直接コミットせず、必ずブランチを切ること。**

**作業を終えたら PR ベースで取り込む（必須フロー）:** 一区切りついたら、ローカルで直接マージせず **コミット → `feature/*` を `origin` に Push → PR を作成（`feature/* → develop`）→ マージ** までを完了させる。マージは **Squash マージ**（feature の全コミットを1つにまとめる。`gh pr merge --squash`／GitHub なら "Squash and merge"）を用い、マージ後は feature ブランチを削除する。PR 作成・マージは `gh` CLI で行ってよい。

**作業はスタック式（直列・1本ずつ）で進める:** 複数のエージェント／セッションを同時並行で走らせない。
つねに「いま着手中の1作業」を完了またはハンドオフしてから次に着手する。
後入れ先出しのスタックのように、**1本を積んで降ろしてから次を積む**。

## ブラウザでの動作確認（claude-in-chrome）

`claude-in-chrome` は会話（セッション）ごとに新しい Chrome ウィンドウ／タブを開きます。
このオーケストレーターは複数プロジェクトを並行管理するため、開いたままにするとウィンドウが
どんどん増えていきます。**動作確認が終わったら、そのために開いたタブ／ウィンドウは必ず
閉じてください**（`tabs_close_mcp` 等）。依頼者が明示的に見たい・開いたままにしてほしいと
言った場合を除きます。

## 管理コンソールへのサービス・アイコン登録

このプロジェクトが Web サービス等を起動していて、管理コンソールのダッシュボード／
「サービス」一覧からリンクを出したい場合は、`.orchestrator/links.json` に以下の形式で
追記してください（無ければ新規作成してよい）。

```json
{
  "schemaVersion": 1,
  "services": [
    { "label": "Web UI", "url": "http://localhost:5173" }
  ]
}
```

サービスが無くなった・URLが変わったら、このファイルを更新してください。管理コンソールは
毎回このファイルを読み直すので、削除すればリンクも消えます。壊れた形式のエントリは
無視されるだけで一覧全体には影響しません。

## 管理コンソールから起動できるプロセスの登録

このプロジェクトの開発サーバー等を管理コンソールの「コンソール」タブから起動・停止し、
ブラウザ内のターミナルで操作したい場合は、`.orchestrator/consoles.json` に以下の形式で
定義してください。

```json
{
  "schemaVersion": 1,
  "consoles": [
    { "id": "dev", "label": "開発サーバー", "command": "npm run dev" }
  ]
}
```

`id` はこのプロジェクト内で一意な文字列。`claude` は予約語（Claude セッション用の
コンソールが常に自動で並ぶ）なので使えません。`command` はプロジェクトフォルダを
作業ディレクトリとして実行されます。

さらに、上の `links.json` のサービスに同じ `id` を `consoleId` として書いておくと、
「サービス」一覧からそのサービスUIを直接 起動／停止／再起動 できるようになります
（書かなければ従来どおりリンクだけの行になります）。

```json
{ "label": "Web UI", "url": "http://localhost:5173", "consoleId": "dev" }
```

プロジェクト一覧・詳細画面に表示するアイコン画像を用意したい場合は、`icon/` フォルダに
画像ファイル（PNG/JPG/SVG 等）を1つ置いてください。

`.orchestrator/project.json` は管理コンソールが管理する識別情報（ID・表示名・作成日時等）
なので、このプロジェクトから直接編集しないでください。

---

# このプロジェクト固有

## Project Overview

Discord voice channel recorder bot. Monitors a target voice channel, automatically joins when a user enters, records each user's audio as separate WAV files, and disconnects when all humans leave.
Minutes are generated from the recording and recorded in TempestPhoenix's BlockNotion.

## Commands

- `npm start` — Run the bot (`node index.js`)
- `npm install` — Install dependencies
- `npm test` — Run the unit tests (`node --test`)
- `node generate-minutes.js recordings/<session> [--force-transcribe] [--page blk_xxx]` —
  regenerate minutes from a recorded session. Existing `transcript.txt` is reused unless
  `--force-transcribe` is given (Whisper is billed per run); `--page` replaces an existing
  BlockNotion page instead of creating a new one.

No build step or linter is configured.

## Architecture

Node.js application using ES modules (`"type": "module"`). Recording lives in `index.js`;
audio handling in `audio.js`, Whisper calls in `transcribe.js`, and the BlockNotion
integration in `post-minutes.js` + `blocknotion/`.

### Core Flow

1. Bot authenticates via `DISCORD_TOKEN` from `.env`
2. Listens for `voiceStateUpdate` events targeting `TARGET_VOICE_CHANNEL_ID`
3. When a user joins the target channel: bot joins, subscribes to each user's Opus audio stream via `@discordjs/voice` receiver
4. Opus → PCM decoding via `prism-media` (48kHz, stereo, 16-bit)
5. PCM chunks accumulate in `userBuffers` Map (keyed by userId) across speech segments
6. When all humans leave: `saveAndDisconnect()` writes WAV files to `recordings/{username}/{timestamp}.wav` and disconnects
7. Transcribe (Whisper) → summarize (`claude -p`) → post to BlockNotion → post the page URL to Discord

### Transcription accuracy — three things that must not regress

Measured on real recordings; each was worth a large chunk of the transcript.

- **Never send silence to Whisper.** It fabricates one boilerplate line
  ("ご視聴ありがとうございました" etc.) per 30-second window of silence. In
  `recordings/2026-08-29` that was 34 of 98 lines; in `2026-08-22`, ~46%. Both paths now
  transcribe speech segments only — `groupChunksIntoSegments()` for the per-speaker path
  (chunk timing already tells us where speech is) and `detectSpeechSegments()` (energy VAD)
  for the mixed-audio path. Timestamps are mapped back via `mapToSourceMs()`.
- **Chunk timestamps must advance by sample count, not by `Date.now()`.** Placing each 20ms
  PCM chunk at its wall-clock arrival time turned jitter into holes: 10.3 dropouts/sec during
  speech, 4.75% of speech time lost as digital silence. `Date.now()` is now only read at the
  start of a speech segment; `PACKET_LOSS_RESYNC_MS` re-syncs when real loss (>200ms) occurs.
- **Downsample through a low-pass filter.** Plain 3:1 decimation folds >8kHz back into the
  band at -24dB — louder than the real 6–8kHz consonant energy. `decimateToMono16k()` applies
  a 7.6kHz FIR first. Note: the filter *alone* made whisper-1 emit fabricated speaker labels
  ("おだしょー") on 119 of 167 lines in one A/B run; it only tested clean combined with
  silence removal and the vocabulary prompt. Keep the three together.

Whisper also gets a vocabulary `prompt` (`buildTranscribePrompt()`), taken from a
`## 文字起こし語彙` section in `config.md` if present. This is what fixes ギミック→リミック
class errors. Whisper truncates the prompt at 224 tokens (~150 Japanese characters).

### Key State

- `connection` — current voice connection (null when idle)
- `activeStreams` Set — prevents duplicate subscriptions to the same user
- `userBuffers` Map — userId → PCM chunk array, persists across speech segments within a session

### Minutes destination — TempestPhoenix BlockNotion

Minutes and transcripts are recorded in TempestPhoenix's BlockNotion, and only the resulting page URL
is posted to Discord (in a thread under a `議事録 <session>` message).

- `post-minutes.js` — finds (or creates) the day page `議事録 <YYYY-MM-DD>` under the "議事録" page
  (`TP_MINUTES_PARENT_ID`), then creates `議事録` and `文字起こし` inside it. A second meeting on the
  same day appends `議事録 (2)` / `文字起こし (2)`. Day pages are often created by hand, so
  `parseDatePageTitle()` tolerates `2026-08-22` / `2026/8/22` / `2026年8月22日` / `（土）` suffixes.
  `replaceMinutesPage()` swaps the content of an existing page in place, keeping its URL.
- `summarize.js` — the `claude -p` prompt shared by `index.js` and `generate-minutes.js`.
  Minutes keep the flow of the original conversation (timestamped sections + utterances listed
  verbatim); they are not compressed into a summary-only document. Pass `hasSpeakers: false` for
  transcripts made from the mixed `recording.wav`, where speakers cannot be recovered.
- `blocknotion/client.js` — agent API key → short-lived JWT (`POST /api/admin/auth/agent-token`),
  then `POST /api/blocks/` (trailing slash required), `POST /api/blocks/batch`,
  and `GET`/`DELETE /api/blocks/{id}` for in-place edits
- `blocknotion/markdown-to-blocks.js` — BlockNotion cannot store Markdown; the minutes Markdown is
  converted to blocks + styled-spans. The rules are a port of TempestPhoenix's `src/Importer`
  (`MarkdownToBlocks.cs` / `InlineMarkdown.cs`) so new pages match the migrated ones. Keep them in sync.

### Configuration

- `.env` — `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `OPENAI_API_KEY`(省略可), `MINUTES_CHANNEL_ID`(省略可),
  `TP_API_BASE`, `TP_AGENT_API_KEY`, `TP_MINUTES_PARENT_ID`, `TP_SITE_BASE`(省略可)

## Restrictions

- **NEVER read, open, or access the `.env` file.** It contains secrets and must not be viewed.
- This repository is **public**. Do not commit member real names, invite URLs, BlockNotion page IDs,
  or anything else identifying the private workspace — keep them in `.env` / `config.md` (both gitignored).

## Notes

- Comments in the source are in Japanese
- Audio uses `EndBehaviorType.AfterSilence` with 1-second timeout to detect speech end
- WAV headers are manually constructed (44-byte RIFF/WAVE header)
- Recordings combine all speech segments per user into a single file per session

## AIモデル役割分担（ローカルQwen併用）

このプロジェクトは「**考える＝Claude / Codex（Cloud）／作る＝ローカルQwen／検証する＝Test＋Cloud Review＋人間**」の役割分担で進める。運用ルール・モデル切替コマンド・エスカレーション基準は [docs/ai-workflow.md](docs/ai-workflow.md) を参照。実装タスクの Plan は Cloud 側が `docs/tasks/<タスク名>.md`（[_template.md](docs/tasks/_template.md) を複製）に書いて Qwen へ受け渡す。Qwen はタスク完了時に Implementation Result（同文書のフォーマット）で報告する。
