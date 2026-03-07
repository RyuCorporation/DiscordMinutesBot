// index.js
import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType, Events, MessageFlags } from "discord.js";
import { joinVoiceChannel, EndBehaviorType } from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

// --- 定数 ---
const RECORD_DIR = "./recordings";
if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR);

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;

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

// ============================================================
// WAVファイル書き出し（48kHz stereo — アーカイブ用）
// ============================================================
function writeWavFile(filePath, pcmBuffer) {
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);
  const dataSize = pcmBuffer.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

// ============================================================
// WAVファイル書き出し（16kHz mono — Whisper用）
// ============================================================
function writeMonoWavFile(filePath, pcmMonoBuffer) {
  const sampleRate = 16000;
  const channels = 1;
  const bitDepth = 16;
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmMonoBuffer.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmMonoBuffer]));
}

// ============================================================
// 48kHz stereo → 16kHz mono ダウンサンプル
// ============================================================
function downsampleToMono(pcmBuffer) {
  const bytesPerSampleIn = 2 * 2; // stereo, 16-bit
  const ratio = 3; // 48000 / 16000
  const totalFrames = Math.floor(pcmBuffer.length / bytesPerSampleIn);
  const outFrames = Math.floor(totalFrames / ratio);
  const outBuffer = Buffer.alloc(outFrames * 2); // mono 16-bit

  for (let i = 0; i < outFrames; i++) {
    const srcIndex = i * ratio * bytesPerSampleIn;
    const left = pcmBuffer.readInt16LE(srcIndex);
    const right = pcmBuffer.readInt16LE(srcIndex + 2);
    const mono = Math.round((left + right) / 2);
    outBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * 2);
  }
  return outBuffer;
}

// ============================================================
// バッファを25MB以下のチャンクに分割
// ============================================================
function splitBuffer(buffer, maxBytes = 24 * 1024 * 1024) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += maxBytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + maxBytes, buffer.length)));
  }
  return chunks;
}

// ============================================================
// Whisper APIで文字起こし
// ============================================================
async function transcribeAudio(wavFilePath) {
  const file = fs.createReadStream(wavFilePath);
  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    language: "ja",
    response_format: "text",
  });
  return response;
}

