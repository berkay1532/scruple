"use client";

import type { ReactNode } from "react";
import { useAccount } from "wagmi";

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

/**
 * useAccount() throws WagmiProviderNotFoundError if rendered outside a
 * WagmiProvider. Task 4 wires the real WagmiProvider into
 * components/providers.tsx; until then this falls back to "—". The hook is
 * still called unconditionally on every render (only its synchronous throw,
 * which happens before any further hooks run inside useAccount, is caught),
 * so this does not violate the rules of hooks.
 */
function AddressPill() {
  let address: string | undefined;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    ({ address } = useAccount());
  } catch {
    address = undefined;
  }
  return <span className="addr mono">{address ? shortenAddress(address) : "—"}</span>;
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
