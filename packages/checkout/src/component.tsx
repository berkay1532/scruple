"use client";

// The panel UI for the checkout embed. This is a thin renderer over
// `useCheckoutFlow` — every transition, chain read, and write lives in the
// hook (see use-checkout.ts); this file only maps `state.step` to markup and
// wires the hook's callbacks to buttons. Styles are entirely self-contained
// (one injected <style data-sck>, every class `sck-*`) so the panel keeps
// its own dark-ink/brass identity regardless of the host page's theme or
// stylesheet — see the plan's "self-contained panel surface" requirement.
import { useEffect, useRef } from "react";
import { formatUsd } from "./logic.js";
import { useCheckoutFlow, type UseCheckoutFlowOptions } from "./use-checkout.js";

export interface ScrupleCheckoutSuccess {
  subId: bigint;
}

export interface ScrupleCheckoutProps {
  planId: bigint;
  addresses?: UseCheckoutFlowOptions["addresses"];
  onSuccess?: (info: ScrupleCheckoutSuccess) => void;
  onError?: (message: string) => void;
}

const STYLE_MARKER = "data-sck";

/** Injects the panel's stylesheet into <head> exactly once per document,
 * even across multiple <ScrupleCheckout/> instances on the same page —
 * guarded by checking for an already-present `<style data-sck>` node rather
 * than a module-level flag, so it also works across separate bundles (e.g.
 * two copies of this package pulled in by different host dependencies). */
