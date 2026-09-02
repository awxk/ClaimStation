export type MoneyValue = {
  formatted: string | null;
  minorUnits: number | null;
  currencyCode: string | null;
  isFree: boolean;
};

export type Candidate = {
  source: "playstation-official" | "playstation-store" | "psdeals-page" | "platprices-api" | "platprices-page" | "manual";
  name: string;
  productId: string;
  storeUrl: string;
  platPricesUrl?: string;
  isDlc?: boolean;
  isDemoOrSoundtrack?: boolean;
  isTrial?: boolean;
  isDelisted?: boolean;
  price?: MoneyValue;
};

export type ProductCtaAction =
  | "add-to-cart"
  | "add-to-library"
  | "owned"
  | "unavailable"
  | "not-free"
  | "trial"
  | "needs-subscription"
  | "blocked"
  | "unknown";

export type ProductCtaState = {
  productId: string;
  name: string;
  url: string;
  action: ProductCtaAction;
  skuId: string | null;
  rewardId: string | null;
  price: MoneyValue;
  primaryCtaType: string | null;
  rawActionType: string | null;
  ineligibilityReasons: string[];
  evidence: string[];
  selectableOffer?: {
    label: string;
    value: string | null;
    actionType: string | null;
  };
};

export type CartLine = {
  name: string;
  priceText: string;
  isFree: boolean;
};

export type CartState = {
  totalText: string | null;
  totalMinorUnits: number | null;
  lineItems: CartLine[];
  hasPasswordPrompt: boolean;
  canConfirm: boolean;
  evidence: string[];
};

export type AuditEvent = {
  timestamp: string;
  type:
    | "candidate"
    | "product-state"
    | "action"
    | "cart-state"
    | "skip"
    | "error";
  productId?: string;
  name?: string;
  url?: string;
  action?: string;
  result?: string;
  details?: unknown;
};

export type CacheStatus =
  | "redeemed"
  | "already-owned"
  | "unavailable"
  | "not-free"
  | "trial"
  | "needs-subscription"
  | "unsupported"
  | "added-to-cart"
  | "cart-confirmed"
  | "needs-login"
  | "error";

export type CacheEntry = {
  productId: string;
  name: string;
  storeUrl: string;
  platPricesUrl?: string;
  status: CacheStatus;
  attempts: number;
  firstSeenAt: string;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastError?: string;
  revisitAfter?: string;
  details?: unknown;
};
