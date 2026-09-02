import { describe, expect, it } from "vitest";
import {
  defaultPsDealsFreeUrl,
  psDealsExtraCatalogUrl,
  psDealsPremiumClassicCatalogUrl,
  psDealsSearchUrlsForOptions,
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
});
