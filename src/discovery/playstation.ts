import type { Page } from "playwright";
import type { Candidate } from "../types.js";
import { productIdFromStoreUrl } from "../safety.js";

export type PlayStationDiscoveryKind =
  | "all"
  | "free"
  | "ps-plus"
  | "ps-plus-catalog"
  | "ps-plus-whats-new"
  | "ps-plus-exclusive-packs";

export type PlayStationDiscoveryOptions = {
  kind?: PlayStationDiscoveryKind;
  limit?: number;
  pages?: number | null;
  debug?: boolean;
  urls?: string[];
};

type DiscoveryLink = {
  url: string;
  name: string;
  source: Candidate["source"];
};

const officialSources: Record<Exclude<PlayStationDiscoveryKind, "all" | "ps-plus-exclusive-packs">, string[]> = {
  free: ["https://www.playstation.com/en-us/editorial/great-free-to-play-games-on-playstation-4/"],
  "ps-plus": [
    "https://www.playstation.com/en-us/ps-plus/games/",
    "https://www.playstation.com/en-us/ps-plus/whats-new/",
  ],
  "ps-plus-catalog": ["https://www.playstation.com/en-us/ps-plus/games/"],
  "ps-plus-whats-new": ["https://www.playstation.com/en-us/ps-plus/whats-new/"],
};

const storeCategorySources: Record<Extract<PlayStationDiscoveryKind, "free" | "ps-plus" | "ps-plus-exclusive-packs">, string[]> = {
  free: ["https://store.playstation.com/en-us/category/4dfd67ab-4ed7-40b0-a937-a549aece13d0/1"],
  "ps-plus": ["https://store.playstation.com/en-us/category/50140526-145d-46be-9e23-c1fee7290df2/1/"],
  "ps-plus-exclusive-packs": ["https://store.playstation.com/en-us/category/50140526-145d-46be-9e23-c1fee7290df2/1/"],
};

export async function discoverCandidatesFromPlayStation(
  page: Page,
  options: PlayStationDiscoveryOptions = {},
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for await (const candidate of streamCandidatesFromPlayStation(page, options)) {
    candidates.push(candidate);
  }
  return candidates;
}

export async function* streamCandidatesFromPlayStation(
  page: Page,
  options: PlayStationDiscoveryOptions = {},
): AsyncGenerator<Candidate> {
  const kind = options.kind ?? "all";
  const limit = options.limit ?? 50;
  const seenProducts = new Set<string>();
  const seenUrls = new Set<string>();
  let yielded = 0;

  for (const sourceUrl of officialUrlsForKind(kind, options.urls)) {
    const pageLinks = await extractStoreLinksFromOfficialPage(sourceUrl, "playstation-official").catch((error) => {
      if (options.debug) console.error(`PlayStation official discovery failed for ${sourceUrl}: ${String(error)}`);
      return [];
    });
    for await (const resolved of resolveDiscoveryLinks(page, pageLinks, { seenProducts, seenUrls, debug: options.debug })) {
      if (!resolved) continue;
      yielded += 1;
      yield resolved;
      if (yielded >= limit) return;
    }
  }

  for (const categoryUrl of categoryUrlsForKind(kind)) {
    try {
      for await (const categoryLinks of scrapeStoreCategoryLinkPages(page, categoryUrl, {
        pages: options.pages ?? null,
        limit,
        debug: options.debug,
      })) {
        for await (const resolved of resolveDiscoveryLinks(page, categoryLinks, { seenProducts, seenUrls, debug: options.debug })) {
          if (!resolved) continue;
          yielded += 1;
          yield resolved;
          if (yielded >= limit) return;
        }
      }
    } catch (error) {
      if (options.debug) console.error(`PlayStation category discovery failed for ${categoryUrl}: ${String(error)}`);
    }
  }
}

function officialUrlsForKind(kind: PlayStationDiscoveryKind, customUrls: string[] | undefined): string[] {
  if (customUrls?.length) return customUrls;
  if (kind === "all") return [...officialSources.free, ...officialSources["ps-plus"]];
  if (kind === "ps-plus-exclusive-packs") return [];
  return officialSources[kind] ?? [];
}

function categoryUrlsForKind(kind: PlayStationDiscoveryKind): string[] {
  if (kind === "all") return [...storeCategorySources.free, ...storeCategorySources["ps-plus"]];
  if (kind === "free" || kind === "ps-plus" || kind === "ps-plus-exclusive-packs") {
    return storeCategorySources[kind];
  }
  return [];
}

async function extractStoreLinksFromOfficialPage(url: string, source: Candidate["source"]): Promise<DiscoveryLink[]> {
  const response = await fetch(url, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const html = await response.text();
  const links: DiscoveryLink[] = [];

  for (const match of html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[2]);
    if (!isStoreUrl(href) && !isPlayStationGameUrl(href)) continue;
    const text = stripHtml(match[3]) || href;
    links.push({ url: absolutizeUrl(href, url), name: text, source });
  }

  return links;
}

