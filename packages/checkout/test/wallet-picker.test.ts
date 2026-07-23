import { describe, expect, it } from "vitest";
import { pickWalletChoices } from "../src/wallet-picker.js";

// The four dedupe cases from the phase-5d Global Constraints. "Generic
// injected" is the fallback connector wagmi always configures (id
// "injected"); "discovered" connectors are the per-wallet ones wagmi's
// EIP-6963 multiInjectedProviderDiscovery announces (MetaMask, Phantom, …).
const generic = { id: "injected", name: "Injected", type: "injected" };
const metamask = {
  id: "io.metamask",
  name: "MetaMask",
  type: "injected",
  icon: "data:image/svg+xml;base64,AAA=",
};
const phantom = {
  id: "app.phantom",
  name: "Phantom",
  type: "injected",
  icon: "data:image/svg+xml;base64,BBB=",
};

describe("pickWalletChoices", () => {
  it("no connectors → mode none (SSR / no wallet installed)", () => {
    expect(pickWalletChoices([])).toEqual({ mode: "none" });
  });

  it("only the generic injected connector → direct with the generic (today's single-button flow)", () => {
    expect(pickWalletChoices([generic])).toEqual({ mode: "direct", connector: generic });
  });

  it("one discovered wallet + generic injected → direct with the discovered one, generic dropped", () => {
    expect(pickWalletChoices([metamask, generic])).toEqual({ mode: "direct", connector: metamask });
  });

  it("two discovered wallets + generic injected → pick over both, generic excluded", () => {
    expect(pickWalletChoices([metamask, phantom, generic])).toEqual({
      mode: "pick",
      connectors: [metamask, phantom],
    });
  });
});