// ============================================================
// ChatGPT APIで議事録要約
// ============================================================
async function summarizeTranscript(transcript) {
  let systemPrompt = "議事録を作成してください。";
  try {
    systemPrompt = fs.readFileSync("./config.md", "utf-8");
  } catch {
    console.warn("config.md が見つかりません。デフォルトのプロンプトを使用します。");
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `以下は会議の文字起こしです。議事録を作成してください。\n\n${transcript}`,
      },
    ],
  });

  return response.choices[0].message.content;
}

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

    pcmStream.on("data", (chunk) => {
      const timestamp = Date.now() - sessionStartTime;
      userBuffers.get(userId).push({ timestamp, chunk });
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
  const bytesPerMs = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8) / 1000;

  // セッション全体の長さを算出（ms）
  let maxEndMs = 0;
  for (const chunks of userBuffers.values()) {
    for (const { timestamp, chunk } of chunks) {
      const endMs = timestamp + chunk.length / bytesPerMs;
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
  const totalBytes = Math.ceil(maxEndMs * bytesPerMs);
  // 2バイト境界に揃える
  const alignedBytes = totalBytes + (totalBytes % 2);
  const mixBuffer = Buffer.alloc(alignedBytes);

  for (const chunks of userBuffers.values()) {
    for (const { timestamp, chunk } of chunks) {
      const offsetBytes = Math.round(timestamp * bytesPerMs);
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
  writeWavFile(mixedWavPath, mixBuffer);

  const durationSec = (
    mixBuffer.length / (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8))
  ).toFixed(1);
  console.log(`Saved mixed recording: ${mixedWavPath} (${durationSec}s)`);

  // --- ユーザーごとにWhisper文字起こし ---
  let combinedTranscript = "";
  if (openai) {
    // ユーザーごとの音声バッファを構築し、個別に文字起こし
    const allSegments = []; // { startMs, speaker, text }

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

      // ユーザーごとのタイムライン音声バッファを構築
      let userMaxEndMs = 0;
      for (const { timestamp, chunk } of chunks) {
        const endMs = timestamp + chunk.length / bytesPerMs;
        if (endMs > userMaxEndMs) userMaxEndMs = endMs;
      }

      const userTotalBytes = Math.ceil(userMaxEndMs * bytesPerMs);
      const userAlignedBytes = userTotalBytes + (userTotalBytes % 2);
      const userBuffer = Buffer.alloc(userAlignedBytes);

      for (const { timestamp, chunk } of chunks) {
        const offsetBytes = Math.round(timestamp * bytesPerMs);
        const alignedOffset = offsetBytes - (offsetBytes % 2);
        for (let i = 0; i < chunk.length - 1; i += 2) {
          const pos = alignedOffset + i;
          if (pos + 1 >= userBuffer.length) break;
          const existing = userBuffer.readInt16LE(pos);
          const incoming = chunk.readInt16LE(i);
          const mixed = Math.max(-32768, Math.min(32767, existing + incoming));
          userBuffer.writeInt16LE(mixed, pos);
        }
      }

      // ダウンサンプルしてWhisperに送信（verbose_jsonでタイムスタンプ取得）
      const monoBuffer = downsampleToMono(userBuffer);
      const audioChunks = splitBuffer(monoBuffer);

      for (let i = 0; i < audioChunks.length; i++) {
        const tempPath = path.join(RECORD_DIR, `temp_${userId}_${i}.wav`);
        writeMonoWavFile(tempPath, audioChunks[i]);

        try {
          const file = fs.createReadStream(tempPath);
          const response = await openai.audio.transcriptions.create({
            model: "whisper-1",
            file,
            language: "ja",
            response_format: "verbose_json",
            timestamp_granularities: ["segment"],
          });

          // チャンクのオフセット（秒）を計算
          const chunkOffsetSec = (i * 24 * 1024 * 1024) / (16000 * 2); // 16kHz mono 16bit
          for (const seg of (response.segments || [])) {
            const text = seg.text.trim();
            if (!text) continue;
            allSegments.push({
              startMs: Math.round((seg.start + chunkOffsetSec) * 1000),
              speaker: username,
              text,
            });
          }
        } catch (err) {
          console.error(`Whisper error (${username} chunk ${i}):`, err.message);
        }

        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
    }

    // タイムスタンプで時系列にソート
    allSegments.sort((a, b) => a.startMs - b.startMs);

    // 発言者: テキスト の形式で結合
    combinedTranscript = allSegments
      .map((s) => `${s.speaker}: ${s.text}`)
      .join("\n");
  }

  // 文字起こし・議事録の保存と投稿
  if (openai && combinedTranscript) {
    // 文字起こしテキストを日付フォルダに保存
    fs.writeFileSync(path.join(sessionDir, "transcript.txt"), combinedTranscript);
    console.log(`文字起こし保存: ${path.join(sessionDir, "transcript.txt")}`);

    // ChatGPTで要約
    console.log("要約を生成中...");
    try {
      const summary = await summarizeTranscript(combinedTranscript);

      // 議事録を日付フォルダに保存
      const sessionName = path.basename(sessionDir);
      const minutesPath = path.join(sessionDir, `議事録_${sessionName}.md`);
      fs.writeFileSync(minutesPath, summary);
      console.log(`議事録保存: ${minutesPath}`);

      // Discordテキストチャンネルに投稿
      if (sessionTextChannelId && sessionGuildId) {
        try {
          const guild = await client.guilds.fetch(sessionGuildId);
          const channel = await guild.channels.fetch(sessionTextChannelId);

          const sessionName = path.basename(sessionDir);
          const fullMessage = `## 📝 議事録 ${sessionName}\n` + summary;
          const messageParts = splitMessageContent(fullMessage);
          for (const part of messageParts) {
            await channel.send(part);
          }
          console.log("議事録をDiscordに投稿しました。");
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
