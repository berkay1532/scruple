"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  useAccount,
  useChainId,
  useConnect,
  useConnections,
  useConnectors,
  useDisconnect,
  useSwitchChain,
  type Connector,
  type CreateConnectorFn,
} from "wagmi";
import { injected } from "wagmi/connectors";
import { pickWalletChoices } from "@scruple/checkout";
import { arcTestnet } from "../lib/chain";
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

/** Wallet icon with a blank-square fallback if the announced data URI fails
 * to load — mirrors `@scruple/checkout`'s WalletIcon, reimplemented here
 * with dashboard classes since WalletPicker's `sck-*` styles only ship
 * inside ScrupleCheckout's own injected <style> block. */
function WalletRowIcon({ icon }: { icon?: string }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) return <span className="wallet-pop-icon wallet-pop-icon-fallback" aria-hidden="true" />;
  return (
    <img
      className="wallet-pop-icon"
      src={icon}
      alt=""
      width={18}
      height={18}
      onError={() => setFailed(true)}
    />
  );
}

/** Connect/disconnect toggle. On connect, `pickWalletChoices` (from
 * `@scruple/checkout`, shared with the checkout widget so the dedupe rule
 * lives in one place) decides direct-connect vs. picker: "none"/"direct"
 * connect immediately (today's single-connector behavior, generic
 * `injected()` fallback for "none"); "pick" (≥2 EIP-6963-discovered
 * wallets) opens a small popover instead of silently connecting to
 * whichever extension currently owns `window.ethereum`. Gated on
 * `!isReconnecting` so wagmi's async session restore never flashes the
 * popover before snapping to the connected state. */
export function ConnectButton() {
  const { isConnected, connector: activeConnector, isReconnecting } = useAccount();
  const connectors = useConnectors();
  const connections = useConnections();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const toast = useToast();
  const [picking, setPicking] = useState(false);

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

  const choices = pickWalletChoices<Connector>(connectors);

  function connectTo(connector: Connector | CreateConnectorFn) {
    setPicking(false);
    connect({ connector, chainId: arcTestnet.id });
  }

  function handleConnectClick() {
    if (choices.mode === "pick") {
      setPicking((open) => !open);
      return;
    }
    connectTo(choices.mode === "direct" ? choices.connector : injected());
  }

  return (
    <div className="wallet-connect">
      <button
        className="btn small"
        onClick={handleConnectClick}
        disabled={isPending || isReconnecting}
      >
        {isPending ? "Connecting…" : "Connect"}
      </button>
      {picking && !isReconnecting && choices.mode === "pick" ? (
        <>
          <button
            type="button"
            className="wallet-pop-scrim"
            aria-label="Close wallet picker"
            onClick={() => setPicking(false)}
          />
          <div className="wallet-pop" role="menu">
            {choices.connectors.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                className="wallet-pop-row"
                onClick={() => connectTo(c)}
              >
                <WalletRowIcon icon={c.icon} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Warns when the connected wallet's active chain isn't Arc testnet — reads follow the wallet's chain, so on the wrong network they silently come back empty. */
function WrongNetworkPill() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const toast = useToast();

  if (!isConnected || chainId === arcTestnet.id) return null;

  async function handleSwitch() {
    try {
      await switchChainAsync({ chainId: arcTestnet.id });
    } catch {
      toast("Network switch rejected — switch to Arc Testnet in your wallet.");
    }
  }

  return (
    <span className="pill testnet">
      <span className="b" />
      Wrong network
      <button className="btn small" onClick={() => void handleSwitch()}>
        Switch to Arc
      </button>
    </span>
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
            <WrongNetworkPill />
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
