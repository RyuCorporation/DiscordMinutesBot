import "dotenv/config";
import { REST, Routes, SlashCommandBuilder, ChannelType } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("ボイスチャンネルに参加して録音を開始します")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("参加するボイスチャンネル（省略時は自分がいるVC）")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ボイスチャンネルから退出し、議事録を作成します")
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

console.log("スラッシュコマンドを登録しました。");