async function scrapeStoreCategoryLinks(
  page: Page,
  categoryUrl: string,
  options: { pages: number | null; limit: number; debug?: boolean },
): Promise<DiscoveryLink[]> {
  const links: DiscoveryLink[] = [];
  for await (const pageLinks of scrapeStoreCategoryLinkPages(page, categoryUrl, options)) {
    links.push(...pageLinks);
    if (links.length >= options.limit) break;
  }
  return links;
}

async function* scrapeStoreCategoryLinkPages(
  page: Page,
  categoryUrl: string,
  options: { pages: number | null; limit: number; debug?: boolean },
): AsyncGenerator<DiscoveryLink[]> {
  let totalLinks = 0;
  const seen = new Set<string>();

  for (let pageNumber = 1; options.pages === null || pageNumber <= options.pages; pageNumber += 1) {
    const beforePageCount = totalLinks;
    const url = categoryUrl.replace(/\/\d+\/?(\?.*)?$/, `/${pageNumber}/$1`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    for (let scroll = 0; scroll < 4; scroll += 1) {
      await page.mouse.wheel(0, 1600).catch(() => undefined);
      await page.waitForTimeout(500);
    }

    const pageLinks = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/concept/"], a[href*="/product/"]')]
        .map((anchor) => ({
          url: anchor.href,
          name: anchor.textContent?.replace(/\s+/g, " ").trim() || anchor.getAttribute("aria-label") || anchor.href,
        }))
        .filter((link) => /store\.playstation\.com/.test(link.url)),
    );

    if (options.debug) console.error(`PlayStation category ${url}: ${pageLinks.length} links`);
    const links: DiscoveryLink[] = [];
    for (const link of pageLinks) {
      const cleanUrl = cleanStoreUrl(link.url);
      if (!cleanUrl || seen.has(cleanUrl)) continue;
      seen.add(cleanUrl);
      links.push({ ...link, url: cleanUrl, source: "playstation-store" });
      totalLinks += 1;
      if (totalLinks >= options.limit) break;
    }
    if (links.length > 0) yield links;
    if (totalLinks >= options.limit) break;
    if (totalLinks === beforePageCount) break;
  }
}

async function* resolveDiscoveryLinks(
  page: Page,
  links: DiscoveryLink[],
  options: { seenProducts: Set<string>; seenUrls: Set<string>; debug?: boolean },
): AsyncGenerator<Candidate> {
  for (const link of links) {
    const cleanUrl = cleanDiscoveryUrl(link.url);
    if (!cleanUrl || options.seenUrls.has(cleanUrl)) continue;
    options.seenUrls.add(cleanUrl);

    if (isLikelyTrialText(link.name)) {
      if (options.debug) console.error(`Skipping likely trial before resolve: ${link.name} (${cleanUrl})`);
      continue;
    }

    const candidate = await resolveCandidateFromDiscoveryUrl(page, cleanUrl, link.name, link.source).catch((error) => {
      if (options.debug) console.error(`Could not resolve ${cleanUrl}: ${String(error)}`);
      return null;
    });
    if (!candidate || options.seenProducts.has(candidate.productId)) continue;
    options.seenProducts.add(candidate.productId);
    yield candidate;
  }
}

