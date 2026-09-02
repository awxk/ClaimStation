import { describe, expect, it } from "vitest";
import { isCartFrameUnavailableError } from "./cart.js";

describe("cart error handling", () => {
  it("recognizes PlayStation checkout iframe read timeouts", () => {
    const error = new Error(
      `locator.innerText: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('iframe[name="embeddedcart"]').contentFrame().locator('body')`,
    );

    expect(isCartFrameUnavailableError(error)).toBe(true);
  });

  it("does not classify unrelated errors as cart frame failures", () => {
    expect(isCartFrameUnavailableError(new Error("Cart total is not zero"))).toBe(false);
  });
});
