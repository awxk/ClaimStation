import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const entryUrl = "https://store.playstation.com/en-us/pages/latest";
const outPath = resolve(".ps-free-redeem/cdp-login-watch-sanitized.jsonl");
const userDataDir = resolve(".ps-free-redeem/cdp-login-profile");
const chromePath = findChromePath();
const port = await findAvailablePort();
const records = [];
let flushPending = Promise.resolve();

await mkdir(dirname(outPath), { recursive: true });
await mkdir(userDataDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    entryUrl,
  ],
  { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
);

let browser;
let page;
let cdp;
let stopping = false;

try {
  await waitForCdp(port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  page = context.pages()[0] ?? (await context.newPage());
  cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");

  cdp.on("Network.requestWillBeSent", (event) => {
    writeRecord({
      type: "request",
      requestId: event.requestId,
      loaderId: event.loaderId,
      frameId: event.frameId,
      resourceType: event.type,
      method: event.request?.method,
      url: redactUrl(event.request?.url),
      documentURL: redactUrl(event.documentURL),
      initiatorType: event.initiator?.type,
      redirectResponse: event.redirectResponse
        ? {
            url: redactUrl(event.redirectResponse.url),
            status: event.redirectResponse.status,
            statusText: event.redirectResponse.statusText,
            mimeType: event.redirectResponse.mimeType,
          }
        : undefined,
    });
  });

  cdp.on("Network.responseReceived", (event) => {
    writeRecord({
      type: "response",
      requestId: event.requestId,
      loaderId: event.loaderId,
      frameId: event.frameId,
      resourceType: event.type,
      url: redactUrl(event.response?.url),
      status: event.response?.status,
      statusText: event.response?.statusText,
      mimeType: event.response?.mimeType,
      protocol: event.response?.protocol,
      remoteIPAddress: event.response?.remoteIPAddress,
      remotePort: event.response?.remotePort,
      fromDiskCache: event.response?.fromDiskCache,
      fromServiceWorker: event.response?.fromServiceWorker,
    });
  });

  cdp.on("Network.loadingFailed", (event) => {
    writeRecord({
      type: "loading-failed",
      requestId: event.requestId,
      resourceType: event.type,
      errorText: event.errorText,
      canceled: event.canceled,
      blockedReason: event.blockedReason,
    });
  });

  cdp.on("Network.loadingFinished", (event) => {
    writeRecord({
      type: "loading-finished",
      requestId: event.requestId,
      encodedDataLength: event.encodedDataLength,
    });
  });

  cdp.on("Page.frameNavigated", (event) => {
    writeRecord({
      type: "frame-navigated",
      frameId: event.frame?.id,
      parentId: event.frame?.parentId,
      url: redactUrl(event.frame?.url),
      mimeType: event.frame?.mimeType,
      securityOrigin: event.frame?.securityOrigin,
    });
  });

  await page.goto(entryUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  writeRecord({ type: "watcher-ready", url: redactUrl(page.url()) });
  console.log(`READY ${outPath}`);
  console.log("Log in in the opened Chrome window. Press Ctrl+C here when finished.");

  while (!stopping) {
    await snapshotVisibleState().catch((error) => {
      writeRecord({ type: "snapshot-error", error: String(error) });
    });
    await delay(1000);
  }
} finally {
  await flush();
  await browser?.close().catch(() => undefined);
  chrome.kill();
}

async function snapshotVisibleState() {
  if (!page || page.isClosed()) return;
  const snapshot = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return {
      href: location.href,
      title: document.title,
      markers: {
        signIn: /\bSign In\b/i.test(text),
        somethingWrong: /Something went wrong/i.test(text),
        signedInHints: /Game Library|Order History|Sign Out/i.test(text),
        email: /email|sign-in id/i.test(text),
        password: /password/i.test(text),
        twoStep: /verification code|two-step|2-step|passkey|security|captcha/i.test(text),
      },
      textSample: text.slice(0, 400),
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
    };
  });
  writeRecord({
    type: "visible-state",
    href: redactUrl(snapshot.href),
    title: snapshot.title,
    markers: snapshot.markers,
    textSample: redactText(snapshot.textSample),
    webdriver: snapshot.webdriver,
    userAgent: snapshot.userAgent,
  });
}

function writeRecord(record) {
  records.push({ at: new Date().toISOString(), ...record });
  void flush();
}

function flush() {
  flushPending = flushPending.then(() => writeFile(outPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8"));
  return flushPending;
}

function redactUrl(raw) {
  if (!raw) return raw;
  try {
    const url = new URL(String(raw), entryUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveKey(key)) url.searchParams.set(key, "[REDACTED]");
    }
    if (url.hash) {
      url.hash = url.hash.replace(/(access_token|id_token|token|code|state|password|session|login_hint|duid|cid|nonce)=([^&]+)/gi, "$1=[REDACTED]");
    }
    return url.toString();
  } catch {
    return String(raw).replace(/([?&#](?:access_token|id_token|token|code|state|password|session|login_hint|duid|cid|nonce)=)[^&]+/gi, "$1[REDACTED]");
  }
}

function isSensitiveKey(key) {
  return /token|secret|pass|auth|session|code|state|duid|nonce|cid|login_hint|redirect_uri|error_description|npsso/i.test(key);
}

function redactText(text) {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\b\d{6}\b/g, "[CODE]");
}

function findChromePath() {
  const candidates = [
    process.env.PS_REDEEM_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Could not find Chrome. Set PS_REDEEM_CHROME_PATH.");
  return found;
}

async function findAvailablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local debugging port.")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForCdp(activePort) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${activePort}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Chrome remote debugging endpoint.");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
