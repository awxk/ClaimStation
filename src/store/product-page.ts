import type { Page } from "playwright";
import { moneyFromPlayStationPrice } from "../safety.js";
import type { ProductCtaAction, ProductCtaState } from "../types.js";

type EmbeddedCta = {
  type?: string;
  action?: {
    type?: string;
    param?: Array<{ name?: string; value?: string }>;
  };
  price?: Record<string, unknown>;
  local?: {
    ctaLabel?: string;
    ctaType?: string;
    priceOrText?: string;
  };
  meta?: {
    ineligibilityReasons?: string[];
  };
};

type EmbeddedProduct = {
  name?: string;
  invariantName?: string;
  activeCtaId?: string;
};

type SelectableOffer = {
  label: string;
  value: string | null;
  actionType: string | null;
  checked: boolean;
};

function actionFromRaw(
  raw: string | null,
  ctaType: string | null,
  textEvidence: string,
  visiblePrimaryCta: string,
  isFree: boolean,
  priceText: string | null,
  selectableOffer: SelectableOffer | null,
): ProductCtaAction {
  const combinedEvidence = `${visiblePrimaryCta}\n${textEvidence}`;
  const trialEvidence = `${raw ?? ""}\n${ctaType ?? ""}\n${priceText ?? ""}\n${visiblePrimaryCta}`;
  if (/\bSign In\b/i.test(visiblePrimaryCta) || /\nSign In\n/i.test(textEvidence)) return "blocked";
  if (/This probably isn't what you're looking for|unavailable|not available/i.test(combinedEvidence)) return "unavailable";
  if (/\b(Game Trial|Trial)\b/i.test(trialEvidence) || /PS_PLUS_TRIAL|DOWNLOAD_TRIAL/i.test(trialEvidence)) return "trial";
  if (selectableOffer && /\bFree\b/i.test(selectableOffer.label) && /BACKGROUND_PURCHASE_AND_DOWNLOAD|ADD_TO_LIBRARY/i.test(selectableOffer.actionType ?? "")) {
    return "add-to-library";
  }
  if (selectableOffer && /\bFree\b/i.test(selectableOffer.label) && /ADD_TO_CART/i.test(selectableOffer.actionType ?? "")) {
    return "add-to-cart";
  }
  if (/\b(Owned|Purchased)\b|Download from Library/i.test(combinedEvidence)) return "owned";
  if (isFree && /Add to Library/i.test(visiblePrimaryCta)) return "add-to-library";
  if (isFree && /(Add to Cart|In Cart)/i.test(visiblePrimaryCta)) return "add-to-cart";
  if (/(Subscribe|Upgrade|Learn More)/i.test(visiblePrimaryCta)) return "needs-subscription";
  if (!raw) return "unknown";
  if (!isFree && /ADD_TO_LIBRARY|ADD_TO_CART/i.test(raw)) return "not-free";
  if (/ADD_TO_LIBRARY/i.test(raw)) return "add-to-library";
  if (/ADD_TO_CART/i.test(raw)) return "add-to-cart";
  if (/PURCHASED|OWNED|BACKGROUND_PURCHASE_AND_DOWNLOAD/i.test(raw)) return "owned";
  return "unknown";
}

export async function readPrimaryCtaState(page: Page, productId: string): Promise<ProductCtaState> {
  const embedded = await page.evaluate((id) => {
    const text = document.body.innerText ?? "";
    const visiblePrimaryCta =
      [...document.querySelectorAll('[data-qa="mfeCtaMain"], [data-qa="mfeCtaMain#cta"], [data-qa^="mfeCtaMain#offer"]')]
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
        .join("\n") || "";
    const selectableOffers = [...document.querySelectorAll<HTMLElement>('[data-qa^="mfeCtaMain#offer"]')]
      .filter((el) => /^mfeCtaMain#offer\d+$/.test(el.getAttribute("data-qa") ?? ""))
      .map((el) => {
        const input = el.querySelector<HTMLInputElement>('input[name="activeCta"][type="radio"]');
        const label = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const value = input?.value ?? null;
        return {
          label,
          value,
          actionType: value?.split(":")[1] ?? null,
          checked: input?.checked ?? false,
        };
      })
      .filter((offer) => offer.label);
    const selectableOffer =
      selectableOffers.find(
        (offer) =>
          !offer.checked &&
          /\bFree\b/i.test(offer.label) &&
          /BACKGROUND_PURCHASE_AND_DOWNLOAD|ADD_TO_LIBRARY|ADD_TO_CART/i.test(offer.actionType ?? ""),
      ) ?? null;
    const markers = ["\nEditions:", "\nAdd-Ons", "\nRatings and reviews", "\nGame and Legal Info"];
    let end = text.length;
    for (const marker of markers) {
      const index = text.indexOf(marker);
      if (index > 0) end = Math.min(end, index);
    }
    const segment = text.slice(0, end);

    for (const script of [...document.scripts]) {
      const raw = script.textContent?.trim();
      if (!raw?.includes("activeCtaId") || !raw.includes(id)) continue;
      try {
        const data = JSON.parse(raw) as { cache?: Record<string, unknown> };
        const cache = data.cache;
        const product = cache?.[`Product:${id}`] as EmbeddedProduct | undefined;
        const ctaId = product?.activeCtaId;
        const cta = ctaId ? (cache?.[`GameCTA:${ctaId}`] as EmbeddedCta | undefined) : undefined;
        if (product && cta) return { segment, visiblePrimaryCta, selectableOffer, product, cta, ctaId };
      } catch {
        continue;
      }
    }

    return { segment, visiblePrimaryCta, selectableOffer, product: null, cta: null, ctaId: null };
  }, productId);

  const rawActionType = embedded.cta?.action?.type ?? embedded.cta?.type ?? null;
  const params = embedded.cta?.action?.param ?? [];
  const skuId = params.find((param) => param.name === "skuId")?.value ?? null;
  const rewardId = params.find((param) => param.name === "rewardId")?.value ?? null;
  const price = moneyFromPlayStationPrice(embedded.cta?.price ?? {});
  const evidence = [
    `primary segment: ${embedded.segment.slice(0, 500)}`,
    `visiblePrimaryCta: ${embedded.visiblePrimaryCta || "none"}`,
    `selectableOffer: ${embedded.selectableOffer ? `${embedded.selectableOffer.label} (${embedded.selectableOffer.actionType ?? "unknown"})` : "none"}`,
    `ctaId: ${embedded.ctaId ?? "none"}`,
    `rawActionType: ${rawActionType ?? "none"}`,
  ];

  return {
    productId,
    name: embedded.product?.name ?? embedded.product?.invariantName ?? (await page.title()) ?? productId,
    url: page.url(),
    action: actionFromRaw(
      rawActionType,
      embedded.cta?.type ?? null,
      embedded.segment,
      embedded.visiblePrimaryCta,
      price.isFree && price.minorUnits === 0,
      price.formatted,
      embedded.selectableOffer,
    ),
    skuId,
    rewardId,
    price,
    primaryCtaType: embedded.cta?.type ?? null,
    rawActionType,
    ineligibilityReasons: embedded.cta?.meta?.ineligibilityReasons ?? [],
    evidence,
    selectableOffer: embedded.selectableOffer ?? undefined,
  };
}
