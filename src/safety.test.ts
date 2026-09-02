import { describe, expect, it } from "vitest";
import { assertFreeMoney, assertSafeCart, assertSafeProductAction, parseUsdLikePrice, SafetyError } from "./safety.js";
import type { CartState, ProductCtaState } from "./types.js";

const baseProduct: ProductCtaState = {
  productId: "UP0000-CUSA00000_00-TEST00000000000",
  name: "Free Test",
  url: "https://store.playstation.com/en-us/product/UP0000-CUSA00000_00-TEST00000000000",
  action: "add-to-cart",
  skuId: "UP0000-CUSA00000_00-TEST00000000000-U001",
  rewardId: "OUTRIGHT",
  price: {
    formatted: "Free",
    minorUnits: 0,
    currencyCode: "USD",
    isFree: true,
  },
  primaryCtaType: "ADD_TO_CART",
  rawActionType: "ADD_TO_CART",
  ineligibilityReasons: [],
  evidence: [],
};

describe("safety guards", () => {
  it("parses free and non-free prices", () => {
    expect(parseUsdLikePrice("Free")).toBe(0);
    expect(parseUsdLikePrice("$0.00")).toBe(0);
    expect(parseUsdLikePrice("$5.99")).toBe(599);
  });

  it("allows verified free product actions", () => {
    expect(() => assertSafeProductAction(baseProduct)).not.toThrow();
  });

  it("rejects paid product actions", () => {
    const paid = {
      ...baseProduct,
      price: { formatted: "$5.99", minorUnits: 599, currencyCode: "USD", isFree: false },
    };
    expect(() => assertSafeProductAction(paid)).toThrow(SafetyError);
  });

  it("rejects non-redeemable product states", () => {
    expect(() => assertSafeProductAction({ ...baseProduct, action: "owned" })).toThrow(SafetyError);
  });

  it("allows a zero-dollar cart", () => {
    const cart: CartState = {
      totalText: "$0.00",
      totalMinorUnits: 0,
      lineItems: [{ name: "Free Thing", priceText: "Free", isFree: true }],
      hasPasswordPrompt: true,
      canConfirm: true,
      evidence: [],
    };
    expect(() => assertSafeCart(cart)).not.toThrow();
  });

  it("rejects a paid cart even when other items are free", () => {
    const cart: CartState = {
      totalText: "$5.99",
      totalMinorUnits: 599,
      lineItems: [
        { name: "Free Thing", priceText: "Free", isFree: true },
        { name: "Paid Thing", priceText: "$5.99", isFree: false },
      ],
      hasPasswordPrompt: true,
      canConfirm: true,
      evidence: [],
    };
    expect(() => assertSafeCart(cart)).toThrow(SafetyError);
  });

  it("rejects inconsistent free labels with nonzero value", () => {
    expect(() =>
      assertFreeMoney({ formatted: "Free", minorUnits: 599, currencyCode: "USD", isFree: true }, "test"),
    ).toThrow(SafetyError);
  });
});
