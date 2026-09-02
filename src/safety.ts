import type { CartState, MoneyValue, ProductCtaState } from "./types.js";

export class SafetyError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "SafetyError";
  }
}

export function parseUsdLikePrice(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/\bfree\b/i.test(text)) return 0;
  const match = text.match(/\$\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
  if (!match) return null;
  return Math.round(Number(match[1].replace(/,/g, "")) * 100);
}

export function moneyFromPlayStationPrice(input: {
  basePrice?: unknown;
  discountedPrice?: unknown;
  basePriceValue?: unknown;
  discountedValue?: unknown;
  currencyCode?: unknown;
  isFree?: unknown;
}): MoneyValue {
  const formatted =
    typeof input.discountedPrice === "string"
      ? input.discountedPrice
      : typeof input.basePrice === "string"
        ? input.basePrice
        : null;
  const numeric =
    typeof input.discountedValue === "number"
      ? input.discountedValue
      : typeof input.basePriceValue === "number"
        ? input.basePriceValue
        : parseUsdLikePrice(formatted);

  return {
    formatted,
    minorUnits: numeric,
    currencyCode: typeof input.currencyCode === "string" ? input.currencyCode : null,
    isFree: input.isFree === true || numeric === 0 || /\bfree\b/i.test(formatted ?? ""),
  };
}

export function assertFreeMoney(price: MoneyValue, context: string): void {
  if (!price.isFree || price.minorUnits !== 0) {
    throw new SafetyError(`${context} is not free`, { price });
  }
}

export function assertSafeProductAction(state: ProductCtaState): void {
  if (state.action !== "add-to-cart" && state.action !== "add-to-library") {
    throw new SafetyError("Product is not in a redeemable state", state);
  }
  assertFreeMoney(state.price, `Primary CTA for ${state.productId}`);
}

export function assertSafeCart(cart: CartState): void {
  if (cart.totalMinorUnits !== 0) {
    throw new SafetyError("Cart total is not zero", cart);
  }

  const paidLines = cart.lineItems.filter((item) => !item.isFree);
  if (paidLines.length > 0) {
    throw new SafetyError("Cart contains non-free line items", paidLines);
  }
}

export function productIdFromStoreUrl(url: string): string | null {
  const match = url.match(/\/product\/([^/?#]+)/i);
  return match?.[1] ?? null;
}
