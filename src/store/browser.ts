import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve, join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const execFileAsync = promisify(execFile);

export type BrowserSession = {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

export type BrowserSessionOptions = {
  blockHeavyResources?: boolean;
};

const challengeResourcePattern = /(?:challenges\.cloudflare\.com|captcha|hcaptcha|recaptcha|turnstile|cf-chl|challenge-platform)/i;
const firstPartyResourcePattern = /(?:playstation\.com|playstation\.net|sonyentertainmentnetwork\.com|cloudflare\.com)/i;
const analyticsResourcePattern =
  /(?:google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|hotjar|segment|amplitude|mixpanel|newrelic|datadog|optimizely|clarity\.ms|bat\.bing\.com|cloudflareinsights\.com)/i;
const psDealsResourcePattern = /psdeals\.net\b/i;

export async function openBrowserSession(userDataDir: string, headless = false, options: BrowserSessionOptions = {}): Promise<BrowserSession> {
  await mkdir(userDataDir, { recursive: true });
  const lockPath = join(userDataDir, ".ps-free-redeem.lock");
  await clearStaleLock(lockPath);
  const lock = await open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new Error(`Browser profile is already in use: ${userDataDir}`);
    }
    throw error;
  });
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let chromeProcess: ChildProcess | null = null;

  try {
    if (headless) {
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: findChromePath(),
        headless,
        userAgent: process.env.PS_REDEEM_USER_AGENT || process.env.PSDEALS_USER_AGENT,
        viewport: null,
      });
    } else {
      await assertChromeProfileNotAlreadyOpen(userDataDir);
      const chromePath = findChromePath();
      const port = await findAvailablePort();
      const userAgent = process.env.PS_REDEEM_USER_AGENT || process.env.PSDEALS_USER_AGENT;
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${resolve(userDataDir)}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ];
      if (userAgent) args.splice(args.length - 1, 0, `--user-agent=${userAgent}`);
      chromeProcess = spawn(
        chromePath,
        args,
        { stdio: "ignore", windowsHide: true },
      );
      await waitForCdp(port);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      context = browser.contexts()[0] ?? (await browser.newContext());
    }
    if (options.blockHeavyResources !== false) await installLeanResourceBlocking(context);
  } catch (error) {
    await lock.close();
    await rm(lockPath, { force: true });
    chromeProcess?.kill();
    throw error;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const releaseLock = async () => {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  };
  return {
    browser: browser ?? undefined,
    context,
    page,
    close: async () => {
      if (browser) {
        await browser.close().catch(() => undefined);
      } else {
        await context?.close().catch(() => undefined);
      }
      chromeProcess?.kill();
      await releaseLock();
    },
  };
}

async function assertChromeProfileNotAlreadyOpen(userDataDir: string): Promise<void> {
  if (platform() !== "win32") return;
  const profilePath = resolve(userDataDir).toLowerCase();
  const script = [
    "$profile = $args[0].ToLowerInvariant()",
    "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($profile) } |",
    "  Select-Object -First 1 -ExpandProperty ProcessId",
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script, profilePath]).catch(() => ({ stdout: "" }));
  const pid = stdout.trim();
  if (!pid) return;
  throw new Error(
    `Chrome profile is already open for ${resolve(userDataDir)} by process ${pid}. Close that ClaimStation/PSDeals Chrome window, then rerun the command.`,
  );
}

export function shouldBlockBrowserRequest(resourceType: string, url: string, pageUrl = "", referer = ""): boolean {
  if (psDealsResourcePattern.test(`${url}\n${pageUrl}\n${referer}`)) return false;
  if (challengeResourcePattern.test(url)) return false;
  if (resourceType === "image" || resourceType === "media" || resourceType === "font") return true;
  if (firstPartyResourcePattern.test(url) && !analyticsResourcePattern.test(url)) return false;
  return analyticsResourcePattern.test(url);
}

async function installLeanResourceBlocking(context: BrowserContext): Promise<void> {
  if (isDisabled(process.env.PS_REDEEM_BLOCK_HEAVY_RESOURCES)) return;

  await context.route("**/*", async (route) => {
    const request = route.request();
    if (shouldBlockBrowserRequest(request.resourceType(), request.url(), requestFrameUrl(request), request.headers().referer)) {
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
}

function requestFrameUrl(request: { frame: () => { url: () => string } }): string {
  try {
    return request.frame().url();
  } catch {
    return "";
  }
}

export function findChromePath(): string {
  const configured = process.env.PS_REDEEM_CHROME_PATH;
  const candidates = [
    configured,
    platform() === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    platform() === "win32" ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    platform() === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    platform() === "linux" ? "/usr/bin/google-chrome" : undefined,
    platform() === "linux" ? "/usr/bin/google-chrome-stable" : undefined,
    platform() === "linux" ? "/usr/bin/chromium-browser" : undefined,
    platform() === "linux" ? "/usr/bin/chromium" : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Could not find Google Chrome. Set PS_REDEEM_CHROME_PATH in .env.");
  }
  return found;
}

async function findAvailablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local debugging port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Timed out waiting for Chrome remote debugging endpoint.");
}

async function clearStaleLock(lockPath: string): Promise<void> {
  const text = await readFile(lockPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!text) return;

  const pid = Number((JSON.parse(text) as { pid?: unknown }).pid);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    await rm(lockPath, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDisabled(value: string | undefined): boolean {
  return /^(?:0|false|no|off)$/i.test(value ?? "");
}
