import { describe, expect, it } from "vitest";
import { cosmeticCardNumber, formatUsd, shortAddr, shortHash, timeAgo } from "../lib/format";

describe("formatUsd", () => {
  it("formats a sub-cent atomic amount from bigint", () => {
    expect(formatUsd(1000n)).toBe("$0.001");
  });

  it("formats the same amount from a numeric string", () => {
    expect(formatUsd("1000")).toBe("$0.001");
  });

  it("trims trailing fractional zeros", () => {
    expect(formatUsd(29_990_000n)).toBe("$29.99");
  });

  it("drops the decimal point entirely for a whole-dollar bigint amount", () => {
    expect(formatUsd(0n)).toBe("$0");
  });

  it("drops the decimal point entirely for a whole-dollar string amount", () => {
    expect(formatUsd("0")).toBe("$0");
  });
});

describe("shortAddr", () => {
  it("truncates an address to the first 6 and last 4 characters", () => {
    expect(shortAddr("0x2526a4Eb00000000000000000000000000d931")).toBe("0x2526…d931");
  });
});

describe("shortHash", () => {
  it("truncates a tx hash to the first 6 and last 4 characters", () => {
    expect(shortHash("0xca8f000000000000000000000000000000a7ad")).toBe("0xca8f…a7ad");
  });
});

describe("cosmeticCardNumber", () => {
  it("pads a single-digit card id into 4 groups", () => {
    expect(cosmeticCardNumber("4")).toBe("5crp 0000 0000 0004");
  });

  it("pads a multi-digit card id into 4 groups", () => {
    expect(cosmeticCardNumber("42")).toBe("5crp 0000 0000 0042");
  });
});

describe("timeAgo", () => {
  it("renders minutes-ago for a recent timestamp", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    expect(timeAgo(now - 2 * 60_000, now)).toBe("2m ago");
  });

  it("renders hours-ago for a same-day timestamp", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    expect(timeAgo(now - 3 * 60 * 60_000, now)).toBe("3h ago");
  });

  it("renders a short date once more than a day has passed", () => {
    const at = Date.UTC(2026, 6, 20, 9, 0, 0);
    const now = at + 5 * 24 * 60 * 60_000;
    expect(timeAgo(at, now)).toBe("Jul 20");
  });
});
