import { formatUsd } from "./billing-balance.js";

const TOKEN_USAGE_KEYS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];

export function totalTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  let found = false;
  const total = TOKEN_USAGE_KEYS.reduce((sum, key) => {
    const value = usage[key];
    if (!Number.isFinite(value)) return sum;
    found = true;
    return sum + value;
  }, 0);

  return found ? total : null;
}

export function formatTokenCount(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("ja-JP").format(value)
    : "取得不可";
}

export function buildMinutesPostHeader(
  sessionName,
  usedTokens,
  creditBalanceUsd
) {
  return [
    `議事録 ${sessionName}`,
    `使用量: ${formatTokenCount(usedTokens)}トークン`,
    `残量: ${formatUsd(creditBalanceUsd)}`,
  ].join("｜");
}
