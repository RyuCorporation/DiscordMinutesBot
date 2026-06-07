# Discord 議事録作成 Bot 仕様書

## 1. システム概要

Discordのボイスチャンネルに参加し、ユーザーごとの音声を録音、Whisper APIによる文字起こし、Claude CLIによる議事録作成を自動で行うBot。

- 言語 / ランタイム: Node.js v18以上（ES Modules）
- 主要ライブラリ: discord.js v14 / @discordjs/voice / prism-media / openai
- 要約: Claude Code CLI（`claude -p`）をヘッドレス起動して生成

## 2. ディレクトリ構成と起動

```
index.js                # Bot本体（録音・文字起こし・議事録生成・投稿）
deploy-commands.js      # スラッシュコマンド（/join, /leave）の登録
generate-minutes.js     # 既存 recording.wav から議事録を再生成するスタンドアロン
run_bot.bat             # Windows用起動スクリプト（npm start を実行）
config.md               # 議事録生成の追加方針（任意・gitignore対象）
.env                    # 各種シークレット（gitignore対象）
recordings/             # セッションごとの録音・文字起こし・議事録（gitignore対象）
```

### 起動

- `run_bot.bat` をダブルクリック、または `npm start`（= `node index.js`）
- コマンド登録は `npm run deploy-commands`（= `node deploy-commands.js`）

### 設定ファイル

- `.env` : `DISCORD_TOKEN` / `CLIENT_ID` / `GUILD_ID` / `OPENAI_API_KEY`（省略可）/ `MINUTES_CHANNEL_ID`（省略可）
- `config.md` : 議事録生成時のシステムプロンプトに「追加方針」として連結（実行時に読み込み、未作成可）

## 3. 機能詳細

### A. インタラクション（コマンド・参加・離脱）

- `/join` コマンド
  - 実行者が参加中のVC、または `channel` オプションで指定したVCにBotを参加させる
  - 参加と同時に録音を開始
  - 議事録投稿先は `MINUTES_CHANNEL_ID` を優先し、未設定なら `/join` 実行チャンネル
- `/leave` コマンド
  - Botを手動でVCから退出させ、議事録作成処理を開始
- 自動離脱機能
  - VC内のBot以外のユーザー数を監視し、0人になった瞬間に自動離脱
  - 離脱をトリガーに音声データ処理を開始

### B. 録音

- `receiver.speaking` の `start` を契機に、ユーザーごとのOpusストリームを購読
- `EndBehaviorType.AfterSilence`（1秒）で発話終了を検知
- prism-media で Opus → PCM デコード（48kHz / stereo / 16bit）
- PCMチャンクをセッション開始からの相対タイムスタンプ付きでユーザー別に蓄積
- 保存時に全ユーザーをタイムスタンプ基準でミックスし、単一の `recording.wav`（48kHz stereo）として書き出し（WAVヘッダは手動構築）

### C. 文字起こし（Whisper API・OPENAI_API_KEY 設定時）

- ユーザーごとにタイムライン音声を再構築し、48kHz stereo → 16kHz mono にダウンサンプル
- 24MBごとにチャンク分割して Whisper（`whisper-1`, `verbose_json`, segment タイムスタンプ）へ送信
- 全ユーザーのセグメントを時系列にソートし、`[MM:SS] 話者名: 発言` 形式に統合
- 結果を `transcript.txt` として保存

### D. 議事録生成（Claude CLI・OPENAI_API_KEY 設定時）

- `claude -p --append-system-prompt <方針>` をヘッドレス起動し、文字起こし本文を stdin から渡す
- 出力形式: 話題の切れ目でセクション分割し、各セクションに
  - `## [開始タイムスタンプ] 見出し`
  - `**要約:**`（2〜3文）
  - 実際の会話（`- 話者名: 発言`）を時系列で列挙
- `config.md` があればシステムプロンプトに追加方針として連結
- 生成物を `議事録_<セッション名>.md` として保存

### E. 出力

- 議事録を `MINUTES_CHANNEL_ID`（または `/join` 実行チャンネル）へ投稿
- Discordの2000文字制限に合わせて分割送信
- Markdownファイルとしても `recordings/<セッション>/` に保存

## 4. 議事録作成方針（config.md）

- `config.md` の内容はシステムプロンプトの「追加方針」として連結される
- フォーマット・トーン・重点（技術仕様は詳細に、雑談は簡潔に 等）を自由に記述可能
- 未作成の場合はデフォルトの方針（タイムスタンプ・セクション形式）で生成

## 5. 処理フロー

1. `/join` または対象VCへの参加でBotが録音開始
2. ユーザーごとに音声を録音（タイムスタンプ付きPCM蓄積）
3. `/leave` またはVC無人化を検知して切断
4. 全ユーザーをミックスして `recording.wav` を保存
5. ユーザーごとにWhisperで文字起こしし、`[MM:SS] 話者名: 発言` 形式に統合
6. Claude CLIでタイムスタンプ／セクション形式の議事録を生成
7. Discordへ投稿し、Markdownとして保存

## 6. 録音データの保存構成

`recordings/` 以下に日付フォルダ（`YYYY-MM-DD`、同日複数回は `_2`, `_3`, ...）で保存。

```
recordings/2026-02-28/
  recording.wav          # 全ユーザーをミックスした録音（48kHz stereo）
  transcript.txt         # 話者名・タイムスタンプ付き文字起こし
  議事録_2026-02-28.md    # Claude CLIによる議事録
```

## 7. 補助スクリプト

- `generate-minutes.js` : 既存の `recording.wav` から文字起こし・議事録を再生成
  - ミックス済み音声を入力とするため話者分離は行わない
  - 要約は OpenAI GPT-4o を使用（本体の Claude CLI とは別系統）
  - 使用例: `node generate-minutes.js recordings/2026-03-14`
