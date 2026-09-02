import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import type { Candidate } from "../types.js";
import { parseUsdLikePrice, productIdFromStoreUrl } from "../safety.js";

export const defaultPlatPricesFreeUrl =
  "https://platprices.com/search.php?ps5=1&ps4=1&genre=0&diffcat=atmost&diff=10&price=%240.01&plat=0&bronzeop=atleast&bronzen=&bronzehi=&silverop=atleast&silvern=&silverhi=&goldop=atleast&goldn=&goldhi=&totop=atleast&totn=&tothi=&ptsop=atleast&ptsn=&ptshi=&vr=0&timecat=atmost&time=9999999&pub=&hidedemos=1&page=1&sort=release&order=desc&fe=1&ae=0";

const apiGameSchema = z
  .object({
    ProductName: z.string(),
    PSNID: z.string().optional().nullable(),
    PSStoreURL: z.string().url().optional().nullable(),
    PlatPricesURL: z.string().url().optional().nullable(),
    IsDLC: z.union([z.number(), z.boolean()]).optional(),
    IsDemoOrSoundtrack: z.union([z.number(), z.boolean()]).optional(),
    IsTrial: z.union([z.number(), z.boolean()]).optional(),
    IsDelisted: z.union([z.number(), z.boolean()]).optional(),
    SalePrice: z.number().optional().nullable(),
    BasePrice: z.number().optional().nullable(),
    PlusPrice: z.number().optional().nullable(),
    PriceCurrency: z.string().optional().nullable(),
    formattedSalePrice: z.string().optional().nullable(),
    formattedBasePrice: z.string().optional().nullable(),
    formattedPlusPrice: z.string().optional().nullable(),
  })
  .passthrough();

const apiResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(apiGameSchema),
});

function flag(value: unknown): boolean {
  return value === true || value === 1;
}

function candidateFromApiGame(game: z.infer<typeof apiGameSchema>): Candidate | null {
  const storeUrl = game.PSStoreURL;
  if (!storeUrl) return null;
  const productId = productIdFromStoreUrl(storeUrl) ?? game.PSNID;
  if (!productId) return null;

  const sale = game.SalePrice ?? parseUsdLikePrice(game.formattedSalePrice ?? undefined);
  const base = game.BasePrice ?? parseUsdLikePrice(game.formattedBasePrice ?? undefined);
  const minorUnits = sale ?? base ?? null;

  return {
    source: "platprices-api",
    name: game.ProductName,
    productId,
    storeUrl,
    platPricesUrl: game.PlatPricesURL ?? undefined,
    isDlc: flag(game.IsDLC),
    isDemoOrSoundtrack: flag(game.IsDemoOrSoundtrack),
    isTrial: flag(game.IsTrial),
    isDelisted: flag(game.IsDelisted),
    price: {
      formatted: game.formattedSalePrice ?? game.formattedBasePrice ?? null,
      minorUnits,
      currencyCode: game.PriceCurrency ?? null,
      isFree: minorUnits === 0 || /\bfree\b/i.test(game.formattedSalePrice ?? game.formattedBasePrice ?? ""),
    },
  };
}

export type PlatPricesSearchOptions = {
  apiKey: string;
  region: string;
  limit?: number;
  page?: number;
};

export async function fetchFreeCandidatesFromPlatPrices({
  apiKey,
  region,
  limit = 25,
  page = 1,
}: PlatPricesSearchOptions): Promise<Candidate[]> {
  const url = new URL("https://platprices.com/api/v2/games");
  url.searchParams.set("region", region);
  url.searchParams.set("price_max", "0");
  url.searchParams.set("platform", "ps4,ps5");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("fields", [
    "ProductName",
    "PSNID",
    "PSStoreURL",
    "PlatPricesURL",
    "IsDLC",
    "IsDemoOrSoundtrack",
    "IsTrial",
    "IsDelisted",
    "SalePrice",
    "BasePrice",
    "PlusPrice",
    "PriceCurrency",
    "formattedSalePrice",
    "formattedBasePrice",
    "formattedPlusPrice",
  ].join(","));

  const response = await fetch(url, {
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`PlatPrices API failed: ${response.status} ${response.statusText}`);
  }

  const json = apiResponseSchema.parse(await response.json());
  if (!json.success) {
    throw new Error("PlatPrices API returned success=false");
  }

  return json.data
    .map(candidateFromApiGame)
    .filter((candidate): candidate is Candidate => Boolean(candidate))
    .filter((candidate) => candidate.price?.isFree)
    .filter((candidate) => !candidate.isDemoOrSoundtrack && !candidate.isTrial && !candidate.isDelisted);
}

