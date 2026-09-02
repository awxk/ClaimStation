import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "playwright";
import type { Candidate } from "../types.js";
import { resolveCandidateFromDiscoveryUrl } from "./playstation.js";

export const defaultPsDealsFreeUrl =
  "https://psdeals.net/us-store/all-games?sort=recently-added&contentType%5B%5D=games&contentType%5B%5D=bundles&contentType%5B%5D=dlc&maxPrice=0";

export const psDealsFreeWithPlusCollectionUrl = "https://psdeals.net/us-store/collection/free_with_ps_plus";
export const psDealsExtraCatalogUrl = "https://psdeals.net/us-store/collection/ps_plus_game_catalog";
export const psDealsPremiumClassicCatalogUrl = "https://psdeals.net/us-store/collection/ps_plus_classic_game_collection";
export const psDealsFreeToPlayCollectionUrl = "https://psdeals.net/us-store/collection/free_to_play";

export const psDealsCollectionUrls = [
  psDealsFreeWithPlusCollectionUrl,
  psDealsExtraCatalogUrl,
  psDealsPremiumClassicCatalogUrl,
  psDealsFreeToPlayCollectionUrl,
];

export type PsDealsSearchUrlOptions = {
  searchUrl?: string;
  includeCollections?: boolean;
  includeExtra?: boolean;
  includePremium?: boolean;
};

export type PsDealsDiscoveryOptions = {
  searchUrl?: string;
  searchUrls?: string[];
  cookieHeader?: string | null;
  discoveryCachePath?: string;
  refreshDiscoveryCache?: boolean;
  humanCheckTimeoutMs?: number;
  headless?: boolean;
  pages?: number | null;
  limit?: number;
  debug?: boolean;
};

type PsDealsDiscoveryCacheEntry = {
  psDealsUrl: string;
  name: string;
  status: "resolved" | "excluded" | "trial" | "unresolved";
  checkedAt: string;
  candidate?: Candidate;
  reason?: string;
};

type PsDealsDiscoveryCache = Record<string, PsDealsDiscoveryCacheEntry>;

type PsDealsResolveResult =
  | { status: "resolved"; candidate: Candidate }
  | { status: "excluded" | "trial" | "unresolved"; reason: string; candidate?: Candidate };

export function psDealsSearchUrlsForOptions(options: PsDealsSearchUrlOptions = {}): string[] {
  const urls = [options.searchUrl ?? defaultPsDealsFreeUrl];
  if (options.includeCollections) urls.push(...psDealsCollectionUrls);
  if (options.includeExtra || options.includePremium) urls.push(psDealsExtraCatalogUrl);
  if (options.includePremium) urls.push(psDealsPremiumClassicCatalogUrl);
  return [...new Set(urls)];
}

export async function discoverCandidatesFromPsDeals(page: Page, options: PsDealsDiscoveryOptions = {}): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for await (const candidate of streamCandidatesFromPsDeals(page, options)) {
    candidates.push(candidate);
  }
  return candidates;
}

