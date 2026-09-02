import { describe, expect, it } from "vitest";
import { shouldBlockBrowserRequest } from "./browser.js";

describe("lean browser resource blocking", () => {
  it("blocks heavy render-only resources", () => {
    expect(shouldBlockBrowserRequest("image", "https://cdn.example.com/cover.jpg")).toBe(true);
    expect(shouldBlockBrowserRequest("image", "https://image.api.playstation.com/vulcan/ap/rnd/cover.png")).toBe(true);
    expect(shouldBlockBrowserRequest("font", "https://cdn.example.com/font.woff2")).toBe(true);
    expect(shouldBlockBrowserRequest("media", "https://cdn.example.com/trailer.mp4")).toBe(true);
  });

  it("keeps PlayStation, PSDeals, and challenge resources available", () => {
    expect(shouldBlockBrowserRequest("script", "https://store.playstation.com/chunk.js")).toBe(false);
    expect(shouldBlockBrowserRequest("xhr", "https://psdeals.net/us-store/all-games")).toBe(false);
    expect(shouldBlockBrowserRequest("script", "https://challenges.cloudflare.com/turnstile/v0/api.js")).toBe(false);
  });

  it("does not slim PSDeals pages", () => {
    expect(shouldBlockBrowserRequest("image", "https://psdeals.net/cover.png")).toBe(false);
    expect(shouldBlockBrowserRequest("image", "https://cdn.example.com/cover.jpg", "https://psdeals.net/us-store/all-games")).toBe(false);
    expect(shouldBlockBrowserRequest("image", "https://psdeals.net/logo.png", "https://psdeals.net/human-check?ticket=abc")).toBe(false);
    expect(shouldBlockBrowserRequest("font", "https://cdn.example.com/font.woff2", "", "https://psdeals.net/human-check?ticket=abc")).toBe(false);
  });

  it("blocks common analytics and tracking requests", () => {
    expect(shouldBlockBrowserRequest("script", "https://www.googletagmanager.com/gtm.js?id=GTM-123")).toBe(true);
    expect(shouldBlockBrowserRequest("xhr", "https://www.google-analytics.com/g/collect")).toBe(true);
  });
});
