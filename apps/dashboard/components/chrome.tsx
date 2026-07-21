"use client";

import { useEffect, type ReactNode } from "react";
import { useAccount, useConnect, useConnections, useConnectors, useDisconnect } from "wagmi";
import { useToast } from "./ui";

export type View = "merchant" | "cards";
export type MerchantScreen = "overview" | "plans" | "subs" | "payments" | "webhooks";
export type CardsScreen = "gallery" | "activity";
export type Screen = MerchantScreen | CardsScreen;

const MERCHANT_ITEMS: { id: MerchantScreen; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plans", label: "Rate cards & plans" },
  { id: "subs", label: "Subscriptions" },
  { id: "payments", label: "Payments" },
  { id: "webhooks", label: "Webhooks" },
];

const CARDS_ITEMS: { id: CardsScreen; label: string }[] = [
  { id: "gallery", label: "My cards" },
  { id: "activity", label: "Activity" },
];

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function AddressPill() {
  const { address } = useAccount();
  return <span className="addr mono">{address ? shortenAddress(address) : "—"}</span>;
}

/** Injected-connector connect/disconnect toggle. MVP has no wallet picker — one connector. */
export function ConnectButton() {
  const { isConnected, connector: activeConnector } = useAccount();
  const connectors = useConnectors();
  const connections = useConnections();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const toast = useToast();

  // wagmi's `connect` (the mutate-style variant) doesn't throw or return a
  // promise — it reports failures (rejected in wallet, no connector, wrong
  // chain, ...) via this `error` state instead. Surface it as a toast so a
  // failed connect isn't silent.
  useEffect(() => {
    if (error) toast(error.message || "Connection failed.");
  }, [error, toast]);

  async function switchAccount() {
    const connector = activeConnector ?? connections[0]?.connector;
    try {
      const provider = (await connector?.getProvider?.()) as
        | { request?: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
        | undefined;
      await provider?.request?.({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    } catch {
      toast("Account switch cancelled or unsupported — switch accounts in your wallet extension instead.");
    }
  }

  if (isConnected) {
    return (
      <>
        <button className="btn small" onClick={() => disconnect()}>
          Disconnect
        </button>
        <button className="btn small" onClick={() => void switchAccount()}>
          Switch
        </button>
      </>
    );
  }

  const connector = connectors[0];
  return (
    <button
      className="btn small"
      onClick={() => connector && connect({ connector })}
      disabled={isPending || !connector}
    >
      {isPending ? "Connecting…" : "Connect"}
    </button>
  );
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const cur = root.getAttribute("data-theme") || (dark ? "dark" : "light");
  root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
}

export function Chrome({
  view,
  onViewChange,
  screen,
  onScreenChange,
  children,
}: {
  view: View;
  onViewChange: (view: View) => void;
  screen: Screen;
  onScreenChange: (screen: Screen) => void;
  children?: ReactNode;
}) {
  return (
    <div className="app">
      {/* ======== SIDEBAR ======== */}
      <nav className="sidebar" aria-label="Main">
        <div className="wordmark serif">
          <span className="glyph">⚖</span>
          <span className="name">Scruple</span>
        </div>

        <div data-side="merchant" hidden={view !== "merchant"}>
          <div className="nav-label">Merchant</div>
          {MERCHANT_ITEMS.map((item) => (
            <button
              key={item.id}
              className="nav-item"
              aria-current={screen === item.id ? "true" : "false"}
              onClick={() => onScreenChange(item.id)}
            >
              <span className="dot" />
              {item.label}
            </button>
          ))}
        </div>
        <div data-side="cards" hidden={view !== "cards"}>
          <div className="nav-label">Cards</div>
          {CARDS_ITEMS.map((item) => (
            <button
              key={item.id}
              className="nav-item"
              aria-current={screen === item.id ? "true" : "false"}
              onClick={() => onScreenChange(item.id)}
            >
              <span className="dot" />
              {item.label}
            </button>
          ))}
        </div>

        <div className="foot serif">
          the smallest payment,
          <br />
          measured exactly.
        </div>
      </nav>

      {/* ======== MAIN ======== */}
      <div className="main">
        <header className="topbar">
          <div className="seg" role="group" aria-label="View">
            <button aria-pressed={view === "merchant"} onClick={() => onViewChange("merchant")}>
              Merchant
            </button>
            <button aria-pressed={view === "cards"} onClick={() => onViewChange("cards")}>
              Cards
            </button>
          </div>
          <div className="net">
            <span className="pill testnet">
              <span className="b" />
              Arc Testnet
            </span>
            <AddressPill />
            <ConnectButton />
            <button className="theme-btn" onClick={toggleTheme}>
              Theme
            </button>
          </div>
        </header>

        <div className="content">{children}</div>
      </div>
    </div>
  );
}