export async function* streamCandidatesFromPsDeals(
  page: Page,
  options: PsDealsDiscoveryOptions = {},
): AsyncGenerator<Candidate> {
  const searchUrls = options.searchUrls?.length ? options.searchUrls : [options.searchUrl ?? defaultPsDealsFreeUrl];
  const limit = options.limit ?? 50;
  const seenPsDealsUrls = new Set<string>();
  const seenProducts = new Set<string>();
  const discoveryCachePath = options.discoveryCachePath;
  const discoveryCache = discoveryCachePath ? await readPsDealsDiscoveryCache(discoveryCachePath) : {};
  let yielded = 0;
  await seedPsDealsCookies(page, options.cookieHeader);

  for (const searchUrl of searchUrls) {
    for (let pageNumber = 1; options.pages === null || pageNumber <= (options.pages ?? 1); pageNumber += 1) {
      const listingUrl = pageNumber === 1 ? searchUrl : setPathPage(searchUrl, pageNumber);
      await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2_000);
      await waitForPsDealsAccess(page, listingUrl, options);

      const includeAllCollectionLinks = /\/collection\/(?:free_with_ps_plus|ps_plus_game_catalog|ps_plus_classic_game_collection|free_to_play)\b/i.test(
        listingUrl,
      );
      const links = await waitForPsDealsListingLinks(page, listingUrl, includeAllCollectionLinks, options, pageNumber);

      if (options.debug) console.error(`PSDeals ${listingUrl}: ${links.length} candidate links`);
      let newLinks = 0;
      for (const link of links) {
        const cleanUrl = cleanPsDealsUrl(link.url);
        if (!cleanUrl || seenPsDealsUrls.has(cleanUrl)) continue;
        seenPsDealsUrls.add(cleanUrl);
        newLinks += 1;

        const cached = options.refreshDiscoveryCache ? null : discoveryCache[cleanUrl];
        if (cached) {
          if (options.debug) console.error(`PSDeals cache ${cached.status}: ${cleanUrl}`);
          if (cached.status === "resolved" && cached.candidate && !seenProducts.has(cached.candidate.productId)) {
            seenProducts.add(cached.candidate.productId);
            yielded += 1;
            yield cached.candidate;
            if (yielded >= limit) return;
          }
          continue;
        }

        if (isExcludedFreeListing(link.name)) {
          if (options.debug) console.error(`Skipping excluded PSDeals listing: ${link.name} (${cleanUrl})`);
          await updatePsDealsDiscoveryCache(discoveryCachePath, discoveryCache, cleanUrl, {
            psDealsUrl: cleanUrl,
            name: link.name,
            status: "excluded",
            checkedAt: new Date().toISOString(),
            reason: "listing matched excluded free content pattern",
          });
          continue;
        }

        const resolved = await resolveCandidateFromPsDealsPage(page, cleanUrl, options);
        await updatePsDealsDiscoveryCache(discoveryCachePath, discoveryCache, cleanUrl, {
          psDealsUrl: cleanUrl,
          name: resolved.candidate?.name ?? link.name,
          status: resolved.status,
          checkedAt: new Date().toISOString(),
          candidate: resolved.candidate,
          reason: resolved.status === "resolved" ? undefined : resolved.reason,
        });
        if (resolved.status !== "resolved" || seenProducts.has(resolved.candidate.productId)) continue;
        seenProducts.add(resolved.candidate.productId);
        yielded += 1;
        yield resolved.candidate;
        if (yielded >= limit) return;
      }

      if (newLinks === 0 || yielded >= limit) break;
    }
  }
}

