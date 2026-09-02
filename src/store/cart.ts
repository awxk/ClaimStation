import type { FrameLocator, Page } from "playwright";
import { assertSafeCart, parseUsdLikePrice, SafetyError } from "../safety.js";
import type { CartLine, CartState } from "../types.js";

function checkoutFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="embeddedcart"]');
}

function parseCartLines(text: string): CartLine[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const items: CartLine[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const priceLine = lines[index + 1];
    if (priceLine === "Free" || /^\$\d/.test(priceLine)) {
      const name = lines[index];
      if (!/^(Subtotal|Tax|Total|Your Wallet|Password|Summary)$/i.test(name)) {
        items.push({
          name,
          priceText: priceLine,
          isFree: parseUsdLikePrice(priceLine) === 0,
        });
      }
    }
  }

  return items;
}

export async function openCart(page: Page): Promise<boolean> {
  if (await page.locator('iframe[name="embeddedcart"]').first().isVisible({ timeout: 750 }).catch(() => false)) return true;
  const button = page
    .locator('[data-qa="web-toolbar#profile-container#cart#show"], button[aria-label*="cart" i]')
    .first()
    .or(page.getByRole("button", { name: /items? in your cart|cart/i }).first());
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click({ timeout: 5_000 }).catch(async () => {
    await button.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  });
  await page.locator('iframe[name="embeddedcart"]').first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
  return true;
}

export async function readCartState(page: Page): Promise<CartState> {
  const frame = checkoutFrame(page);
  const text = await frame.locator("body").innerText({ timeout: 20_000 });
  const totalMatch = text.match(/Total \([^)]*\)\s*\n?(\$\d[\d,.]*|Free|\$0\.00)/i);
  const totalText = totalMatch?.[1] ?? null;
  const canConfirm = await frame.getByRole("button", { name: /Confirm Purchase/i }).first().isEnabled().catch(() => false);

  return {
    totalText,
    totalMinorUnits: parseUsdLikePrice(totalText),
    lineItems: parseCartLines(text),
    hasPasswordPrompt: /Password/i.test(text),
    canConfirm,
    evidence: [text.slice(0, 1_500)],
  };
}

export function isCartFrameUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /iframe\[name="embeddedcart"\]|contentFrame\(\)\.locator\('body'\)|waiting for locator/i.test(message);
}

export async function removeNonFreeCartItems(page: Page): Promise<number> {
  const frame = checkoutFrame(page);
  let removed = 0;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await readCartState(page);
    const firstPaid = state.lineItems.find((line) => !line.isFree);
    if (!firstPaid) return removed;

    const removeButtons = await frame.locator('button[aria-label="Remove"], .cart-item-summary__remove').all();
    if (removeButtons.length === 0) {
      throw new SafetyError("Cart contains paid content but no remove button was found", state);
    }

    await removeButtons[0].click();
    removed += 1;
    await page.waitForTimeout(1_500);
  }

  throw new SafetyError("Timed out removing paid cart items");
}

export async function confirmFreeCart(page: Page, password: string): Promise<CartState> {
  const frame = checkoutFrame(page);
  let state = await readCartState(page);
  assertSafeCart(state);

  if (state.hasPasswordPrompt) {
    const input = frame.locator('input[name="passwordPromptInput"]').first();
    await input.click();
    await input.press("Control+A").catch(() => undefined);
    await input.press("Backspace").catch(() => undefined);
    await input.pressSequentially(password);
    await page.waitForTimeout(1_000);
  }

  state = await readCartState(page);
  assertSafeCart(state);
  if (!state.canConfirm) {
    throw new SafetyError("Free cart is not ready to confirm", state);
  }

  await frame.getByRole("button", { name: /Confirm Purchase/i }).first().click();
  await page.waitForTimeout(8_000);
  return readCartState(page).catch(async () => ({
    totalText: null,
    totalMinorUnits: null,
    lineItems: [],
    hasPasswordPrompt: false,
    canConfirm: false,
    evidence: ["Checkout frame was no longer readable after confirmation."],
  }));
}