export async function resolveStoreUrlFromPlatPricesPage(platPricesUrl: string): Promise<string | null> {
  const response = await fetch(platPricesUrl, {
    headers: { Accept: "text/html" },
  });
  if (!response.ok) return null;
  const html = await response.text();
  return html.match(/https:\/\/store\.playstation\.com\/[a-z-]+\/product\/[A-Z0-9_-]+/)?.[0] ?? null;
}

type PlatPricesRow = {
  href: string;
  text: string;
};

function candidateNameFromRowText(text: string): string {
  return text
    .replace(/^(PS5,?\s*)?(PS4)?\s*DLC\s*/i, "")
    .replace(/\s*FREE.*$/i, "")
    .trim();
}

function shouldIgnorePageCandidate(row: PlatPricesRow): boolean {
  return /\b(demo|trial|soundtrack)\b/i.test(row.text);
}

async function extractSearchRows(page: Page): Promise<PlatPricesRow[]> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    return [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/game/"]')]
      .map((anchor) => ({
        href: anchor.href,
        text: anchor.textContent?.trim().replace(/\s+/g, " ") ?? "",
      }))
      .filter((row) => {
        if (!row.href || seen.has(row.href)) return false;
        seen.add(row.href);
        return true;
      });
  });
}

async function resolveStoreUrlWithBrowser(page: Page, platPricesUrl: string): Promise<string | null> {
  await page.goto(platPricesUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const storeAnchor = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="store.playstation.com"]')]
      .find((anchor) => /Go to PlayStation Store|Buy/i.test(anchor.textContent ?? ""));
    return storeAnchor?.href ?? null;
  });
}

export async function scrapeFreeCandidatesFromPlatPricesPage(
  page: Page,
  options: { searchUrl?: string; pages?: number; limit?: number; debug?: boolean } = {},
): Promise<Candidate[]> {
  const searchUrl = options.searchUrl ?? defaultPlatPricesFreeUrl;
  const pages = options.pages ?? 1;
  const limit = options.limit ?? 25;
  const rows: PlatPricesRow[] = [];

  for (let pageNumber = 1; pageNumber <= pages && rows.length < limit; pageNumber += 1) {
    const url = new URL(searchUrl);
    url.searchParams.set("page", String(pageNumber));
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1_000);
    const pageRows = await extractSearchRows(page);
    if (options.debug) {
      console.error(`PlatPrices page ${pageNumber}: ${pageRows.length} candidate links at ${page.url()}`);
    }
    rows.push(...pageRows.filter((row) => !shouldIgnorePageCandidate(row)));
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (candidates.length >= limit) break;
    const storeUrl = await resolveStoreUrlWithBrowser(page, row.href).catch(() => null);
    if (options.debug) {
      console.error(`Resolved ${row.href} -> ${storeUrl ?? "none"}`);
    }
    if (!storeUrl) continue;
    const productId = productIdFromStoreUrl(storeUrl);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    candidates.push({
      source: "platprices-page",
      name: candidateNameFromRowText(row.text),
      productId,
      storeUrl,
      platPricesUrl: row.href,
      price: {
        formatted: "Free",
        minorUnits: 0,
        currencyCode: null,
        isFree: true,
      },
    });
  }

  return candidates;
}

export async function candidatesFromTextFile(path: string): Promise<Candidate[]> {
  const text = await readFile(path, "utf8");
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    const cleanUrl = url.replace(/[),.;]+$/, "");
    const storeUrl = cleanUrl.includes("store.playstation.com")
      ? cleanUrl
      : cleanUrl.includes("platprices.com")
        ? await resolveStoreUrlFromPlatPricesPage(cleanUrl)
        : null;
    if (!storeUrl) continue;
    const productId = productIdFromStoreUrl(storeUrl);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    candidates.push({
      source: "manual",
      name: productId,
      productId,
      storeUrl,
      platPricesUrl: cleanUrl.includes("platprices.com") ? cleanUrl : undefined,
      price: {
        formatted: null,
        minorUnits: null,
        currencyCode: null,
        isFree: false,
      },
    });
  }

  return candidates;
}
