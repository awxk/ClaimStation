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
  pageDelayMs?: number;
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

export class PsDealsHumanCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsDealsHumanCheckError";
  }
}

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
      const includeAllCollectionLinks = /\/collection\/(?:free_with_ps_plus|ps_plus_game_catalog|ps_plus_classic_game_collection|free_to_play)\b/i.test(
        listingUrl,
      );
      const links =
        (await fetchPsDealsListingLinks(listingUrl, includeAllCollectionLinks, options).catch((error) => {
          if (options.debug) console.error(`PSDeals HTTP discovery failed for ${listingUrl}: ${String(error)}`);
          return null;
        })) ?? (await loadPsDealsListingLinksInBrowser(page, listingUrl, includeAllCollectionLinks, options, pageNumber));

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

      await waitForPsDealsPagePace(options.pageDelayMs, options.debug);
      if (newLinks === 0 || yielded >= limit) break;
    }
  }
}

async function resolveCandidateFromPsDealsPage(
  page: Page,
  psDealsUrl: string,
  options: Pick<PsDealsDiscoveryOptions, "cookieHeader" | "debug" | "headless" | "humanCheckTimeoutMs">,
): Promise<PsDealsResolveResult> {
  const httpPageData = await fetchPsDealsDetailPage(psDealsUrl, options).catch((error) => {
    if (options.debug) console.error(`PSDeals HTTP detail failed for ${psDealsUrl}: ${String(error)}`);
    return null;
  });
  if (httpPageData) return resolvePsDealsPageData(page, psDealsUrl, httpPageData, options.debug);

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
  return resolvePsDealsPageData(page, psDealsUrl, pageData, options.debug);
}

async function resolvePsDealsPageData(
  page: Page,
  psDealsUrl: string,
  pageData: { title: string; storeUrl: string | null; body: string },
  debug: boolean | undefined,
): Promise<PsDealsResolveResult> {
  if (!pageData.storeUrl) {
    if (debug) console.error(`PSDeals page has no Store FREE link: ${psDealsUrl}`);
    return { status: "unresolved", reason: "PSDeals detail page had no free PlayStation Store link" };
  }
  if (isExcludedFreeListing(`${pageData.title}\n${pageData.body.slice(0, 600)}`)) {
    if (debug) console.error(`Skipping excluded PSDeals detail page: ${pageData.title} (${psDealsUrl})`);
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
  return /\b(are you human|verify your browser|complete this quick check|verification is temporarily unavailable|captcha|checking if the site connection is secure|checking your browser|just a moment|one more step|prove you are human|human verification|verify (?:that )?you are human|reviewing the security of your connection|cf-browser-verification|challenge-platform|challenges\.cloudflare\.com|turnstile|cf-chl|ray id)\b/i.test(text);
}

function isPsDealsHardBlockText(text: string): boolean {
  return /\b(Sorry, you have been blocked|Attention Required)\b/i.test(text);
}

export function isPsDealsVerificationUnavailableText(text: string): boolean {
  return /\bVerification is temporarily unavailable\b/i.test(text);
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
  if (isPsDealsVerificationUnavailableText(firstText)) {
    throw new PsDealsHumanCheckError(
      `PSDeals verification is temporarily unavailable at ${url}. Run \`npm run psdeals:unlock\`, solve PSDeals in the plain Chrome window, close it, then retry this command.`,
    );
  }
  if (!isPsDealsHumanCheckText(firstText)) return;

  throw psDealsUnlockRequiredError(url, options.headless);
}

async function loadPsDealsListingLinksInBrowser(
  page: Page,
  listingUrl: string,
  includeAllCollectionLinks: boolean,
  options: Pick<PsDealsDiscoveryOptions, "debug" | "headless" | "humanCheckTimeoutMs">,
  pageNumber: number,
): Promise<Array<{ url: string; name: string }>> {
  await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await waitForPsDealsAccess(page, listingUrl, options);
  let links = await extractPsDealsListingLinks(page, includeAllCollectionLinks);
  if (links.length > 0) return links;

  const firstProbe = await readPsDealsChallengeProbe(page);
  if (isPsDealsHumanCheckText(firstProbe)) {
    throw psDealsUnlockRequiredError(listingUrl, options.headless);
  }

  if (pageNumber > 1 && isClearlyExhaustedPsDealsPage(firstProbe)) return [];
  if (options.headless) return links;

  throw new PsDealsHumanCheckError(
    `PSDeals exposed no candidate links at ${listingUrl}. Run \`npm run psdeals:unlock\`, solve PSDeals in the plain Chrome window, close it, then retry this command.`,
  );
}

async function fetchPsDealsListingLinks(
  listingUrl: string,
  includeAllCollectionLinks: boolean,
  options: Pick<PsDealsDiscoveryOptions, "cookieHeader" | "debug">,
): Promise<Array<{ url: string; name: string }>> {
  if (!options.cookieHeader) throw new Error("PSDeals HTTP discovery requires PSDEALS_COOKIE");
  const html = await fetchPsDealsHtml(listingUrl, options);
  return extractPsDealsLinksFromHtml(html, listingUrl, includeAllCollectionLinks);
}

async function fetchPsDealsDetailPage(
  psDealsUrl: string,
  options: Pick<PsDealsDiscoveryOptions, "cookieHeader" | "debug">,
): Promise<{ title: string; storeUrl: string | null; body: string }> {
  if (!options.cookieHeader) throw new Error("PSDeals HTTP detail requires PSDEALS_COOKIE");
  const html = await fetchPsDealsHtml(psDealsUrl, options);
  return extractPsDealsDetailFromHtml(html);
}

async function fetchPsDealsHtml(url: string, options: Pick<PsDealsDiscoveryOptions, "cookieHeader">): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      cookie: options.cookieHeader ?? "",
      "user-agent":
        process.env.PS_REDEEM_USER_AGENT ||
        process.env.PSDEALS_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    },
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (isPsDealsHardBlockText(html) || isPsDealsHumanCheckText(stripHtml(html))) throw new Error("PSDeals returned a human-check or block page");
  return html;
}