async function resolveCandidateFromPsDealsPage(
  page: Page,
  psDealsUrl: string,
  options: Pick<PsDealsDiscoveryOptions, "debug" | "headless" | "humanCheckTimeoutMs">,
): Promise<PsDealsResolveResult> {
  await page.goto(psDealsUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_000);
  await waitForPsDealsAccess(page, psDealsUrl, options);
  const pageData = await page.evaluate(() => {
    const titleFromDocument = document.title.replace(/\s+(?:PS[45].*|--?.*|—.*|\|.*)$/, "").trim();
    const title =
      titleFromDocument ||
      document.querySelector(".game-title, [class*='game-title']")?.textContent?.replace(/\s+/g, " ").trim() ||
      document.querySelector("h1:not(.modal-title)")?.textContent?.replace(/\s+/g, " ").trim() ||
      document.title.trim();
    const storeUrl =
      [...document.querySelectorAll<HTMLAnchorElement>('a[href*="store.playstation.com/"]')]
        .map((anchor) => ({
          href: anchor.href,
          text: anchor.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }))
        .find((link) => /\bFREE\b/i.test(link.text) || /Buy at PlayStation Store/i.test(link.text))?.href ?? null;
    const body = document.body.innerText ?? "";
    return { title, storeUrl, body };
  });

  if (!pageData.storeUrl) {
    if (options.debug) console.error(`PSDeals page has no Store FREE link: ${psDealsUrl}`);
    return { status: "unresolved", reason: "PSDeals detail page had no free PlayStation Store link" };
  }
  if (isExcludedFreeListing(`${pageData.title}\n${pageData.body.slice(0, 600)}`)) {
    if (options.debug) console.error(`Skipping excluded PSDeals detail page: ${pageData.title} (${psDealsUrl})`);
    return { status: "excluded", reason: "PSDeals detail page matched excluded free content pattern" };
  }

  const candidate = await resolveCandidateFromDiscoveryUrl(page, pageData.storeUrl, pageData.title, "psdeals-page");
  if (!candidate) return { status: "unresolved", reason: "PlayStation Store URL could not be resolved to a product" };
  const psDealsCandidate: Candidate = {
    ...candidate,
    price: {
      formatted: "FREE",
      minorUnits: 0,
      currencyCode: "USD",
      isFree: true,
    },
  };
  if (psDealsCandidate.isTrial) return { status: "trial", reason: "resolved Store candidate was a trial", candidate: psDealsCandidate };
  return { status: "resolved", candidate: psDealsCandidate };
}

