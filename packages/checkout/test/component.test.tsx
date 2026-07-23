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
    initialLoading: false,
    initialError: null,
    retryInitial: vi.fn(),
    connectWith: vi.fn(),
    walletChoices: { mode: "none" },
    isReconnecting: false,
    isConnected: false,
    address: undefined,
    select: vi.fn(),
    mintAndUse: vi.fn(),
    payAndSubscribe: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

// Test doubles for wagmi Connector values flowing through walletChoices —
// only the WalletChoice-shaped subset the component/picker reads.
type Connector = Extract<UseCheckoutFlowReturn["walletChoices"], { mode: "direct" }>["connector"];
const fakeConnector = (id: string, name: string, icon?: string): Connector =>
  ({ id, name, icon, type: "injected" }) as unknown as Connector;

describe("ScrupleCheckout — connect step", () => {
  it("mode none: renders today's single connect button, wired to connectWith (injected fallback)", () => {
    const connectWith = vi.fn();
    useCheckoutFlow.mockReturnValue(baseHookReturn({ connectWith, walletChoices: { mode: "none" } }));

    render(<ScrupleCheckout planId={1n} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("Connect wallet");
    fireEvent.click(buttons[0]);
    expect(connectWith).toHaveBeenCalledTimes(1);
    // The fallback must be a connector-producing function (wagmi's
    // `injected()` CreateConnectorFn), not undefined or a stale connector.
    expect(connectWith).toHaveBeenCalledWith(expect.any(Function));
  });

  it("while reconnecting: renders a disabled single connect button and NEVER the picker, even with >=2 discovered wallets", () => {
    // Regression: with ssr:true, EIP-6963 announcements land before the
    // async reconnect flips isConnected, so pick mode can be computed while
    // a previous session is still being restored — the picker must not
    // flash in that window.
    const connectWith = vi.fn();
    const metamask = fakeConnector("io.metamask", "MetaMask");
    const phantom = fakeConnector("app.phantom", "Phantom");
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        connectWith,
        walletChoices: { mode: "pick", connectors: [metamask, phantom] },
        isReconnecting: true,
      }),
    );

    const { container } = render(<ScrupleCheckout planId={1n} />);

    expect(screen.queryByText("Choose a wallet")).toBeNull();
    expect(container.querySelector(".sck-wallets")).toBeNull();
    expect(screen.queryByText("MetaMask")).toBeNull();
    expect(screen.queryByText("Phantom")).toBeNull();
    const button = screen.getByRole("button", { name: /^Connect wallet$/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("mode direct: renders exactly the same single button (no picker) and connects with THAT connector", () => {
    const connectWith = vi.fn();
    const metamask = fakeConnector("io.metamask", "MetaMask");
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({ connectWith, walletChoices: { mode: "direct", connector: metamask } }),
    );

    render(<ScrupleCheckout planId={1n} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("Connect wallet");
    expect(screen.queryByText("Choose a wallet")).toBeNull();
    expect(screen.queryByText("MetaMask")).toBeNull();
    fireEvent.click(buttons[0]);
    expect(connectWith).toHaveBeenCalledTimes(1);
    expect(connectWith).toHaveBeenCalledWith(metamask);
  });

  it("mode pick: renders one row per wallet with name + icon and connects with the clicked one", () => {
    const connectWith = vi.fn();
    const metamask = fakeConnector("io.metamask", "MetaMask", "data:image/svg+xml;base64,AAA=");
    const phantom = fakeConnector("app.phantom", "Phantom", "data:image/svg+xml;base64,BBB=");
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({ connectWith, walletChoices: { mode: "pick", connectors: [metamask, phantom] } }),
    );

    const { container } = render(<ScrupleCheckout planId={1n} />);

    expect(screen.getByText("Choose a wallet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Connect wallet$/ })).toBeNull();
    const icons = container.querySelectorAll("img.sck-wallet-icon");
    expect(icons).toHaveLength(2);
    expect((icons[0] as HTMLImageElement).getAttribute("src")).toBe("data:image/svg+xml;base64,AAA=");

    fireEvent.click(screen.getByRole("button", { name: /Phantom/ }));
    expect(connectWith).toHaveBeenCalledTimes(1);
    expect(connectWith).toHaveBeenCalledWith(phantom);
  });
});

describe("ScrupleCheckout — initial loading", () => {
  it("renders exactly one 'Loading plan…' string and nothing else in the body while initialLoading is true", () => {
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "loading" },
        plan: undefined,
        cards: [],
        initialLoading: true,
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    render(<ScrupleCheckout planId={1n} />);

    expect(screen.getAllByText("Loading plan…")).toHaveLength(1);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText("No eligible cards yet — mint one below.")).toBeNull();
    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  });

  it("keeps the header's plan summary out of the DOM while initialLoading is true, even once `plan` has resolved", () => {
    // Regression test: `plan` can resolve (getPlan/getPlanVersion settle)
    // before the card scan has settled, so `initialLoading` stays true for
    // longer than `plan` being defined. The panel must be atomic — the
    // header's amount/period/trial line must not leak ahead of the body's
    // loading skeleton.
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "loading" },
        plan: { amount: 1_000_000n, periodS: 30 * 86400, trialS: 0, merchant: "0xMerchant" },
        cards: [],
        initialLoading: true,
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    const { container } = render(<ScrupleCheckout planId={1n} />);

    expect(container.textContent).not.toContain("$1");
    expect(container.textContent).not.toContain("30 days");
    expect(screen.getAllByText("Loading plan…")).toHaveLength(1);
  });

  it("does not show the loading placeholder once initialLoading is false and the plan has resolved, even if cards arrived earlier in the same tick", () => {
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "pick" },
        plan: { amount: 29_000_000n, periodS: 30 * 86400, trialS: 0, merchant: "0xMerchant" },
        cards: [{ cardId: 4n, label: "Card #4", eligible: true }],
        initialLoading: false,
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    render(<ScrupleCheckout planId={1n} />);

    expect(screen.queryAllByText("Loading plan…")).toHaveLength(0);
    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });
});

describe("ScrupleCheckout — initial load failure", () => {
  it("renders the initialError message and a Retry button instead of the loading skeleton, and wires Retry to retryInitial()", () => {
    const retryInitial = vi.fn();
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "loading" },
        plan: undefined,
        cards: [],
        initialLoading: true,
        initialError: "Couldn't load this plan. Check your connection and try again.",
        retryInitial,
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    render(<ScrupleCheckout planId={1n} />);

    expect(screen.getByText("Couldn't load this plan. Check your connection and try again.")).toBeTruthy();
    expect(screen.queryByText("Loading plan…")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retryInitial).toHaveBeenCalledTimes(1);
  });

  it("renders the plan-invalid message from initialError (I2) the same way as any other initial-load failure", () => {
    useCheckoutFlow.mockReturnValue(
      baseHookReturn({
        state: { step: "loading" },
        plan: undefined,
        cards: [],
        initialLoading: true,
        initialError: "This plan doesn't exist or is no longer accepting subscribers.",
        isConnected: true,
        address: "0xBuyer",
      }),
    );

    render(<ScrupleCheckout planId={1n} />);

    expect(screen.getByText("This plan doesn't exist or is no longer accepting subscribers.")).toBeTruthy();
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