function injectStylesOnce(): void {
  if (typeof document === "undefined") return;
  if (document.head.querySelector(`style[${STYLE_MARKER}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARKER, "");
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

function formatDays(periodS: number): number {
  return Math.round(periodS / 86400);
}

const BUSY_STEPS = new Set(["minting", "approving", "subscribing"]);

export function ScrupleCheckout({ planId, addresses, onSuccess, onError }: ScrupleCheckoutProps) {
  injectStylesOnce();

  const { state, plan, cards, connect, isConnected, select, mintAndUse, payAndSubscribe, reset } = useCheckoutFlow({
    planId,
    addresses,
  });

  // Fire onSuccess/onError exactly once per entry into "done"/"error" — a
  // ref guard rather than relying on the parent not to re-render, since
  // react-query cache updates or unrelated prop changes can re-render this
  // component many times while state.step stays "done"/"error".
  const successFiredRef = useRef(false);
  const errorFiredRef = useRef(false);

  useEffect(() => {
    if (state.step === "done" && state.subId !== undefined && !successFiredRef.current) {
      successFiredRef.current = true;
      onSuccess?.({ subId: state.subId });
    }
    if (state.step !== "done") successFiredRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step, state.subId]);

  useEffect(() => {
    if (state.step === "error" && !errorFiredRef.current) {
      errorFiredRef.current = true;
      onError?.(state.error ?? "Something went wrong.");
    }
    if (state.step !== "error") errorFiredRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step, state.error]);

  const busy = BUSY_STEPS.has(state.step);
  const days = plan ? formatDays(plan.periodS) : undefined;
  const trialDays = plan && plan.trialS > 0 ? formatDays(plan.trialS) : 0;

  return (
    <div className="sck-panel">
      <header className="sck-header">
        <div className="sck-brand">
          <span className="sck-glyph">⚖</span>
          <span className="sck-name">Scruple</span>
        </div>
        {plan ? (
          <div className="sck-plan-summary">
            <span className="sck-amount">{formatUsd(plan.amount)}</span>
            <span className="sck-sep">/</span>
            <span className="sck-period">{days} days</span>
            {trialDays > 0 ? <p className="sck-trial">{trialDays}-day trial included</p> : null}
          </div>
        ) : (
          <p className="sck-loading-summary">Loading plan…</p>
        )}
      </header>

      <div className="sck-body">
        {state.step === "connect" ? (
          <button type="button" className="sck-btn sck-btn-primary" onClick={connect}>
            Connect wallet
          </button>
        ) : null}

        {state.step === "loading" ? <p className="sck-status">Loading plan…</p> : null}

        {state.step === "pick" || busy ? (
          <div className="sck-pick">
            <div className="sck-cards" role="radiogroup" aria-label="Your cards">
              {cards.length === 0 ? <p className="sck-empty">No eligible cards yet — mint one below.</p> : null}
              {cards.map((card) => (
                <label key={card.cardId.toString()} className={`sck-card-row${card.eligible ? "" : " sck-disabled"}`}>
                  <input
                    type="radio"
                    name="sck-card"
                    role="radio"
                    aria-label={card.label}
                    disabled={!card.eligible || busy}
                    checked={state.selectedCardId === card.cardId}
                    onChange={() => select(card.cardId)}
                  />
                  <span className="sck-card-label">
                    {card.label} — {card.eligible ? "eligible" : "not eligible for this plan"}
                  </span>
                </label>
              ))}
            </div>

            <button type="button" className="sck-btn sck-btn-ghost" onClick={mintAndUse} disabled={busy}>
              or mint a new card for this plan
            </button>

            <button
              type="button"
              className="sck-btn sck-btn-primary"
              onClick={payAndSubscribe}
              disabled={busy || state.selectedCardId === undefined}
            >
              Subscribe
            </button>

            {busy ? (
              <div className="sck-progress" role="status">
                <span className="sck-spinner" aria-hidden="true" />
                <p>Confirm in wallet…</p>
                <p className="sck-muted">Waiting for Arc…</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {state.step === "done" ? (
          <div className="sck-done">
            <span className="sck-check" aria-hidden="true">
              ✓
            </span>
            <p>Subscribed — sub #{state.subId?.toString()}</p>
          </div>
        ) : null}

        {state.step === "error" ? (
          <div className="sck-error">
            <p>{state.error ?? "Something went wrong."}</p>
            <button type="button" className="sck-btn sck-btn-primary" onClick={reset}>
              Retry
            </button>
          </div>
        ) : null}
      </div>

      <footer className="sck-footer">
        <p>Powered by ⚖ Scruple · non-custodial — funds move wallet-to-wallet</p>
        {state.step === "approving" ? <p className="sck-disclosure">Allows the next 12 renewals — revoke anytime.</p> : null}
      </footer>
    </div>
  );
}

const PANEL_CSS = `
.sck-panel {
  all: initial;
  box-sizing: border-box;
  display: block;
  max-width: 380px;
  width: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #E8E6E1;
  background: #12161D;
  border: 1px solid #242B36;
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px rgba(0,0,0,.35);
}
.sck-panel *, .sck-panel *::before, .sck-panel *::after { box-sizing: border-box; }
.sck-panel button { font: inherit; }
.sck-header { display: flex; flex-direction: column; gap: 10px; }
.sck-brand { display: flex; align-items: baseline; gap: 6px; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
.sck-glyph { color: #C9A96A; font-size: 16px; }
.sck-name { font-size: 15px; color: #E8E6E1; letter-spacing: .2px; }
.sck-plan-summary { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.sck-amount { font-size: 22px; font-weight: 600; color: #E8E6E1; }
.sck-sep { color: #6A7180; }
.sck-period { font-size: 14px; color: #9BA1AC; }
.sck-trial { flex-basis: 100%; margin: 2px 0 0; font-size: 12.5px; color: #C9A96A; }
.sck-loading-summary { margin: 0; color: #9BA1AC; font-size: 13px; }
.sck-body { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
.sck-status { margin: 0; color: #9BA1AC; font-size: 13px; }
.sck-pick { display: flex; flex-direction: column; gap: 10px; }
.sck-cards { display: flex; flex-direction: column; gap: 6px; }
.sck-empty { margin: 0; color: #6A7180; font-size: 12.5px; }
.sck-card-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid #242B36; border-radius: 9px; cursor: pointer; }
.sck-card-row.sck-disabled { cursor: not-allowed; opacity: .5; }
.sck-card-label { font-size: 13px; color: #E8E6E1; }
.sck-btn { border: 1px solid #242B36; border-radius: 8px; padding: 9px 14px; font-weight: 500; color: #E8E6E1; background: none; cursor: pointer; text-align: center; }
.sck-btn:disabled { opacity: .5; cursor: not-allowed; }
.sck-btn-primary { background: #C9A96A; border-color: #C9A96A; color: #14110A; }
.sck-btn-ghost { color: #C9A96A; border-style: dashed; }
.sck-progress { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 0; text-align: center; }
.sck-progress p { margin: 0; font-size: 13px; }
.sck-muted { color: #6A7180; font-size: 12px !important; }
.sck-spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #242B36; border-top-color: #C9A96A; animation: sck-spin .8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .sck-spinner { animation: none; } }
@keyframes sck-spin { to { transform: rotate(360deg); } }
.sck-done { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 0; text-align: center; }
.sck-check { font-size: 26px; color: #4CAF82; }
.sck-error { display: flex; flex-direction: column; gap: 10px; text-align: center; }
.sck-error p { margin: 0; color: #D96C5F; font-size: 13px; }
.sck-footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid #242B36; }
.sck-footer p { margin: 0; font-size: 11px; color: #6A7180; }
.sck-disclosure { margin-top: 4px !important; color: #C9A96A !important; }
`;
