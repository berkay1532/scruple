"use client";

// EIP-6963 wallet choice logic + the picker list UI. wagmi's
// `multiInjectedProviderDiscovery` (on by default) turns every
// EIP-6963-announced wallet into its own connector, alongside the generic
// `injected` fallback the config always carries. The generic fallback is the
// one that gets hijacked (Phantom impersonating MetaMask via
// window.ethereum's isMetaMask flag — the original incident behind this
// module), so whenever at least one *discovered* connector exists, the
// generic one is dropped entirely and the buyer only ever connects through a
// wallet that announced itself.
//
// `pickWalletChoices` is pure (unit-tested in test/wallet-picker.test.ts);
// `<WalletPicker/>` renders with `sck-*` classes whose CSS lives in
// component.tsx's single injected <style data-sck> block, so it styles
// correctly inside the checkout panel. Hosts that render it standalone (the
// dashboard's connect popover, Task 2) bring their own styling.
import { useState } from "react";

/** The subset of wagmi's `Connector` shape the choice logic and picker need.
 * Kept structural (rather than importing wagmi's type) so the pure helper is
 * testable with plain objects and usable against any connector-like list. */
export interface WalletChoice {
  id: string;
  name: string;
  icon?: string;
  type?: string;
}

export type WalletChoices<T extends WalletChoice = WalletChoice> =
  | { mode: "none" }
  | { mode: "direct"; connector: T }
  | { mode: "pick"; connectors: T[] };

/** True for the generic `injected` fallback connector — the one wagmi
 * configures regardless of what's installed, as opposed to a connector
 * discovered via an EIP-6963 announcement.
 * Caveat: `id !== "injected"` treats ANY configured non-generic connector
 * (e.g. walletConnect, coinbaseWallet) as "discovered" — safe today because
 * both apps configure only `injected()`, but revisit if a host ever
 * configures more. */
function isGenericInjected(c: WalletChoice): boolean {
  return c.id === "injected";
}

/** Implements the phase-5d wallet dedupe rule:
 * - no connectors → `none` (SSR, or nothing installed);
 * - only the generic injected fallback → `direct` with it (today's
 *   single-button behavior, unchanged);
 * - exactly one discovered wallet → `direct` with it, generic dropped;
 * - two or more discovered wallets → `pick` over the discovered ones only,
 *   generic excluded (it would just duplicate whichever wallet currently
 *   owns window.ethereum). */
export function pickWalletChoices<T extends WalletChoice>(connectors: readonly T[]): WalletChoices<T> {
  const discovered = connectors.filter((c) => !isGenericInjected(c));
  if (discovered.length >= 2) return { mode: "pick", connectors: discovered };
  if (discovered.length === 1) return { mode: "direct", connector: discovered[0] };
  if (connectors.length > 0) return { mode: "direct", connector: connectors[0] };
  return { mode: "none" };
}

export interface WalletPickerProps<T extends WalletChoice> {
  choices: readonly T[];
  onPick: (connector: T) => void;
}

/** The wallet's announced icon, degrading to the blank fallback square if
 * the image fails to load (a malformed/blocked data URI shouldn't leave a
 * broken-image glyph in the row). Per-row component because the failure
 * flag is per-icon state. */
function WalletIcon({ icon }: { icon?: string }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) return <span className="sck-wallet-icon sck-wallet-icon-fallback" aria-hidden="true" />;
  return (
    <img
      className="sck-wallet-icon"
      src={icon}
      alt=""
      width={20}
      height={20}
      onError={() => setFailed(true)}
    />
  );
}

/** Vertical list of wallet buttons: icon (the data URI each EIP-6963 wallet
 * announces) + name per row. Purely presentational — choosing what appears
 * here is `pickWalletChoices`' job. */
export function WalletPicker<T extends WalletChoice>({ choices, onPick }: WalletPickerProps<T>) {
  return (
    <div className="sck-wallets">
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="sck-wallet-row"
          onClick={() => onPick(choice)}
        >
          <WalletIcon icon={choice.icon} />
          <span className="sck-wallet-name">{choice.name}</span>
        </button>
      ))}
    </div>
  );
}
