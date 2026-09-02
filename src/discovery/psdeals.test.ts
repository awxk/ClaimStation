import { describe, expect, it } from "vitest";
import {
  defaultPsDealsFreeUrl,
  psDealsExtraCatalogUrl,
  psDealsPremiumClassicCatalogUrl,
  psDealsSearchUrlsForOptions,
  isPsDealsHumanCheckText,
  isPsDealsVerificationUnavailableText,
} from "./psdeals.js";

describe("PSDeals search URL selection", () => {
  it("uses the all-free listing by default", () => {
    expect(psDealsSearchUrlsForOptions()).toEqual([defaultPsDealsFreeUrl]);
  });

  it("adds the Extra catalog when requested", () => {
    expect(psDealsSearchUrlsForOptions({ includeExtra: true })).toEqual([defaultPsDealsFreeUrl, psDealsExtraCatalogUrl]);
  });

  it("adds Extra and Premium classics when premium is requested", () => {
    expect(psDealsSearchUrlsForOptions({ includePremium: true })).toEqual([
      defaultPsDealsFreeUrl,
      psDealsExtraCatalogUrl,
      psDealsPremiumClassicCatalogUrl,
    ]);
  });

  it("recognizes human-check pages", () => {
    expect(isPsDealsHumanCheckText("Are you human? Complete the CAPTCHA to continue.")).toBe(true);
    expect(isPsDealsHumanCheckText("Verify your browser. Complete this quick check to continue to PS Deals.")).toBe(true);
    expect(isPsDealsHumanCheckText("Verification is temporarily unavailable. Please try again later.")).toBe(true);
    expect(isPsDealsHumanCheckText("Checking if the site connection is secure")).toBe(true);
    expect(isPsDealsHumanCheckText("Reviewing the security of your connection")).toBe(true);
    expect(isPsDealsHumanCheckText('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>')).toBe(true);
    expect(isPsDealsHumanCheckText('<div id="cf-browser-verification" class="challenge-platform"></div>')).toBe(true);
    expect(isPsDealsHumanCheckText("We found 1800 results")).toBe(false);
  });

  it("recognizes temporarily unavailable verification", () => {
    expect(isPsDealsVerificationUnavailableText("Verification is temporarily unavailable. Please try again later.")).toBe(true);
    expect(isPsDealsVerificationUnavailableText("Verify your browser")).toBe(false);
  });
});
