import type { Page } from "playwright";
import { assertSafeProductAction, SafetyError } from "../safety.js";
import type { ProductCtaState } from "../types.js";
import { openCart, readCartState, removeNonFreeCartItems } from "./cart.js";

export async function clickSafePrimaryAction(
  page: Page,
  state: ProductCtaState,
  options: { validateCartAfterAdd?: boolean } = {},
): Promise<"added-to-cart" | "added-to-library"> {
  assertSafeProductAction(state);
  const validateCartAfterAdd = options.validateCartAfterAdd ?? true;

  if (state.action === "add-to-library") {
    if (!(await clickPrimaryCta(page, "Add to Library"))) {
      throw new SafetyError("Primary CTA says add-to-library, but no visible primary button was found", state);
    }
    await page.waitForTimeout(5_000);
    return "added-to-library";
  }

  if (!(await clickPrimaryCta(page, "Add to Cart"))) {
    const inCart = page.locator('[data-qa="mfeCtaMain#cta#action"]').filter({ hasText: /^In Cart$/i }).first();
    if (!(await inCart.isVisible().catch(() => false))) {
      throw new SafetyError("Primary CTA says add-to-cart, but no visible primary button was found", state);
    }
    if (validateCartAfterAdd) {
      await openCart(page);
      await removeNonFreeCartItems(page);
      const cart = await readCartState(page);
      if (cart.totalMinorUnits !== 0) {
        throw new SafetyError("Cart is non-free while resuming an in-cart item", cart);
      }
    }
    return "added-to-cart";
  }

  await page.waitForTimeout(4_000);
  if (validateCartAfterAdd) {
    await openCart(page);
    await removeNonFreeCartItems(page);
    const cart = await readCartState(page);
    if (cart.totalMinorUnits !== 0) {
      throw new SafetyError("Cart became non-free after adding a supposedly free SKU", cart);
    }
  }
  return "added-to-cart";
}

async function clickPrimaryCta(page: Page, label: "Add to Library" | "Add to Cart"): Promise<boolean> {
  const exactText = new RegExp(`^${escapeRegex(label)}$`, "i");
  const visibleButton = page.locator('[data-qa="mfeCtaMain#cta#action"]').filter({ hasText: exactText }).first();
  if (await visibleButton.isVisible().catch(() => false)) {
    await visibleButton.click();
    return true;
  }

  const accessibleButton = page.getByRole("button", { name: exactText }).first();
  if (await accessibleButton.isVisible().catch(() => false)) {
    await accessibleButton.click();
    return true;
  }

  return await page.evaluate(
    `((buttonLabel) => {
      const normalize = (value) => value ? value.replace(/\\s+/g, " ").trim() : "";
      const candidates = Array.from(document.querySelectorAll('[data-qa="mfeCtaMain#cta#action"], button, [role="button"]'));
      const button = candidates.find((element) => normalize(element.textContent).toLowerCase() === buttonLabel.toLowerCase());
      if (!button) return false;
      button.click();
      return true;
    })`,
    label,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
