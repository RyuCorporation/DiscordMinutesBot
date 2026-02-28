import "dotenv/config";
import { REST, Routes, SlashCommandBuilder, ChannelType } from "discord.js";
import { readFileSync } from "fs";

const config = JSON.parse(readFileSync("./config.json", "utf-8"));

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
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(config.clientId, config.guildId),
  { body: commands }
);

console.log("スラッシュコマンドを登録しました。");
