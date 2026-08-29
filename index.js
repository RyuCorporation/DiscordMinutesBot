// index.js
import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType, Events, MessageFlags } from "discord.js";
import { joinVoiceChannel, EndBehaviorType } from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { readOpenAICreditBalance } from "./billing-balance.js";
import { postMinutesToBlockNotion, sessionDateFromLabel } from "./post-minutes.js";
import { summarizeTranscript, formatTimestamp } from "./summarize.js";
import { buildMinutesPostHeader } from "./usage-metrics.js";
import {
  SAMPLE_RATE,
  CHANNELS,
  BIT_DEPTH,
  BYTES_PER_MS,
  buildWavFile,
  groupChunksIntoSegments,
} from "./audio.js";
import { buildTranscribePrompt, transcribeSegments } from "./transcribe.js";

// --- 定数 ---
const RECORD_DIR = "./recordings";
if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR);

// --- OpenAI クライアント ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

if (!openai) {
  console.warn("OPENAI_API_KEY が未設定です。録音のみ行い、文字起こし・要約はスキップします。");
}

// --- Discord クライアント ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// --- セッション状態 ---
let connection = null;
const activeStreams = new Set(); // 重複subscribe防止用
const userBuffers = new Map();  // userId -> [{timestamp, chunk}, ...] タイムスタンプ付きPCMチャンク
let sessionStartTime = null;    // セッション開始時刻（Date.now()）

let sessionTextChannelId = null; // 議事録投稿先チャンネル
let sessionGuildId = null;       // セッションのギルド
let currentVoiceChannelId = null; // Bot参加中のVC
let isProcessing = false;        // saveAndDisconnect実行中フラグ

// 実時間がこれ以上先行したらパケットロスとみなして位置を合わせ直す。
// これ未満のズレはジッタなので詰めて書く（穴を空けない）。
const PACKET_LOSS_RESYNC_MS = 200;

// ============================================================
// Discord 2000文字制限対応のメッセージ分割
// ============================================================
function splitMessageContent(text, maxLen = 2000) {
  const parts = [];
  while (text.length > maxLen) {
    let splitAt = text.lastIndexOf("\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) splitAt = maxLen;
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt);
  }
  if (text.length > 0) parts.push(text);
  return parts;
}

// ============================================================
// 録音開始（VC参加 + receiver設定）
// ============================================================
function startRecording(voiceChannel) {
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.on("error", (err) => {
    console.error("Voice connection error:", err.message);
  });

  currentVoiceChannelId = voiceChannel.id;
  sessionGuildId = voiceChannel.guild.id;
  sessionStartTime = Date.now();
  console.log(`Joined voice channel: ${voiceChannel.name}`);

  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId) => {
    if (activeStreams.has(userId)) return;
    activeStreams.add(userId);

    if (!userBuffers.has(userId)) {
      userBuffers.set(userId, []);
    }

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });

    const pcmStream = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960,
    });

    // チャンクごとに Date.now() を貼り付け位置にすると、ジッタの分だけ隙間や
    // 重なりが生まれる（実測で発話中に毎秒10回、合計で発話時間の約5%が
    // デジタル無音の穴になっていた）。開始時刻だけ実時計から取り、以降は
    // 書き込んだサンプル数で位置を進めて隙間なく詰める。
    // ただしパケットロスで実時間が大きく先行したときは、そのぶん位置を飛ばして
    // ミックス時の時刻ズレが溜まらないようにする。
    const segmentStartMs = Date.now() - sessionStartTime;
    let writtenBytes = 0;

    pcmStream.on("data", (chunk) => {
      const elapsedMs = Date.now() - sessionStartTime - segmentStartMs;
      const writtenMs = writtenBytes / BYTES_PER_MS;
      if (elapsedMs - writtenMs > PACKET_LOSS_RESYNC_MS) {
        writtenBytes = Math.round(elapsedMs * BYTES_PER_MS);
      }
      userBuffers.get(userId).push({
        timestamp: segmentStartMs + writtenBytes / BYTES_PER_MS,
        chunk,
      });
      writtenBytes += chunk.length;
    });

    pcmStream.on("end", () => {
      activeStreams.delete(userId);
    });

    opusStream.on("error", (err) => {
      console.error(`Opus stream error (${userId}):`, err.message);
      activeStreams.delete(userId);
    });

    pcmStream.on("error", (err) => {
      // デコードエラーは無視して録音を継続（不正パケットをスキップ）
      if (err.message && err.message.includes("Decode error")) {
        return;
      }
      console.error(`PCM stream error (${userId}):`, err.message);
      activeStreams.delete(userId);
    });

    // pipe()を使うとエラー時にパイプラインが破壊されるため、手動でデータを転送
    opusStream.on("data", (chunk) => {
      if (!pcmStream.destroyed) {
        pcmStream.write(chunk);
      }
    });
    opusStream.on("end", () => {
      if (!pcmStream.destroyed) {
        pcmStream.end();
      }
    });
    console.log(`Recording started: ${userId}`);
  });
}

