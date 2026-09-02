import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CacheEntry, CacheStatus, Candidate } from "../types.js";

export type Cache = Map<string, CacheEntry>;

export async function readCache(path: string): Promise<Cache> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const raw = JSON.parse(text) as Record<string, CacheEntry>;
  return new Map(Object.entries(raw));
}

export async function writeCache(path: string, cache: Cache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const raw = Object.fromEntries([...cache.entries()].sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export function shouldAttemptCandidate(
  candidate: Candidate,
  cache: Cache,
  options: { force?: boolean; retryTrials?: boolean; revisitStatuses?: CacheStatus[] } = {},
): boolean {
  const existing = cache.get(candidate.productId);
  if (existing?.status === "not-free") return false;
  if (existing?.status === "trial") return options.retryTrials === true;
  if (existing && options.revisitStatuses?.includes(existing.status)) return true;
  if (options.force) return true;
  if (!existing) return true;
  return false;
}

export function updateCacheEntry(
  cache: Cache,
  candidate: Pick<Candidate, "productId" | "name" | "storeUrl" | "platPricesUrl">,
  status: CacheStatus,
  options: { error?: unknown; details?: unknown; revisitAfter?: string } = {},
): CacheEntry {
  const now = new Date().toISOString();
  const previous = cache.get(candidate.productId);
  const entry: CacheEntry = {
    productId: candidate.productId,
    name: candidate.name,
    storeUrl: candidate.storeUrl,
    platPricesUrl: candidate.platPricesUrl,
    status,
    attempts: (previous?.attempts ?? 0) + 1,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastAttemptAt: now,
    lastSuccessAt:
      status === "redeemed" || status === "already-owned" || status === "cart-confirmed"
        ? now
        : previous?.lastSuccessAt,
    lastError: options.error ? String(options.error instanceof Error ? options.error.message : options.error) : undefined,
    revisitAfter: options.revisitAfter,
    details: options.details,
  };
  cache.set(candidate.productId, entry);
  return entry;
}
