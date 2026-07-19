import { describe, it, expect } from "vitest";
import { priceToAtomic, formatAtomic, matchRoute, InvalidPriceError } from "../src/ratecard";

describe("priceToAtomic", () => {
  it("converts dollar strings to 6-decimal atomic bigints", () => {
    expect(priceToAtomic("$0.001")).toBe(1000n);
    expect(priceToAtomic("$1")).toBe(1_000_000n);
    expect(priceToAtomic("$0.0003")).toBe(300n);
    expect(priceToAtomic("$29.99")).toBe(29_990_000n);
  });
  it("rounds sub-atomic prices to nearest unit", () => {
    expect(priceToAtomic("$0.0000015")).toBe(2n); // 1.5 -> 2
  });
  it("throws on malformed input", () => {
    expect(() => priceToAtomic("0.01")).toThrow(InvalidPriceError);   // missing $
    expect(() => priceToAtomic("$abc")).toThrow(InvalidPriceError);
    expect(() => priceToAtomic("$-1")).toThrow(InvalidPriceError);
    expect(() => priceToAtomic("$")).toThrow(InvalidPriceError);
  });
});

describe("formatAtomic", () => {
  it("formats atomic back to dollar strings", () => {
    expect(formatAtomic(1000n)).toBe("$0.001");
    expect(formatAtomic(1_000_000n)).toBe("$1");
    expect(formatAtomic(29_990_000n)).toBe("$29.99");
    expect(formatAtomic(0n)).toBe("$0");
  });
});

describe("matchRoute", () => {
  const card = { "GET /api/quote": "$0.001", "POST /api/compute": "$0.0003" };
  it("matches method+path and returns price with atomic amount", () => {
    expect(matchRoute(card, "get", "/api/quote")).toEqual({ price: "$0.001", atomic: 1000n });
    expect(matchRoute(card, "POST", "/api/compute")).toEqual({ price: "$0.0003", atomic: 300n });
  });
  it("returns null for unpriced routes", () => {
    expect(matchRoute(card, "GET", "/health")).toBeNull();
    expect(matchRoute(card, "DELETE", "/api/quote")).toBeNull();
  });
});
