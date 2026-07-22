import { describe, expect, it } from "vitest";
import {
  cosmeticCardNumber,
  formatDate,
  formatUsd,
  parseUsdToAtomic,
  shortAddr,
  shortEventId,
  shortHash,
  shortUrl,
  timeAgo,
  timeUntil,
} from "../lib/format";

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

describe("shortEventId", () => {
  it("shortens the tx-hash half of a txHash:logIndex id but passes short synthetic ids through", () => {
    expect(shortEventId("0xca8f7227b0d0c20c6c693e07bceac143b967227285f3b44f1d5e759b6d1ea7ad:9")).toBe("0xca8f…:9");
    expect(shortEventId("metered:u-88a2")).toBe("metered:u-88a2");
  });
});

describe("shortUrl", () => {
  it("strips the scheme and truncates long URLs with an ellipsis", () => {
    expect(shortUrl("https://short.dev/hooks")).toBe("short.dev/hooks");
    expect(shortUrl("https://api.a-very-long-domain-name.example.com/scruple/webhooks")).toBe(
      "api.a-very-long-domain-name.examp…",
    );
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

describe("timeUntil", () => {
  it("renders minutes-until for a near-future timestamp", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    expect(timeUntil(now + 5 * 60_000, now)).toBe("in 5m");
  });

  it("renders hours-until for a same-day future timestamp", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    expect(timeUntil(now + 2 * 60 * 60_000, now)).toBe("in 2h");
  });

  it("falls back to timeAgo for a past timestamp", () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0);
    expect(timeUntil(now - 2 * 60_000, now)).toBe(timeAgo(now - 2 * 60_000, now));
  });
});

describe("formatDate", () => {
  it("renders a full UTC date from a unix-seconds timestamp", () => {
    const atS = Date.UTC(2026, 7, 19, 12, 0, 0) / 1000;
    expect(formatDate(atS)).toBe("Aug 19, 2026");
  });

  it("renders the epoch as Jan 1, 1970", () => {
    expect(formatDate(0)).toBe("Jan 1, 1970");
  });
});

describe("parseUsdToAtomic", () => {
  it("parses a whole-dollar amount", () => {
    expect(parseUsdToAtomic("29")).toBe(29_000_000n);
  });

  it("parses a fractional amount, padding to 6 decimals", () => {
    expect(parseUsdToAtomic("29.5")).toBe(29_500_000n);
  });

  it("parses a full 6-decimal amount", () => {
    expect(parseUsdToAtomic("0.001")).toBe(1_000n);
  });

  it("parses zero", () => {
    expect(parseUsdToAtomic("0")).toBe(0n);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseUsdToAtomic("  29.00  ")).toBe(29_000_000n);
  });

  it("rejects an empty string", () => {
    expect(parseUsdToAtomic("")).toBeNull();
  });

  it("rejects a negative amount", () => {
    expect(parseUsdToAtomic("-1")).toBeNull();
  });

  it("rejects more than 6 fractional digits", () => {
    expect(parseUsdToAtomic("1.1234567")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseUsdToAtomic("abc")).toBeNull();
  });

  it("rejects multiple decimal points", () => {
    expect(parseUsdToAtomic("1.2.3")).toBeNull();
  });
});
