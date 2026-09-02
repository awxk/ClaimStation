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
    if (!(await clickPrimaryCta(page, "Add to Library")) && !(await selectFreeRedeemableOfferAndClick(page, "Add to Library"))) {
      throw new SafetyError("Primary CTA says add-to-library, but no visible primary button was found", state);
    }
    await page.waitForTimeout(5_000);
    return "added-to-library";
  }

  if (!(await clickPrimaryCta(page, "Add to Cart")) && !(await selectFreeRedeemableOfferAndClick(page, "Add to Cart"))) {
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

async function selectFreeRedeemableOfferAndClick(page: Page, label: "Add to Library" | "Add to Cart"): Promise<boolean> {
  const actionFragments = label === "Add to Cart" ? ["ADD_TO_CART"] : ["BACKGROUND_PURCHASE_AND_DOWNLOAD", "ADD_TO_LIBRARY"];
  let selected = false;
  for (const actionFragment of actionFragments) {
    const offer = page
      .locator(`[data-qa^="mfeCtaMain#offer"]:has(input[name="activeCta"][type="radio"][value*="${actionFragment}"])`)
      .filter({ hasText: /\bFree\b/i })
      .first();
    if (!(await offer.isVisible().catch(() => false))) continue;
    await offer.click({ timeout: 5_000 });
    selected = true;
    break;
  }
  if (!selected) return false;
  await page.waitForTimeout(1_500);
  return clickPrimaryCta(page, label);
}

async function clickPrimaryCta(page: Page, label: "Add to Library" | "Add to Cart"): Promise<boolean> {
  const exactText = new RegExp(`^${escapeRegex(label)}$`, "i");
  const visibleButton = page.locator('[data-qa="mfeCtaMain#cta#action"]').filter({ hasText: exactText }).first();
  if (await visibleButton.isVisible().catch(() => false)) {
    await visibleButton.click();
    return true;
  }

  const loosePrimaryButton = page.locator('[data-qa="mfeCtaMain#cta#action"]').filter({ hasText: new RegExp(escapeRegex(label), "i") }).first();
  if (await loosePrimaryButton.isVisible().catch(() => false)) {
    await loosePrimaryButton.click();
    return true;
  }

  const accessibleButton = page.getByRole("button", { name: exactText }).first();
  if (await accessibleButton.isVisible().catch(() => false)) {
    await accessibleButton.click();
    return true;
  }

  const accessibleLink = page.getByRole("link", { name: exactText }).first();
  if (await accessibleLink.isVisible().catch(() => false)) {
    await accessibleLink.click();
    return true;
  }

  const ctaText = page.locator('[data-qa="mfeCtaMain#cta"]').getByText(exactText).first();
  if (await ctaText.isVisible().catch(() => false)) {
    await ctaText.click();
    return true;
  }

  return await page.evaluate(
    `((buttonLabel) => {
      const normalize = (value) => value ? value.replace(/\\s+/g, " ").trim() : "";
      const candidates = Array.from(document.querySelectorAll('[data-qa="mfeCtaMain#cta#action"], [data-qa="mfeCtaMain#cta"] a, [data-qa="mfeCtaMain#cta"] button, button, a, [role="button"]'));
      const button = candidates.find((element) => {
        const text = normalize(element.textContent);
        if (!text.toLowerCase().includes(buttonLabel.toLowerCase())) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      if (!button) return false;
      if (button instanceof HTMLElement) button.click();
      else button.dispatchEvent(new Event("click", { bubbles: true }));
      return true;
    })`,
    label,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
