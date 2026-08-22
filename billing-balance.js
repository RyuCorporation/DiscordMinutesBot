import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";

export const OPENAI_BILLING_URL =
  "https://platform.openai.com/settings/organization/billing/overview";

const DEFAULT_PROFILE_DIR = path.resolve(".openai-billing-profile");
const DEFAULT_TIMEOUT_MS = 20000;
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export function parseCreditBalance(pageText) {
  if (typeof pageText !== "string") return null;

  const normalized = pageText.replaceAll("\u00a0", " ");
  const match = normalized.match(
    /API credit balance\s*(-?\s*\$\s*[\d,]+(?:\.\d{1,2})?)/i
  );
  if (!match) return null;

  const raw = match[1].replaceAll(" ", "");
  const amount = Number.parseFloat(raw.replaceAll(",", "").replace("$", ""));
  return Number.isFinite(amount) ? amount : null;
}

export function formatUsd(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
      }).format(value)
    : "取得不可";
}

export function resolveBillingBrowserPath(configuredPath = process.env.OPENAI_BILLING_BROWSER_PATH) {
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`指定されたブラウザが見つかりません: ${resolved}`);
    }
    return resolved;
  }

  const detected = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!detected) {
    throw new Error(
      "ChromeまたはEdgeが見つかりません。OPENAI_BILLING_BROWSER_PATHを設定してください。"
    );
  }
  return detected;
}

function resolveProfileDir(configuredDir = process.env.OPENAI_BILLING_PROFILE_DIR) {
  return configuredDir ? path.resolve(configuredDir) : DEFAULT_PROFILE_DIR;
}

function resolveTimeoutMs(configuredTimeout = process.env.OPENAI_BILLING_TIMEOUT_MS) {
  const parsed = Number.parseInt(configuredTimeout ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export async function launchBillingBrowser({ headless = true } = {}) {
  const profileDir = resolveProfileDir();
  const executablePath = resolveBillingBrowserPath();

  fs.mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless,
    viewport: { width: 1280, height: 900 },
  });
}

export async function readOpenAICreditBalance({ enabled, headless = true } = {}) {
  const shouldRead =
    enabled ?? process.env.OPENAI_BILLING_BALANCE_ENABLED === "true";
  if (!shouldRead) return null;

  const context = await launchBillingBrowser({ headless });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(OPENAI_BILLING_URL, {
      waitUntil: "domcontentloaded",
      timeout: resolveTimeoutMs(),
    });

    await page
      .getByText("API credit balance", { exact: true })
      .waitFor({ state: "visible", timeout: resolveTimeoutMs() });

    const balance = parseCreditBalance(await page.locator("body").innerText());
    if (balance === null) {
      throw new Error("Billing画面からAPIクレジット残高を読み取れませんでした。");
    }
    return balance;
  } finally {
    await context.close();
  }
}
