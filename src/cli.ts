#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import type { Frame, Locator, Page } from "playwright";
import { readConfig } from "./config.js";
import {
  defaultPlatPricesFreeUrl,
  candidatesFromTextFile,
  fetchFreeCandidatesFromPlatPrices,
  scrapeFreeCandidatesFromPlatPricesPage,
} from "./discovery/platprices.js";
import { defaultPsDealsFreeUrl, psDealsCollectionUrls, streamCandidatesFromPsDeals } from "./discovery/psdeals.js";
import {
  discoverCandidatesFromPlayStation,
  resolveCandidateFromDiscoveryUrl,
  streamCandidatesFromPlayStation,
  type PlayStationDiscoveryKind,
} from "./discovery/playstation.js";
import { appendAuditEvent, readAuditEvents } from "./state/audit.js";
import { readCache, shouldAttemptCandidate, updateCacheEntry, writeCache } from "./state/cache.js";
import { assertSafeCart, productIdFromStoreUrl, SafetyError } from "./safety.js";
import { clickSafePrimaryAction } from "./store/actions.js";
import { findChromePath, openBrowserSession } from "./store/browser.js";
import { confirmFreeCart, openCart, readCartState, removeNonFreeCartItems } from "./store/cart.js";
import { readPrimaryCtaState } from "./store/product-page.js";
import type { Candidate } from "./types.js";

const program = new Command();
const STORE_CART_LIMIT = 10;

type LoginScope = Page | Frame;

type PendingCartItem = {
  productId: string;
  name: string;
  storeUrl: string;
};

type CandidateIterable = Iterable<Candidate> | AsyncIterable<Candidate>;

function psDealsUrlsForOptions(options: { psdealsUrl: string; psdealsCollections?: boolean }): string[] {
  if (options.psdealsUrl !== defaultPsDealsFreeUrl) return [options.psdealsUrl];
  return options.psdealsCollections ? [defaultPsDealsFreeUrl, ...psDealsCollectionUrls] : [defaultPsDealsFreeUrl];
}