export async function resolveCandidateFromDiscoveryUrl(
  page: Page,
  discoveryUrl: string,
  fallbackName: string,
  source: Candidate["source"],
): Promise<Candidate | null> {
  const likelyTrialFromLink = isLikelyTrialText(fallbackName);
  const storeUrl = isPlayStationGameUrl(discoveryUrl) ? await resolveStoreUrlFromGamePage(discoveryUrl) : discoveryUrl;
  if (!storeUrl) return null;

  const directProductId = productIdFromStoreUrl(storeUrl);
  if (directProductId) {
    return {
      source,
      name: fallbackName || directProductId,
      productId: directProductId,
      storeUrl: canonicalProductUrl(directProductId),
      isTrial: likelyTrialFromLink || undefined,
    };
  }

  if (!/\/concept\/\d+/i.test(storeUrl)) return null;
  await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const resolved = await page.evaluate(() => {
    const products: Array<{ productId: string; name: string; activeCtaId: string | null; activeCtaRaw: string }> = [];
    const visiblePrimaryCta =
      [...document.querySelectorAll('[data-qa="mfeCtaMain"], [data-qa="mfeCtaMain#cta"], [data-qa^="mfeCtaMain#offer"]')]
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
        .join("\n") || "";
    for (const script of [...document.scripts]) {
      const raw = script.textContent?.trim();
      if (!raw?.includes("Product:")) continue;
      try {
        const data = JSON.parse(raw) as { cache?: Record<string, unknown> };
        const cache = data.cache ?? {};
        for (const [key, value] of Object.entries(cache)) {
          if (!key.startsWith("Product:")) continue;
          const product = value as { name?: unknown; invariantName?: unknown; activeCtaId?: unknown };
          const productId = key.slice("Product:".length);
          const name =
            typeof product.name === "string"
              ? product.name
              : typeof product.invariantName === "string"
                ? product.invariantName
                : productId;
          products.push({
            productId,
            name,
            activeCtaId: typeof product.activeCtaId === "string" ? product.activeCtaId : null,
            activeCtaRaw:
              typeof product.activeCtaId === "string" ? JSON.stringify(cache[`GameCTA:${product.activeCtaId}`] ?? {}) : "",
          });
        }
      } catch {
        continue;
      }
    }

    const unique = [...new Map(products.map((product) => [product.productId, product])).values()];
    const product = unique.find((item) => item.activeCtaId) ?? unique[0] ?? null;
    return product ? { ...product, visiblePrimaryCta } : null;
  });

  if (!resolved) return null;
  return {
    source,
    name: resolved.name || fallbackName || resolved.productId,
    productId: resolved.productId,
    storeUrl: canonicalProductUrl(resolved.productId),
    isTrial:
      likelyTrialFromLink ||
      isLikelyTrialText(resolved.name) ||
      isLikelyTrialText(resolved.visiblePrimaryCta) ||
      /PS_PLUS_TRIAL|DOWNLOAD_TRIAL/i.test(resolved.activeCtaRaw) ||
      undefined,
  };
}

async function resolveStoreUrlFromGamePage(gamePageUrl: string): Promise<string | null> {
  const response = await fetch(gamePageUrl, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const html = await response.text();
  const productUrls = extractStoreHrefUrlsFromHtml(html).filter((url) => /\/product\//i.test(url));
  const baseProductUrl = productUrls.find((url) => !/(DELUXE|COLLECTION|UPGRADE|ADDON)/i.test(url));
  if (baseProductUrl) return baseProductUrl;

  const storeUrls = extractStoreUrlsFromHtml(html);
  return (
    storeUrls.find((url) => /\/product\//i.test(url) && !/\/product\/\{productId\}/i.test(url)) ??
    storeUrls.find((url) => /\/concept\/\d+/i.test(url)) ??
    null
  );
}

function canonicalProductUrl(productId: string): string {
  return `https://store.playstation.com/en-us/product/${productId}`;
}

function cleanDiscoveryUrl(rawUrl: string): string | null {
  const storeUrl = cleanStoreUrl(rawUrl);
  if (storeUrl) return storeUrl;
  const decoded = decodeHtml(rawUrl).trim();
  if (!isPlayStationGameUrl(decoded)) return null;
  return new URL(decoded).toString().replace(/[#?].*$/, "");
}

function cleanStoreUrl(rawUrl: string): string | null {
  const decoded = decodeHtml(rawUrl).replace(/\\u002F/g, "/").trim();
  if (!decoded.includes("store.playstation.com")) return null;
  const url = decoded.replace(/[),.;]+$/, "");
  const match = url.match(/https:\/\/store\.playstation\.com\/[^"'<>\\\s]+/i);
  return match?.[0].replace(/[#?].*$/, "") ?? null;
}

function extractStoreUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/https?:\/\/store\.playstation\.com\/[^"'<>\\\s]+/gi)) {
    const cleanUrl = cleanStoreUrl(match[0]);
    if (cleanUrl && !cleanUrl.includes("{")) urls.add(cleanUrl);
  }
  for (const cleanUrl of extractStoreHrefUrlsFromHtml(html)) urls.add(cleanUrl);
  return [...urls];
}

function extractStoreHrefUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/href=(["'])(.*?)\1/gi)) {
    const cleanUrl = cleanStoreUrl(match[2]);
    if (cleanUrl && !cleanUrl.includes("{")) urls.add(cleanUrl);
  }
  return [...urls];
}

function isStoreUrl(url: string): boolean {
  return /(^https?:\/\/store\.playstation\.com|store\.playstation\.com\/)/i.test(url);
}

function isPlayStationGameUrl(url: string): boolean {
  return /^(?:https?:\/\/www\.playstation\.com)?\/[a-z]{2}-[a-z]{2}\/games\/[^"'<>\\\s]+\/?/i.test(url);
}

function isLikelyTrialText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(Game Trial|Trial)\b/i.test(text);
}

function absolutizeUrl(href: string, base: string): string {
  return new URL(href, base).toString();
}

function stripHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#61;/g, "=")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