function psDealsUnlockRequiredError(url: string, headless: boolean | undefined): PsDealsHumanCheckError {
  if (headless) {
    return new PsDealsHumanCheckError(`PSDeals human check is required at ${url}; rerun without --headless after refreshing PSDeals with \`npm run psdeals:unlock\`.`);
  }
  return new PsDealsHumanCheckError(
    `PSDeals human check is required at ${url}. Run \`npm run psdeals:unlock\`, solve PSDeals in the plain Chrome window, close it, then retry this command.`,
  );
}

function extractPsDealsLinksFromHtml(html: string, baseUrl: string, includeAllCollectionLinks: boolean): Array<{ url: string; name: string }> {
  const links: Array<{ url: string; name: string }> = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/us-store\/game\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = new URL(decodeHtml(match[1]), baseUrl).toString();
    const name = stripHtml(match[2]).replace(/\s+/g, " ").trim() || url;
    if (includeAllCollectionLinks || /(?:^|[\s-])FREE(?:[\s-]|$)|\b0 USD\b/i.test(name)) links.push({ url, name });
  }
  return [...new Map(links.map((link) => [cleanPsDealsUrl(link.url) ?? link.url, link])).values()];
}

function extractPsDealsDetailFromHtml(html: string): { title: string; storeUrl: string | null; body: string } {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+(?:PS[45].*|--?.*|—.*|\|.*)$/, "")
    .trim();
  const storeUrlMatch = [...html.matchAll(/<a\b[^>]*href=["']([^"']*store\.playstation\.com[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)].find((match) =>
    /\bFREE\b|Buy at PlayStation Store/i.test(stripHtml(match[2])),
  );
  return {
    title,
    storeUrl: storeUrlMatch ? decodeHtml(storeUrlMatch[1]) : null,
    body: stripHtml(html),
  };
}

function stripHtml(html: string): string {
  return decodeHtml(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
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
  const [body, title, domMarkers, url] = await Promise.all([
    page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    page.title().catch(() => ""),
    page
      .evaluate(() =>
        [
          document.querySelector("#cf-browser-verification, .cf-browser-verification, .challenge-platform, [class*='turnstile'], [id*='turnstile']")
            ? "challenge element"
            : "",
          [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
            .map((script) => script.src)
            .filter((src) => /challenges\.cloudflare\.com|turnstile|captcha|cf-chl/i.test(src))
            .join("\n"),
          location.pathname === "/human-check" ? "psdeals human-check page" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .catch(() => ""),
    Promise.resolve(page.url()),
  ]);
  return `${url}\n${title}\n${body}\n${domMarkers}`;
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

async function waitForPsDealsPagePace(pageDelayMs: number | undefined, debug: boolean | undefined): Promise<void> {
  const baseDelayMs = Math.max(0, pageDelayMs ?? 0);
  if (baseDelayMs === 0) return;
  const jitterMs = Math.round(baseDelayMs * (0.35 + Math.random() * 0.4));
  const delayMs = baseDelayMs + jitterMs;
  if (debug) console.error(`PSDeals pacing delay: ${delayMs}ms`);
  await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
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