async function* concatCandidateIterables(...iterables: CandidateIterable[]): AsyncGenerator<Candidate> {
  const seen = new Set<string>();
  for (const iterable of iterables) {
    try {
      for await (const candidate of iterable) {
        if (seen.has(candidate.productId)) continue;
        seen.add(candidate.productId);
        yield candidate;
      }
    } catch (error) {
      console.error(`discovery source failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function storeAppearsSignedIn(page: Page): Promise<boolean> {
  const text = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  if (/\b(Sign Out|Game Library|Order History)\b/i.test(text)) return true;
  const signInVisible = await page
    .locator('[data-qa="web-toolbar#profile-container#signin-button"], button:has-text("Sign In"), a:has-text("Sign In")')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
  if (signInVisible || /\bSign In\b/i.test(text)) return false;
  return await page
    .locator('[data-qa="web-toolbar#profile-container"], [data-qa*="account"], button[aria-label*="account" i], button[aria-label*="profile" i]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}

async function clickStoreSignIn(page: Page): Promise<boolean> {
  const signIn = await firstVisibleLocator([
    page.locator('[data-qa="web-toolbar#profile-container#signin-button"]').first(),
    page.getByRole("button", { name: /^Sign In$/i }).first(),
    page.getByRole("link", { name: /^Sign In$/i }).first(),
    page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first(),
  ]);
  if (!signIn) return false;

  const popup = page.context().waitForEvent("page", { timeout: 3_000 }).catch(() => null);
  await signIn.click({ timeout: 5_000 }).catch(async () => {
    await signIn.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  });
  const popupPage = await popup;
  if (popupPage) {
    await popupPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    await popupPage.waitForTimeout(5_000);
  }
  await page.waitForTimeout(5_000);
  return true;
}

async function settleExistingStoreSession(page: Page): Promise<boolean> {
  if (await storeAppearsSignedIn(page)) return true;
  const clicked = await clickStoreSignIn(page);
  if (!clicked) return false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await storeAppearsSignedIn(page)) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

async function requireStoreSignedIn(page: Page): Promise<void> {
  if (!(await settleExistingStoreSession(page))) {
    throw new Error("PlayStation Store is not signed in for this browser profile. Run `npm run auth:native` and try again.");
  }
}

async function checkoutPendingCart(
  page: Page,
  pendingCartItems: PendingCartItem[],
  options: {
    password: string;
    auditLog: string;
    cachePath: string;
    cache: Awaited<ReturnType<typeof readCache>>;
    finalSweep?: boolean;
  },
): Promise<void> {
  if (pendingCartItems.length === 0 && !options.finalSweep) return;

  try {
    const opened = await openCart(page);
    if (!opened && pendingCartItems.length === 0) return;
    await removeNonFreeCartItems(page);
    const cart = await readCartState(page);
    if (pendingCartItems.length === 0 && cart.lineItems.length === 0 && !cart.canConfirm) return;
    assertSafeCart(cart);
    const after = await confirmFreeCart(page, options.password);

    if (pendingCartItems.length === 0) {
      await appendAuditEvent(options.auditLog, {
        type: "cart-state",
        result: "confirmed-existing-cart",
        details: after,
      });
      await writeCache(options.cachePath, options.cache);
      console.log("confirmed existing free cart");
      return;
    }

    for (const item of pendingCartItems) {
      updateCacheEntry(options.cache, item, "cart-confirmed", { details: after });
      await appendAuditEvent(options.auditLog, {
        type: "cart-state",
        productId: item.productId,
        name: item.name,
        url: item.storeUrl,
        result: "confirmed",
        details: after,
      });
    }

    await writeCache(options.cachePath, options.cache);
    console.log(`confirmed free cart for ${pendingCartItems.length} item(s)`);
    pendingCartItems.length = 0;
  } catch (error) {
    for (const item of pendingCartItems) {
      updateCacheEntry(options.cache, item, "error", { error });
      await appendAuditEvent(options.auditLog, {
        type: "error",
        productId: item.productId,
        name: item.name,
        url: item.storeUrl,
        result: error instanceof Error ? error.message : String(error),
        details: error instanceof SafetyError ? error.details : undefined,
      });
    }
    await writeCache(options.cachePath, options.cache);
    throw error;
  }
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible({ timeout: 750 }).catch(() => false);
}

async function firstVisibleLocator(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    if (await isVisible(locator)) return locator;
  }
  return null;
}

function authScopes(page: Page): LoginScope[] {
  return [page, ...page.frames()];
}

async function firstVisibleInScopes(page: Page, selector: string): Promise<Locator | null> {
  for (const scope of authScopes(page)) {
    const locator = scope.locator(selector).first();
    if (await isVisible(locator)) return locator;
  }
  return null;
}

async function clickAuthSubmit(page: Page): Promise<boolean> {
  for (const scope of authScopes(page)) {
    const button = await firstVisibleLocator([
      scope.getByRole("button", { name: /^(sign in|continue|next|verify)$/i }).first(),
      scope.locator('button[type="submit"], input[type="submit"]').first(),
    ]);
    if (!button) continue;
    await button.click({ timeout: 5_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function fillLoginInput(locator: Locator, value: string): Promise<void> {
  await locator.click({ timeout: 5_000 });
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
  await locator.press("Backspace").catch(() => undefined);
  await locator.pressSequentially(value, { delay: 45 });
}

async function driveSonyAuth(
  page: Page,
  options: { email: string | null; password: string | null; useEnvPassword: boolean },
): Promise<string> {
  const initialBody = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (/\bSomething went wrong\b/i.test(initialBody)) {
    return "sony-auth-error";
  }

  const emailInput = await firstVisibleInScopes(
    page,
    'input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="signin" i], input[autocomplete="username"]',
  );
  if (emailInput) {
    if (!options.email) return "Sony is asking for an email address; set PLAYSTATION_EMAIL or complete it manually.";
    await fillLoginInput(emailInput, options.email);
    await clickAuthSubmit(page);
    await page.waitForTimeout(2_000);
  }

  const passwordInput = await firstVisibleInScopes(page, 'input[type="password"], input[autocomplete="current-password"]');
  if (passwordInput) {
    if (!options.useEnvPassword || !options.password) {
      return "Sony is asking for a password; set PLAYSTATION_PASSWORD or complete it manually.";
    }
    await fillLoginInput(passwordInput, options.password);
    await clickAuthSubmit(page);
    await page.waitForTimeout(3_000);
    return "submitted-password";
  }

  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (/\bSomething went wrong\b/i.test(body)) {
    return "sony-auth-error";
  }
  if (/\b(verification code|two-step|2-step|captcha|passkey|security)\b/i.test(body)) {
    return "Sony is asking for an interactive security step; complete it in the opened Chrome window.";
  }

  return "waiting";
}

program
  .name("claimstation")
  .description("Find and redeem free PlayStation Store licenses with strict zero-dollar cart guards.")
  .version("0.1.0");

program
  .command("auth")
  .description("Open the standalone Chrome profile for PlayStation sign-in, optionally using .env credentials.")
  .option("--timeout-minutes <number>", "how long to wait for sign-in", "10")
  .option("--use-env-password", "use PLAYSTATION_PASSWORD from .env when Sony asks for it", true)
  .option("--no-use-env-password", "do not fill PLAYSTATION_PASSWORD automatically")
  .action(async (options: { timeoutMinutes: string; useEnvPassword: boolean }) => {
    const app = readConfig();
    const session = await openBrowserSession(app.userDataDir, false);
    try {
      await session.page.goto("https://store.playstation.com/en-us/pages/latest", { waitUntil: "domcontentloaded" });
      const deadline = Date.now() + Number(options.timeoutMinutes) * 60_000;
      console.log("Opening PlayStation sign-in in the standalone Chrome profile.");
      const signIn = await firstVisibleLocator([
        session.page.locator('[data-qa="web-toolbar#profile-container#signin-button"]').first(),
        session.page.getByRole("button", { name: /^Sign In$/i }).first(),
        session.page.getByRole("link", { name: /^Sign In$/i }).first(),
        session.page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first(),
      ]);
      if (signIn) {
        const popup = session.context.waitForEvent("page", { timeout: 3_000 }).catch(() => null);
        await signIn.click({ timeout: 5_000 }).catch(() => undefined);
        const popupPage = await popup;
        if (popupPage) {
          await popupPage.waitForLoadState("domcontentloaded").catch(() => undefined);
          session.page = popupPage;
        }
      }

      let lastStatus = "";
      while (Date.now() < deadline) {
        if (await storeAppearsSignedIn(session.page)) {
          console.log("Signed in.");
          return;
        }
        const status = await driveSonyAuth(session.page, {
          email: app.playStationEmail,
          password: app.playStationPassword,
          useEnvPassword: options.useEnvPassword,
        });
        if (status === "sony-auth-error") {
          throw new Error(`Sony sign-in returned "Something went wrong" at ${session.page.url()}`);
        }
        if (status !== lastStatus && status !== "waiting" && status !== "submitted-password") {
          console.log(status);
          lastStatus = status;
        } else if (status === "submitted-password" && status !== lastStatus) {
          console.log("Submitted PlayStation credentials from .env; waiting for signed-in Store state.");
          lastStatus = status;
        }
        await session.page.waitForTimeout(2_000);
      }
      throw new Error("Timed out waiting for PlayStation sign-in.");
    } finally {
      await session.close();
    }
  });

program
  .command("native-auth")
  .description("Open plain Google Chrome for PlayStation sign-in without remote debugging. Close Chrome after signing in.")
  .option("--url <url>", "entry URL to open", "https://store.playstation.com/en-us/pages/latest")
  .option("--netlog <path>", "write a Chrome NetLog while signing in", ".ps-free-redeem/chrome-login-netlog.json")
  .option("--no-netlog", "do not write a Chrome NetLog")
  .action(async (options: { url: string; netlog?: string | boolean }) => {
    const app = readConfig();
    const args = [
      `--user-data-dir=${resolve(app.userDataDir)}`,
      "--no-first-run",
      "--no-default-browser-check",
      options.url,
    ];
    if (typeof options.netlog === "string" && options.netlog.length > 0) {
      const netlogPath = resolve(options.netlog);
      await mkdir(dirname(netlogPath), { recursive: true });
      args.splice(1, 0, `--log-net-log=${netlogPath}`, "--net-log-capture-mode=Default");
      console.log(`Writing Chrome NetLog to ${netlogPath}`);
    }

    await mkdir(app.userDataDir, { recursive: true });
    const chrome = spawn(findChromePath(), args, { stdio: "ignore", windowsHide: true });
    console.log("Chrome is open. Sign in to PlayStation, complete any 2FA, then close that Chrome window to save the profile.");
    await new Promise<void>((resolveProcess, reject) => {
      chrome.once("error", reject);
      chrome.once("exit", () => resolveProcess());
    });
    console.log("Chrome closed; the standalone profile should now be ready for login-check/redeem.");
  });

program
  .command("psdeals-unlock")
  .description("Open plain Google Chrome on PSDeals using the standalone profile. Close Chrome after the PSDeals page loads.")
  .option("--url <url>", "PSDeals URL to open", defaultPsDealsFreeUrl)
  .action(async (options: { url: string }) => {
    const app = readConfig();
    await mkdir(app.userDataDir, { recursive: true });
    const chrome = spawn(
      findChromePath(),
      [
        `--user-data-dir=${resolve(app.userDataDir)}`,
        "--no-first-run",
        "--no-default-browser-check",
        options.url,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    console.log("Chrome is open on PSDeals. Let the page fully load, solve any browser check if shown, then close that Chrome window.");
    await new Promise<void>((resolveProcess, reject) => {
      chrome.once("error", reject);
      chrome.once("exit", () => resolveProcess());
    });
    console.log("Chrome closed; the standalone profile should now be ready for PSDeals discovery.");
  });

program
  .command("login-check")
  .description("Open the standalone Chrome profile and report whether the PlayStation Store appears signed in.")
  .option("--headless", "run browser headlessly", false)
  .action(async (options: { headless: boolean }) => {
    const app = readConfig();
    const session = await openBrowserSession(app.userDataDir, options.headless);
    try {
      await session.page.goto("https://store.playstation.com/en-us/pages/latest", { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(3_000);
      await settleExistingStoreSession(session.page);
      const text = await session.page.locator("body").innerText({ timeout: 10_000 });
      const signInButtonVisible = await session.page
        .locator('[data-qa="web-toolbar#profile-container#signin-button"], button:has-text("Sign In"), a:has-text("Sign In")')
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      const accountControlVisible = await session.page
        .locator('[data-qa="web-toolbar#profile-container"], [data-qa*="account"], button[aria-label*="account" i], button[aria-label*="profile" i]')
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      const signedIn = await storeAppearsSignedIn(session.page);
      console.log(
        JSON.stringify(
          {
            signedIn,
            url: session.page.url(),
            markers: {
              signInText: /\bSign In\b/i.test(text),
              signInButtonVisible,
              accountControlVisible,
              gameLibraryText: /\bGame Library\b/i.test(text),
              orderHistoryText: /\bOrder History\b/i.test(text),
              signOutText: /\bSign Out\b/i.test(text),
            },
          },
          null,
          2,
        ),
      );
    } finally {
      await session.close();
    }
  });

program
  .command("scan")
  .description("Legacy: list free candidates from PlatPrices. Kept as an optional fallback source.")
  .option("--limit <number>", "number of records to request", "25")
  .option("--page <number>", "PlatPrices page number", "1")
  .option("--pages <number>", "number of PlatPrices result pages to scrape without an API key", "1")
  .option("--source <source>", "api, page, or auto", "auto")
  .option("--url <url>", "PlatPrices search URL for page scraping", defaultPlatPricesFreeUrl)
  .option("--file <path>", "text file containing Store or PlatPrices URLs")
  .option("--debug", "print discovery diagnostics", false)
  .option("--headless", "run browser headlessly for page scraping", false)
  .action(async (options: {
    limit: string;
    page: string;
    pages: string;
    source: string;
    url: string;
    file?: string;
    debug: boolean;
    headless: boolean;
  }) => {
    const app = readConfig();
    const useApi = options.source === "api" || (options.source === "auto" && app.platPricesApiKey);
    if (!options.file && !useApi && options.source !== "page") {
      throw new Error("No discovery source available. Set PLATPRICES_API_KEY, pass --file, or explicitly use --source page.");
    }
    const candidates = options.file
      ? await candidatesFromTextFile(options.file)
      : useApi
      ? await fetchFreeCandidatesFromPlatPrices({
          apiKey: app.platPricesApiKey!,
          region: app.region,
          limit: Number(options.limit),
          page: Number(options.page),
        })
      : await (async () => {
          const session = await openBrowserSession(app.userDataDir, options.headless);
          try {
            return await scrapeFreeCandidatesFromPlatPricesPage(session.page, {
              searchUrl: options.url,
              pages: Number(options.pages),
              limit: Number(options.limit),
              debug: options.debug,
            });
          } finally {
            await session.close();
          }
        })();

    for (const candidate of candidates) {
      console.log(`${candidate.productId}\t${candidate.name}\t${candidate.storeUrl}`);
      await appendAuditEvent(app.auditLog, {
        type: "candidate",
        productId: candidate.productId,
        name: candidate.name,
        url: candidate.storeUrl,
        details: candidate,
      });
    }
  });

program
  .command("discover")
  .description("Discover candidates from PlayStation official pages, Store categories, and optional third-party sources.")
  .option("--source <source>", "psdeals, all, or playstation", "psdeals")
  .option("--kind <kind>", "all, free, ps-plus, ps-plus-catalog, ps-plus-whats-new, or ps-plus-exclusive-packs", "all")
  .option("--limit <number>", "maximum candidates to resolve", "50")
  .option("--pages <number>", "maximum Store category pages to scan; omit for all pages", undefined)
  .option("--all", "resolve all discovered candidates", false)
  .option("--url <url...>", "custom official PlayStation page URL(s) to extract Store links from")
  .option("--psdeals-url <url>", "PSDeals zero-price search URL", defaultPsDealsFreeUrl)
  .option("--psdeals-collections", "also scan PSDeals PS+ and free-to-play collection pages", false)
  .option("--refresh-psdeals-cache", "ignore cached PSDeals detail resolutions and refresh them", false)
  .option("--debug", "print discovery diagnostics", false)
  .option("--headless", "run browser headlessly", false)
  .action(
    async (options: {
      source: string;
      kind: PlayStationDiscoveryKind;
      limit: string;
      pages?: string;
      all: boolean;
      url?: string[];
      psdealsUrl: string;
      psdealsCollections: boolean;
      refreshPsdealsCache: boolean;
      debug: boolean;
      headless: boolean;
    }) => {
      const app = readConfig();
      const session = await openBrowserSession(app.userDataDir, options.headless);
      try {
        const limit = options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit);
        const pages = options.pages ? Number(options.pages) : null;
        const candidates: CandidateIterable =
          options.source === "psdeals" || options.source === "psdeals-page"
            ? streamCandidatesFromPsDeals(session.page, {
                searchUrls: psDealsUrlsForOptions(options),
                cookieHeader: app.psDealsCookie,
                discoveryCachePath: app.psDealsDiscoveryCachePath,
                refreshDiscoveryCache: options.refreshPsdealsCache,
                limit,
                pages,
                debug: options.debug,
              })
            : options.source === "all"
              ? concatCandidateIterables(
                  streamCandidatesFromPlayStation(session.page, {
                    kind: options.kind,
                    limit,
                    pages,
                    urls: options.url,
                    debug: options.debug,
                  }),
                  streamCandidatesFromPsDeals(session.page, {
                    searchUrls: psDealsUrlsForOptions(options),
                    cookieHeader: app.psDealsCookie,
                    discoveryCachePath: app.psDealsDiscoveryCachePath,
                    refreshDiscoveryCache: options.refreshPsdealsCache,
                    limit,
                    pages,
                    debug: options.debug,
                  }),
                )
              : streamCandidatesFromPlayStation(session.page, {
                  kind: options.kind,
                  limit,
                  pages,
                  urls: options.url,
                  debug: options.debug,
                });

        for await (const candidate of candidates) {
          console.log(`${candidate.productId}\t${candidate.name}\t${candidate.storeUrl}`);
          await appendAuditEvent(app.auditLog, {
            type: "candidate",
            productId: candidate.productId,
            name: candidate.name,
            url: candidate.storeUrl,
            details: candidate,
          });
        }
      } finally {
        await session.close();
      }
    },
  );

program
  .command("inspect")
  .description("Open a PlayStation Store product, concept, or PlayStation game URL and print the parsed primary CTA state.")
  .argument("<storeUrl>")
  .option("--headless", "run browser headlessly", false)
  .action(async (storeUrl: string, options: { headless: boolean }) => {
    const app = readConfig();

    const session = await openBrowserSession(app.userDataDir, options.headless);
    try {
      await session.page.goto("https://store.playstation.com/en-us/pages/latest", { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(3_000);
      await settleExistingStoreSession(session.page);

      let productId = productIdFromStoreUrl(storeUrl);
      let targetUrl = storeUrl;
      let discoveryCandidate: Candidate | null = null;
      if (!productId) {
        discoveryCandidate = await resolveCandidateFromDiscoveryUrl(session.page, storeUrl, storeUrl, "manual");
        if (!discoveryCandidate) throw new Error(`Could not resolve a product id from ${storeUrl}`);
        productId = discoveryCandidate.productId;
        targetUrl = discoveryCandidate.storeUrl;
      }

      await session.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(3_000);
      const state = await readPrimaryCtaState(session.page, productId);
      console.log(JSON.stringify({ discoveryCandidate, state }, null, 2));
      await appendAuditEvent(app.auditLog, {
        type: "product-state",
        productId,
        name: state.name,
        url: targetUrl,
        result: state.action,
        details: { discoveryCandidate, state },
      });
    } finally {
      await session.close();
    }
  });

program
  .command("redeem")
  .description("Iteratively redeem free candidates, using a local cache to skip completed work.")
  .option("--limit <number>", "maximum candidates to inspect", "10")
  .option("--all", "discover/process all candidates from the selected source", false)
  .option("--pages <number>", "maximum Store category pages to scan; omit for all pages", undefined)
  .option("--source <source>", "psdeals, all, playstation, platprices-api, platprices-page, api, page, or auto", "psdeals")
  .option("--kind <kind>", "PlayStation discovery kind: all, free, ps-plus, ps-plus-catalog, ps-plus-whats-new, ps-plus-exclusive-packs", "all")
  .option("--url <url>", "PlatPrices search URL for page scraping", defaultPlatPricesFreeUrl)
  .option("--psdeals-url <url>", "PSDeals zero-price search URL", defaultPsDealsFreeUrl)
  .option("--psdeals-collections", "also scan PSDeals PS+ and free-to-play collection pages", false)
  .option("--refresh-psdeals-cache", "ignore cached PSDeals detail resolutions and refresh them", false)
  .option("--discover-url <url...>", "custom official PlayStation page URL(s) for PlayStation discovery")
  .option("--file <path>", "text file containing Store or PlatPrices URLs")
  .option("--debug", "print discovery diagnostics", false)
  .option("--confirm-cart", "confirm zero-dollar carts in batches", true)
  .option("--no-confirm-cart", "add free items to cart but do not confirm checkout")
  .option("--force", "ignore cache and attempt matching candidates again", false)
  .option("--retry-errors", "reattempt products previously cached as errors", false)
  .option("--retry-trials", "reattempt products previously cached or discovered as trials", false)
  .option("--headless", "run browser headlessly", false)
  .action(async (options: {
    limit: string;
    all: boolean;
    pages?: string;
    source: string;
    kind: PlayStationDiscoveryKind;
    url: string;
    psdealsUrl: string;
    psdealsCollections: boolean;
    refreshPsdealsCache: boolean;
    discoverUrl?: string[];
    file?: string;
    debug: boolean;
    confirmCart: boolean;
    force: boolean;
    retryErrors: boolean;
    retryTrials: boolean;
    headless: boolean;
  }) => {
    const app = readConfig();
    if (options.confirmCart && !app.playStationPassword) {
      throw new Error("PLAYSTATION_PASSWORD is required when --confirm-cart is used.");
    }

    const session = await openBrowserSession(app.userDataDir, options.headless);
    const cache = await readCache(app.cachePath);
    const pendingCartItems: PendingCartItem[] = [];

    try {
      await session.page.goto("https://store.playstation.com/en-us/pages/latest", { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(3_000);
      await requireStoreSignedIn(session.page);

      const source = options.source === "api" ? "platprices-api" : options.source === "page" ? "platprices-page" : options.source;
      let candidates: CandidateIterable;
      if (options.file) {
        candidates = await candidatesFromTextFile(options.file);
      } else if (source === "playstation") {
        candidates = streamCandidatesFromPlayStation(session.page, {
          kind: options.kind,
          pages: options.pages ? Number(options.pages) : null,
          limit: options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit),
          urls: options.discoverUrl,
          debug: options.debug,
        });
      } else if (source === "psdeals-page" || source === "psdeals") {
        candidates = streamCandidatesFromPsDeals(session.page, {
          searchUrls: psDealsUrlsForOptions(options),
          cookieHeader: app.psDealsCookie,
          discoveryCachePath: app.psDealsDiscoveryCachePath,
          refreshDiscoveryCache: options.refreshPsdealsCache,
          pages: options.pages ? Number(options.pages) : null,
          limit: options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit),
          debug: options.debug,
        });
      } else if (source === "all" || source === "auto") {
        candidates = concatCandidateIterables(
          streamCandidatesFromPlayStation(session.page, {
            kind: options.kind,
            pages: options.pages ? Number(options.pages) : null,
            limit: options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit),
            urls: options.discoverUrl,
            debug: options.debug,
          }),
          streamCandidatesFromPsDeals(session.page, {
            searchUrls: psDealsUrlsForOptions(options),
            cookieHeader: app.psDealsCookie,
            discoveryCachePath: app.psDealsDiscoveryCachePath,
            refreshDiscoveryCache: options.refreshPsdealsCache,
            pages: options.pages ? Number(options.pages) : null,
            limit: options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit),
            debug: options.debug,
          }),
        );
      } else if (source === "platprices-api" || (source === "auto" && app.platPricesApiKey)) {
        candidates = await fetchFreeCandidatesFromPlatPrices({
          apiKey: app.platPricesApiKey!,
          region: app.region,
          limit: options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit),
        });
      } else if (source === "platprices-page") {
        candidates = await scrapeFreeCandidatesFromPlatPricesPage(session.page, {
          searchUrl: options.url,
          pages: options.pages ? Number(options.pages) : 1,
          limit: options.all ? Number.MAX_SAFE_INTEGER : Number(options.limit),
          debug: options.debug,
        });
      } else {
        throw new Error("No discovery source available. Use --source all, playstation, psdeals, --file, or an explicit PlatPrices source.");
      }

      for await (const candidate of candidates) {
        await appendAuditEvent(app.auditLog, {
          type: "candidate",
          productId: candidate.productId,
          name: candidate.name,
          url: candidate.storeUrl,
          details: candidate,
        });

        if (
          !shouldAttemptCandidate(candidate, cache, {
            force: options.force,
            retryTrials: options.retryTrials,
            revisitStatuses: options.retryErrors ? ["error"] : undefined,
          })
        ) {
          console.log(`cached ${candidate.productId}: ${cache.get(candidate.productId)?.status}`);
          await appendAuditEvent(app.auditLog, {
            type: "skip",
            productId: candidate.productId,
            name: candidate.name,
            url: candidate.storeUrl,
            result: `cached:${cache.get(candidate.productId)?.status}`,
          });
          continue;
        }

        if (candidate.isTrial && !options.retryTrials) {
          console.log(`skip ${candidate.productId}: trial`);
          updateCacheEntry(cache, candidate, "trial", { details: candidate });
          await writeCache(app.cachePath, cache);
          await appendAuditEvent(app.auditLog, {
            type: "skip",
            productId: candidate.productId,
            name: candidate.name,
            url: candidate.storeUrl,
            result: "trial",
            details: candidate,
          });
          continue;
        }

        let shouldCheckoutBatch = false;
        try {
          await session.page.goto(candidate.storeUrl, { waitUntil: "domcontentloaded" });
          await session.page.waitForTimeout(3_000);
          const state = await readPrimaryCtaState(session.page, candidate.productId);
          await appendAuditEvent(app.auditLog, {
            type: "product-state",
            productId: candidate.productId,
            name: state.name,
            url: candidate.storeUrl,
            result: state.action,
            details: state,
          });

          if (
            state.action === "owned" ||
            state.action === "unavailable" ||
            state.action === "not-free" ||
            state.action === "trial" ||
            state.action === "needs-subscription" ||
            state.action === "blocked" ||
            state.action === "unknown"
          ) {
            console.log(`skip ${candidate.productId}: ${state.action}`);
            const status =
              state.action === "owned"
                ? "already-owned"
                : state.action === "unavailable"
                  ? "unavailable"
                  : state.action === "not-free"
                    ? "not-free"
                    : state.action === "trial"
                      ? "trial"
                      : state.action === "needs-subscription"
                        ? "needs-subscription"
                        : state.action === "blocked"
                          ? "needs-login"
                          : "unsupported";
            updateCacheEntry(cache, { ...candidate, name: state.name }, status, { details: state });
            await writeCache(app.cachePath, cache);
            await appendAuditEvent(app.auditLog, {
              type: "skip",
              productId: candidate.productId,
              name: state.name,
              url: candidate.storeUrl,
              result: state.action,
            });
            continue;
          }

          const result = await clickSafePrimaryAction(session.page, state, { validateCartAfterAdd: !options.confirmCart });
          console.log(`${result} ${candidate.productId}: ${state.name}`);
          updateCacheEntry(cache, { ...candidate, name: state.name }, result === "added-to-library" ? "redeemed" : "added-to-cart", { details: state });
          await writeCache(app.cachePath, cache);
          await appendAuditEvent(app.auditLog, {
            type: "action",
            productId: candidate.productId,
            name: state.name,
            url: candidate.storeUrl,
            action: result,
            result: "ok",
          });

          if (result === "added-to-cart" && options.confirmCart) {
            pendingCartItems.push({ productId: candidate.productId, name: state.name, storeUrl: candidate.storeUrl });
            shouldCheckoutBatch = pendingCartItems.length >= STORE_CART_LIMIT;
          }
        } catch (error) {
          console.error(`error ${candidate.productId}: ${error instanceof Error ? error.message : String(error)}`);
          updateCacheEntry(cache, candidate, "error", { error });
          await writeCache(app.cachePath, cache);
          await appendAuditEvent(app.auditLog, {
            type: "error",
            productId: candidate.productId,
            name: candidate.name,
            url: candidate.storeUrl,
            result: error instanceof Error ? error.message : String(error),
            details: error instanceof SafetyError ? error.details : undefined,
          });
          continue;
        }

        if (shouldCheckoutBatch) {
          await checkoutPendingCart(session.page, pendingCartItems, {
            password: app.playStationPassword!,
            auditLog: app.auditLog,
            cachePath: app.cachePath,
            cache,
          });
        }
      }

      if (options.confirmCart) {
        await checkoutPendingCart(session.page, pendingCartItems, {
          password: app.playStationPassword!,
          auditLog: app.auditLog,
          cachePath: app.cachePath,
          cache,
          finalSweep: true,
        });
      }
    } catch (error) {
      if (error instanceof SafetyError) {
        await appendAuditEvent(app.auditLog, {
          type: "error",
          result: error.message,
          details: error.details,
        });
      }
      throw error;
    } finally {
      await writeCache(app.cachePath, cache);
      await session.close();
    }
  });

program
  .command("cart-clean")
  .description("Open the current Store cart and remove any non-free line items.")
  .option("--headless", "run browser headlessly", false)
  .action(async (options: { headless: boolean }) => {
    const app = readConfig();
    const session = await openBrowserSession(app.userDataDir, options.headless);
    try {
      await session.page.goto("https://store.playstation.com/en-us/pages/latest", { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(3_000);
      await requireStoreSignedIn(session.page);
      await openCart(session.page);
      const removed = await removeNonFreeCartItems(session.page);
      const cart = await readCartState(session.page);
      console.log(JSON.stringify({ removed, cart }, null, 2));
      await appendAuditEvent(app.auditLog, {
        type: "cart-state",
        result: "cleaned",
        details: { removed, cart },
      });
    } finally {
      await session.close();
    }
  });

program
  .command("cart-checkout")
  .description("Open the current Store cart, remove non-free line items, and confirm it if the total is zero.")
  .option("--headless", "run browser headlessly", false)
  .action(async (options: { headless: boolean }) => {
    const app = readConfig();
    if (!app.playStationPassword) {
      throw new Error("PLAYSTATION_PASSWORD is required for cart checkout.");
    }
    const session = await openBrowserSession(app.userDataDir, options.headless);
    const cache = await readCache(app.cachePath);
    try {
      await session.page.goto("https://store.playstation.com/en-us/pages/latest", { waitUntil: "domcontentloaded" });
      await session.page.waitForTimeout(3_000);
      await requireStoreSignedIn(session.page);
      await checkoutPendingCart(session.page, [], {
        password: app.playStationPassword,
        auditLog: app.auditLog,
        cachePath: app.cachePath,
        cache,
        finalSweep: true,
      });
    } finally {
      await writeCache(app.cachePath, cache);
      await session.close();
    }
  });

program
  .command("cache")
  .description("Print the local product result cache.")
  .action(async () => {
    const app = readConfig();
    const cache = await readCache(app.cachePath);
    console.log(JSON.stringify(Object.fromEntries(cache), null, 2));
  });

program
  .command("report")
  .description("Print the local audit log.")
  .action(async () => {
    const app = readConfig();
    const events = await readAuditEvents(app.auditLog);
    console.log(JSON.stringify(events, null, 2));
  });

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
