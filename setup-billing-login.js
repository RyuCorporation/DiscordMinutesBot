import {
  formatUsd,
  launchBillingBrowser,
  OPENAI_BILLING_URL,
  parseCreditBalance,
} from "./billing-balance.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const context = await launchBillingBrowser({ headless: false });

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(OPENAI_BILLING_URL, { waitUntil: "domcontentloaded" });
  console.log("開いたブラウザでOpenAI Platformにログインしてください。");
  console.log("APIクレジット残高を確認できたら、自動的に設定を保存して終了します。");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let balance = null;
  while (Date.now() < deadline && balance === null) {
    const openPages = context.pages().filter((candidate) => !candidate.isClosed());
    if (openPages.length === 0) {
      throw new Error("ログイン確認前にブラウザが閉じられました。");
    }

    for (const candidate of openPages) {
      const bodyText = await candidate.locator("body").innerText().catch(() => "");
      balance = parseCreditBalance(bodyText);
      if (balance !== null) break;
    }

    if (balance === null) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (balance === null) {
    throw new Error("10分以内にAPIクレジット残高を確認できませんでした。");
  }

  console.log(`ログイン確認成功: APIクレジット残高 ${formatUsd(balance)}`);
} finally {
  await context.close();
}