// ============================================================
// 全ユーザーの録音を保存 → 文字起こし → 要約 → 投稿 → 退出
// ============================================================
async function saveAndDisconnect() {
  if (isProcessing) return;
  isProcessing = true;

  // 先にVCから切断（録音はもう不要）
  if (connection) {
    connection.destroy();
    connection = null;
    console.log("Disconnected: no users left in channel");
  }

  // セッションの日付フォルダを決定（同日は連番: YYYY-MM-DD, YYYY-MM-DD_2, ...）
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let sessionDir = path.join(RECORD_DIR, today);
  if (fs.existsSync(sessionDir)) {
    let num = 2;
    while (fs.existsSync(path.join(RECORD_DIR, `${today}_${num}`))) {
      num++;
    }
    sessionDir = path.join(RECORD_DIR, `${today}_${num}`);
  }
  fs.mkdirSync(sessionDir, { recursive: true });

  // --- 全ユーザーのチャンクをミックス ---
  // セッション全体の長さを算出（ms）
  let maxEndMs = 0;
  for (const chunks of userBuffers.values()) {
    for (const { timestamp, chunk } of chunks) {
      const endMs = timestamp + chunk.length / BYTES_PER_MS;
      if (endMs > maxEndMs) maxEndMs = endMs;
    }
  }

  if (maxEndMs === 0) {
    // 録音データなし
    userBuffers.clear();
    activeStreams.clear();
    sessionTextChannelId = null;
    sessionGuildId = null;
    currentVoiceChannelId = null;
    sessionStartTime = null;
    isProcessing = false;
    return;
  }

  // ゼロ埋めバッファを用意（Int16サンプル単位で加算するため）
  const totalBytes = Math.ceil(maxEndMs * BYTES_PER_MS);
  // 2バイト境界に揃える
  const alignedBytes = totalBytes + (totalBytes % 2);
  const mixBuffer = Buffer.alloc(alignedBytes);

  for (const chunks of userBuffers.values()) {
    for (const { timestamp, chunk } of chunks) {
      const offsetBytes = Math.round(timestamp * BYTES_PER_MS);
      // 2バイト境界に揃える
      const alignedOffset = offsetBytes - (offsetBytes % 2);

      for (let i = 0; i < chunk.length - 1; i += 2) {
        const pos = alignedOffset + i;
        if (pos + 1 >= mixBuffer.length) break;

        const existing = mixBuffer.readInt16LE(pos);
        const incoming = chunk.readInt16LE(i);
        const mixed = Math.max(-32768, Math.min(32767, existing + incoming));
        mixBuffer.writeInt16LE(mixed, pos);
      }
    }
  }

  // ミックス済みWAV保存（48kHz stereo）
  const mixedWavPath = path.join(sessionDir, "recording.wav");
  fs.writeFileSync(mixedWavPath, buildWavFile(mixBuffer));

  const durationSec = (
    mixBuffer.length / (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8))
  ).toFixed(1);
  console.log(`Saved mixed recording: ${mixedWavPath} (${durationSec}s)`);

  // --- ユーザーごとにWhisper文字起こし ---
  let combinedTranscript = "";
  if (openai) {
    // ユーザーごとの発話区間を取り出し、個別に文字起こし
    const allSegments = []; // { startMs, speaker, text }
    const prompt = buildTranscribePrompt();

    for (const [userId, chunks] of userBuffers.entries()) {
      if (chunks.length === 0) continue;

      // ユーザー名を取得
      let username = userId;
      try {
        const guild = await client.guilds.fetch(sessionGuildId);
        const member = await guild.members.fetch(userId);
        username = member.displayName;
      } catch {
        try {
          const user = await client.users.fetch(userId);
          username = user.displayName || user.username;
        } catch {}
      }

      // 実際に喋っている区間だけを取り出してWhisperへ送る。
      // 無音を含むタイムラインを丸ごと送ると、30秒窓ごとに定型句を捏造する。
      const speechSegments = groupChunksIntoSegments(chunks);
      const spokenSec =
        speechSegments.reduce((a, s) => a + s.pcm.length / BYTES_PER_MS, 0) / 1000;
      console.log(
        `文字起こし: ${username} — ${speechSegments.length}区間 / ${spokenSec.toFixed(0)}秒`
      );

      const results = await transcribeSegments({
        openai,
        segments: speechSegments,
        prompt,
        label: username,
      });
      for (const { startMs, text } of results) {
        allSegments.push({ startMs, speaker: username, text });
      }
    }

    // タイムスタンプで時系列にソート
    allSegments.sort((a, b) => a.startMs - b.startMs);

    // [タイムスタンプ] 発言者: テキスト の形式で結合
    combinedTranscript = allSegments
      .map((s) => `[${formatTimestamp(s.startMs)}] ${s.speaker}: ${s.text}`)
      .join("\n");
  }

  // 文字起こし・議事録の保存と投稿
  if (openai && combinedTranscript) {
    // 文字起こしテキストを日付フォルダに保存
    fs.writeFileSync(path.join(sessionDir, "transcript.txt"), combinedTranscript);
    console.log(`文字起こし保存: ${path.join(sessionDir, "transcript.txt")}`);

    // Claude CLI で議事録を生成（話者名つきの文字起こし）
    console.log("要約を生成中...");
    const sessionName = path.basename(sessionDir);
    try {
      const { summary, usedTokens } = await summarizeTranscript(combinedTranscript, {
        sessionDate: sessionDateFromLabel(sessionName),
        hasSpeakers: true,
      });

      // 議事録を日付フォルダに保存
      const minutesPath = path.join(sessionDir, `議事録_${sessionName}.md`);
      fs.writeFileSync(minutesPath, summary);
      console.log(`議事録保存: ${minutesPath}`);

      // BlockNotion（TempestPhoenix）へ自動投稿。議事録ページ＋文字起こし子ページを作り、URLを得る。
      // 失敗してもローカルの議事録は保存済み。
      let minutesUrl = null;
      try {
        const result = await postMinutesToBlockNotion({
          label: sessionName,
          summary,
          transcript: combinedTranscript,
        });
        minutesUrl = result.url;
        console.log(`BlockNotion 投稿成功: ${result.url}`);
      } catch (err) {
        console.error("BlockNotion 投稿失敗（議事録ファイルは保存済み）:", err.name, "-", err.message);
      }

      // Discordに「議事録 <日付>」だけ投稿し、そのメッセージのスレッドにBlockNotionのリンクを貼る。
      if (sessionTextChannelId && sessionGuildId) {
        try {
          let creditBalanceUsd = null;
          try {
            creditBalanceUsd = await readOpenAICreditBalance();
          } catch (err) {
            console.warn("OpenAI APIクレジット残高の取得に失敗:", err.message);
          }

          const guild = await client.guilds.fetch(sessionGuildId);
          const channel = await guild.channels.fetch(sessionTextChannelId);

          const headerMessage = await channel.send(
            buildMinutesPostHeader(
              sessionName,
              usedTokens,
              creditBalanceUsd
            )
          );
          const thread = await headerMessage.startThread({
            name: `議事録 ${sessionName}`,
          });

          if (minutesUrl) {
            await thread.send(`📝 議事録: ${minutesUrl}`);
          } else {
            await thread.send("⚠️ BlockNotion への投稿に失敗しました。ローカルの議事録ファイルを参照してください。");
          }
          console.log("議事録スレッドをDiscordに作成しました。");
        } catch (err) {
          console.error("Discord投稿エラー:", err.message);
        }
      }
    } catch (err) {
      console.error("要約生成エラー:", err.message);
    }
  }

  // 状態リセット
  userBuffers.clear();
  activeStreams.clear();
  sessionTextChannelId = null;
  sessionGuildId = null;
  currentVoiceChannelId = null;
  sessionStartTime = null;
  isProcessing = false;
}

