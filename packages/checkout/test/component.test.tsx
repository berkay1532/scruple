import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UseCheckoutFlowReturn } from "../src/use-checkout.js";

const useCheckoutFlow = vi.fn<(...args: unknown[]) => UseCheckoutFlowReturn>();

vi.mock("../src/use-checkout.js", () => ({
  useCheckoutFlow: (...args: unknown[]) => useCheckoutFlow(...args),
}));

// Imported after the mock so the component picks up the mocked hook.
const { ScrupleCheckout } = await import("../src/component.js");

afterEach(() => {
  cleanup();
  useCheckoutFlow.mockReset();
});

function baseHookReturn(overrides: Partial<UseCheckoutFlowReturn> = {}): UseCheckoutFlowReturn {
  return {
    state: { step: "connect" },
    plan: undefined,
    cards: [],
    connect: vi.fn(),
    isConnected: false,
    address: undefined,
    select: vi.fn(),
    mintAndUse: vi.fn(),
    payAndSubscribe: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

describe("ScrupleCheckout — connect step", () => {
  it("renders a connect button that calls connect()", () => {
    const connect = vi.fn();
    useCheckoutFlow.mockReturnValue(baseHookReturn({ connect }));

    render(<ScrupleCheckout planId={1n} />);

    const button = screen.getByRole("button", { name: /connect/i });
    fireEvent.click(button);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("ScrupleCheckout — pick step", () => {
  it("renders the plan summary, eligible/ineligible card rows, and the 'or mint' button when cards exist", () => {
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "pick" },
        plan: { amount: 29_000_000n, periodS: 30 * 86400, trialS: 0, merchant: "0xMerchant" },
        cards: [
          { cardId: 4n, label: "Card #4", eligible: true },
          { cardId: 2n, label: "Card #2", eligible: false },
        ],
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    const { container } = render(<ScrupleCheckout planId={1n} />);

    expect(container.textContent).toContain("$29");
    expect(container.textContent).toContain("30 days");

    const eligibleRow = screen.getByRole("radio", { name: /Card #4/ }) as HTMLInputElement;
    expect(eligibleRow.disabled).toBe(false);

    const ineligibleRow = screen.getByRole("radio", { name: /Card #2/ }) as HTMLInputElement;
    expect(ineligibleRow.disabled).toBe(true);
    expect(container.textContent).toContain("not eligible for this plan");

    expect(screen.getByRole("button", { name: /or mint a new card for this plan/i })).toBeTruthy();
  });

  it("renders the empty-cards helper text and the standalone mint button when there are no cards yet", () => {
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "pick" },
        plan: { amount: 29_000_000n, periodS: 30 * 86400, trialS: 0, merchant: "0xMerchant" },
        cards: [],
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    const { container } = render(<ScrupleCheckout planId={1n} />);

    expect(container.textContent).toContain("No eligible cards yet — mint one below.");
    expect(screen.getByRole("button", { name: /^Mint a new card for this plan$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^or mint a new card for this plan$/i })).toBeNull();
  });
});

describe("ScrupleCheckout — done step", () => {
  it("renders the subId and fires onSuccess exactly once", () => {
    const onSuccess = vi.fn();
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "done", subId: 7n, selectedCardId: 4n },
        plan: { amount: 29_000_000n, periodS: 30 * 86400, trialS: 0, merchant: "0xMerchant" },
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    const { container, rerender } = render(<ScrupleCheckout planId={1n} onSuccess={onSuccess} />);

    expect(container.textContent).toContain("7");
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({ subId: 7n });

    // A rerender caused by unrelated hook state churn must not re-fire onSuccess.
    rerender(<ScrupleCheckout planId={1n} onSuccess={onSuccess} />);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("ScrupleCheckout — error step", () => {
  it("renders the error message and calls reset() when retry is clicked", () => {
    const reset = vi.fn();
    const onError = vi.fn();
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "error", error: "Request cancelled in wallet." },
        plan: { amount: 29_000_000n, periodS: 30 * 86400, trialS: 0, merchant: "0xMerchant" },
        isConnected: true,
        address: "0xBuyer",
        reset,
      }),
    );

    render(<ScrupleCheckout planId={1n} onError={onError} />);

    expect(screen.getByText("Request cancelled in wallet.")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Request cancelled in wallet.");

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
