// Regression: the plan query needs no wallet, so it can resolve while the
// reducer is still on "connect" (SSR session-restore window). The early
// planLoaded dispatch is ignored in that state, and — before the fix — the
// [plan]-keyed effect never re-fired after "connected" moved the step to
// "loading", leaving the panel stuck (plan header rendered, body empty).
// Live-caught on the deployed Acme checkout.
import { describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const wagmiState = {
  isConnected: false,
  planRaw: undefined as undefined | Record<string, unknown>,
  versionRaw: undefined as undefined | Record<string, unknown>,
};

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: wagmiState.isConnected ? "0x75dca3CA1CEbb69cA7381C200491C4b03131C3d4" : undefined,
    isConnected: wagmiState.isConnected,
    isReconnecting: false,
  }),
  useConnect: () => ({ connect: vi.fn() }),
  useConnectors: () => [],
  usePublicClient: () => undefined,
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useReadContract: (opts: { functionName: string }) => {
    if (opts.functionName === "getPlan") {
      return {
        data: wagmiState.planRaw,
        status: wagmiState.planRaw ? "success" : "pending",
        refetch: vi.fn(),
      };
    }
    if (opts.functionName === "getPlanVersion") {
      return {
        data: wagmiState.versionRaw,
        status: wagmiState.versionRaw ? "success" : "pending",
        refetch: vi.fn(),
      };
    }
    // nextCardId — settled so the card scan resolves to "no cards".
    return { data: 0n, status: "success", refetch: vi.fn() };
  },
  useReadContracts: () => ({ data: [], status: "success", refetch: vi.fn() }),
}));
vi.mock("wagmi/connectors", () => ({ injected: () => (() => ({})) as unknown }));

import { useCheckoutFlow } from "../src/use-checkout.js";

const PLAN_RAW = {
  merchant: "0x2526a4Ebc2FFa3caE58F0861FfD78027fc86d931",
  token: "0x3600000000000000000000000000000000000000",
  latestVersion: 0n,
  active: true,
};
const VERSION_RAW = { amount: 1_000_000n, period: 2_592_000n, trialPeriod: 0n };

describe("plan-before-connect ordering", () => {
  it("advances to pick when the plan resolves before the wallet connects", async () => {
    wagmiState.isConnected = false;
    wagmiState.planRaw = undefined;
    wagmiState.versionRaw = undefined;

    const { result, rerender } = renderHook(() => useCheckoutFlow({ planId: 0n }));
    expect(result.current.state.step).toBe("connect");

    // Plan resolves while still disconnected — the planLoaded dispatch is
    // ignored by the reducer in the "connect" step.
    act(() => {
      wagmiState.planRaw = PLAN_RAW;
      wagmiState.versionRaw = VERSION_RAW;
    });
    rerender();
    expect(result.current.state.step).toBe("connect");

    // Wallet (re)connect completes afterwards. Without the step-keyed
    // effect dependency this stuck at "loading" forever.
    act(() => {
      wagmiState.isConnected = true;
    });
    rerender();

    await waitFor(() => expect(result.current.state.step).toBe("pick"));
  });
});