// ============================================================
// Bot起動
// ============================================================
client.once("clientReady", () => {
  console.log(`Bot ready as ${client.user.tag}`);
});

// ============================================================
// /join コマンドハンドラ
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "leave") {
    if (!connection) {
      await interaction.reply({
        content: "現在ボイスチャンネルに参加していません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: "🔌 ボイスチャンネルから退出します。議事録を作成中...",
    });

    await saveAndDisconnect();
    return;
  }

  if (interaction.commandName === "join") {
    if (connection) {
      await interaction.reply({
        content: "既にボイスチャンネルに参加中です。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // ターゲットチャンネルを決定
    const specifiedChannel = interaction.options.getChannel("channel");
    let targetChannel;

    if (specifiedChannel) {
      targetChannel = specifiedChannel;
    } else {
      const member = interaction.member;
      if (!member.voice.channel) {
        await interaction.reply({
          content: "ボイスチャンネルに参加してからコマンドを実行してください。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      targetChannel = member.voice.channel;
    }

    // 議事録投稿先チャンネルを保存（.env指定があればそちらを優先）
    sessionTextChannelId = process.env.MINUTES_CHANNEL_ID || interaction.channelId;

    // 録音開始
    startRecording(targetChannel);

    await interaction.reply({
      content: `🎙️ **${targetChannel.name}** に参加しました。録音を開始します。\nVC内の全員が退出すると、自動的に議事録を作成します。`,
    });
  }
});

// ============================================================
// ボイスチャンネルの状態変化を監視
// ============================================================
client.on("voiceStateUpdate", async (oldState, newState) => {
  // --- VCが空になったら自動離脱 ---
  if (connection && currentVoiceChannelId) {
    if (
      oldState.channelId === currentVoiceChannelId &&
      newState.channelId !== currentVoiceChannelId
    ) {
      const channel = oldState.channel;
      if (!channel) return;

      const humanMembers = channel.members.filter((m) => !m.user.bot);
      if (humanMembers.size === 0) {
        await saveAndDisconnect();
      }
    }
  }
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

client.login(process.env.DISCORD_TOKEN);