function cleanPsDealsUrl(rawUrl: string): string | null {
  if (!/psdeals\.net\/us-store\/game\//i.test(rawUrl)) return null;
  return new URL(rawUrl).toString().replace(/[#?].*$/, "");
}

function setPathPage(rawUrl: string, pageNumber: number): string {
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/\d+\/?$/, "");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${pageNumber}`;
  return url.toString();
}

function isExcludedFreeListing(text: string): boolean {
  return /\b(Game Trial|Timed Trial|Trial|Demo|Beta)\b/i.test(text);
}

export function isPsDealsHumanCheckText(text: string): boolean {
  return /\b(are you human|captcha|checking if the site connection is secure|checking your browser|just a moment|one more step|prove you are human|human verification|verify (?:that )?you are human|reviewing the security of your connection|cf-browser-verification|challenge-platform|challenges\.cloudflare\.com|turnstile|cf-chl|ray id)\b/i.test(text);
}

function isPsDealsHardBlockText(text: string): boolean {
  return /\b(Sorry, you have been blocked|Attention Required)\b/i.test(text);
}

async function waitForPsDealsAccess(
  page: Page,
  url: string,
  options: Pick<PsDealsDiscoveryOptions, "debug" | "headless" | "humanCheckTimeoutMs">,
): Promise<void> {
  const firstText = await readPsDealsChallengeProbe(page);
  if (isPsDealsHardBlockText(firstText)) {
    throw new Error(`PSDeals blocked browser access at ${url}`);
  }
  if (!isPsDealsHumanCheckText(firstText)) return;
  if (options.headless) {
    throw new Error(`PSDeals human check is required at ${url}; rerun without --headless so it can be solved.`);
  }

  const timeoutMs = options.humanCheckTimeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  console.error(`PSDeals human check detected at ${url}. Solve it in the opened Chrome window; waiting up to ${Math.round(timeoutMs / 1000)} seconds.`);
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const text = await readPsDealsChallengeProbe(page);
    if (isPsDealsHardBlockText(text)) {
      throw new Error(`PSDeals blocked browser access at ${url}`);
    }
    if (!isPsDealsHumanCheckText(text)) {
      if (options.debug) console.error("PSDeals human check cleared; resuming discovery.");
      await page.waitForTimeout(1_000);
      return;
    }
  }

  throw new Error(`Timed out waiting for PSDeals human check at ${url}`);
}

async function waitForPsDealsListingLinks(
  page: Page,
  listingUrl: string,
  includeAllCollectionLinks: boolean,
  options: Pick<PsDealsDiscoveryOptions, "debug" | "headless" | "humanCheckTimeoutMs">,
  pageNumber: number,
): Promise<Array<{ url: string; name: string }>> {
  let links = await extractPsDealsListingLinks(page, includeAllCollectionLinks);
  if (links.length > 0) return links;

  const firstProbe = await readPsDealsChallengeProbe(page);
  if (isPsDealsHumanCheckText(firstProbe)) {
    await waitForPsDealsAccess(page, listingUrl, options);
    links = await extractPsDealsListingLinks(page, includeAllCollectionLinks);
    if (links.length > 0) return links;
  }

  if (pageNumber > 1 && isClearlyExhaustedPsDealsPage(firstProbe)) return [];
  if (options.headless) return links;

  const timeoutMs = options.humanCheckTimeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  console.error(
    `PSDeals exposed no candidate links at ${listingUrl}. If a human check is visible, solve it in Chrome; waiting up to ${Math.round(timeoutMs / 1000)} seconds.`,
  );

  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const probe = await readPsDealsChallengeProbe(page);
    if (isPsDealsHardBlockText(probe)) {
      throw new Error(`PSDeals blocked browser access at ${listingUrl}`);
    }
    links = await extractPsDealsListingLinks(page, includeAllCollectionLinks);
    if (links.length > 0) {
      if (options.debug) console.error("PSDeals candidate links appeared; resuming discovery.");
      return links;
    }
    if (pageNumber > 1 && isClearlyExhaustedPsDealsPage(probe)) return [];
  }

  throw new Error(`Timed out waiting for PSDeals candidate links at ${listingUrl}`);
}

async function extractPsDealsListingLinks(page: Page, includeAllCollectionLinks: boolean): Promise<Array<{ url: string; name: string }>> {
  return page.evaluate((includeAll) =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/us-store/game/"]')]
      .map((anchor) => ({
        url: anchor.href,
        name: anchor.textContent?.replace(/\s+/g, " ").trim() || anchor.getAttribute("aria-label") || anchor.href,
      }))
      .filter((link) => includeAll || /(?:^|[\s-])FREE(?:[\s-]|$)|\b0 USD\b/i.test(link.name)),
    includeAllCollectionLinks,
  );
}

async function readPsDealsChallengeProbe(page: Page): Promise<string> {
  const [body, title, html, url] = await Promise.all([
    page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    page.title().catch(() => ""),
    page.content().catch(() => ""),
    Promise.resolve(page.url()),
  ]);
  return `${url}\n${title}\n${body}\n${html.slice(0, 50_000)}`;
}

function isClearlyExhaustedPsDealsPage(text: string): boolean {
  return /\b(We found \d+ results|No results found|Nothing found)\b/i.test(text) && !isPsDealsHumanCheckText(text);
}

async function readPsDealsDiscoveryCache(path: string): Promise<PsDealsDiscoveryCache> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  return JSON.parse(text) as PsDealsDiscoveryCache;
}

async function updatePsDealsDiscoveryCache(
  path: string | undefined,
  cache: PsDealsDiscoveryCache,
  psDealsUrl: string,
  entry: PsDealsDiscoveryCacheEntry,
): Promise<void> {
  if (!path) return;
  cache[psDealsUrl] = entry;
  await mkdir(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

async function seedPsDealsCookies(page: Page, cookieHeader: string | null | undefined): Promise<void> {
  if (!cookieHeader) return;
  const cookies = parseCookieHeader(cookieHeader).map(({ name, value }) => ({
    name,
    value,
    domain: ".psdeals.net",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "Lax" as const,
  }));
  if (cookies.length === 0) return;
  await page.context().addCookies(cookies);
}

function parseCookieHeader(cookieHeader: string): Array<{ name: string; value: string }> {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals <= 0) return null;
      return {
        name: part.slice(0, equals).trim(),
        value: part.slice(equals + 1).trim(),
      };
    })
    .filter((cookie): cookie is { name: string; value: string } => Boolean(cookie?.name));
}
