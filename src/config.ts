import { config as loadDotEnv } from "dotenv";

loadDotEnv({ quiet: true });

export type AppConfig = {
  auditLog: string;
  cachePath: string;
  psDealsDiscoveryCachePath: string;
  platPricesApiKey: string | null;
  playStationEmail: string | null;
  playStationPassword: string | null;
  psDealsCookie: string | null;
  psDealsUserAgent: string | null;
  region: string;
  userDataDir: string;
};

export function readConfig(): AppConfig {
  return {
    auditLog: process.env.PS_REDEEM_AUDIT_LOG || ".ps-free-redeem/audit.jsonl",
    cachePath: process.env.PS_REDEEM_CACHE || ".ps-free-redeem/cache.json",
    psDealsDiscoveryCachePath: process.env.PSDEALS_DISCOVERY_CACHE || ".ps-free-redeem/psdeals-discovery-cache.json",
    platPricesApiKey: process.env.PLATPRICES_API_KEY || null,
    playStationEmail: process.env.PLAYSTATION_EMAIL || null,
    playStationPassword: process.env.PLAYSTATION_PASSWORD || null,
    psDealsCookie: process.env.PSDEALS_COOKIE || null,
    psDealsUserAgent: process.env.PSDEALS_USER_AGENT || null,
    region: process.env.PS_REDEEM_REGION || "us",
    userDataDir: process.env.PS_REDEEM_USER_DATA_DIR || ".ps-free-redeem/chrome-profile",
  };
}
