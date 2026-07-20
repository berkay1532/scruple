"use client";

// Live compositions for the Cards view (My cards gallery / Activity). Ports
// docs/design/dashboard-mock.html's markup, classes, and copy 1:1 where the
// data is real. Two honest-data deviations from the mock, both because the
// underlying read doesn't exist yet: per-merchant allowlist chips (the chain
// only exposes a useAllowlist boolean, not the address list — see
// ScrupleCard's allowlistCount={null} "restricted" badge) and the Activity
// decline log (declines are enforced client-side by the payer SDK and are
// never emitted as events) — see the Task 5 report for details.
import { useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { ConnectButton, type CardsScreen } from "@/components/chrome";
import { Badge, Drawer, Panel, useToast } from "@/components/ui";
import { ScrupleCard, type CardStatus } from "@/components/scruple-card";
import type { EventRow } from "@/lib/events";
import { formatUsd, parseUsdToAtomic, shortAddr, timeAgo } from "@/lib/format";
import { useCardActions, useMyCards, type MyCard } from "@/lib/use-cards";

const DAY_S = 86_400;
const MONTH_S = 86_400 * 30;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function periodSuffix(periodDurationS: number): string {
  if (periodDurationS === DAY_S) return "day";
  if (periodDurationS === MONTH_S) return "mo";
  return `${Math.max(1, Math.round(periodDurationS / DAY_S))}d`;
}

function limitText(card: MyCard): string {
  return `${formatUsd(card.limit)}/${periodSuffix(card.periodDuration)}`;
}

function expiryLabel(expiryS: number): string {
  if (!expiryS) return "—";
  const d = new Date(expiryS * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}/${yy}`;
}

/* ================================================================ */
/* Mint card form                                                    */
/* ================================================================ */

function MintCardForm({ onDone }: { onDone: () => void }) {
  const { address } = useAccount();
  const { mint, pending } = useCardActions();
  const toast = useToast();

  const [limit, setLimit] = useState("");
  const [period, setPeriod] = useState<"day" | "month">("day");
  const [expiry, setExpiry] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [signer, setSigner] = useState(address ?? "");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const limitAtomic = parseUsdToAtomic(limit);
    if (limitAtomic === null || limitAtomic <= 0n) {
      setError("Enter a period limit greater than $0.00.");
      return;
    }

    let expiryS = 0;
    if (expiry.trim()) {
      const ms = new Date(`${expiry}T00:00:00Z`).getTime();
      if (Number.isNaN(ms)) {
        setError("Expiry date is invalid.");
        return;
      }
      expiryS = Math.floor(ms / 1000);
      if (expiryS <= Date.now() / 1000) {
        setError("Expiry must be in the future.");
        return;
      }
    }

    const allowlistEntries = allowlist
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = allowlistEntries.filter((a) => !ADDR_RE.test(a));
    if (invalid.length > 0) {
      setError(`Not a valid address: ${invalid[0]}`);
      return;
    }

    const signerTrimmed = signer.trim();
    if (!ADDR_RE.test(signerTrimmed)) {
      setError("Signer must be a valid address.");
      return;
    }

    try {
      await mint({
        periodAmount: limitAtomic,
        periodDurationS: period === "day" ? DAY_S : MONTH_S,
        expiryS,
        allowlist: allowlistEntries as `0x${string}`[],
        signer: signerTrimmed as `0x${string}`,
      });
      toast("Card mint submitted — appears after confirmation.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed.");
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 className="serif">Mint card</h2>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Period limit (USD)</span>
        <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="2.00" inputMode="decimal" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Period</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value as "day" | "month")}>
          <option value="day">Daily</option>
          <option value="month">Monthly</option>
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Expiry (optional)</span>
        <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Allowed merchants (optional — one address per line, blank = open)</span>
        <textarea
          value={allowlist}
          onChange={(e) => setAllowlist(e.target.value)}
          rows={3}
          placeholder="0x…"
          className="mono"
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Signer</span>
        <input value={signer} onChange={(e) => setSigner(e.target.value)} className="mono" />
      </label>
      {error && <p className="empty-note" style={{ color: "var(--bad)" }}>{error}</p>}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Confirm in wallet…" : "Mint card"}
      </button>
    </form>
  );
}

/* ================================================================ */
/* Card detail drawer                                                */
/* ================================================================ */

function CardDetail({ card, onClosed }: { card: MyCard; onClosed: () => void }) {
  const { freeze, unfreeze, cancel, pending } = useCardActions();
  const toast = useToast();
  const [status, setStatus] = useState<CardStatus>(card.status);

  async function handleToggle() {
    const wasActive = status === "active";
    setStatus(wasActive ? "frozen" : "active");
    try {
      if (wasActive) {
        await freeze(card.cardId);
        toast("Card frozen — all charges will decline");
      } else {
        await unfreeze(card.cardId);
        toast("Card active again");
      }
    } catch (err) {
      setStatus(wasActive ? "active" : "frozen");
      toast(err instanceof Error ? err.message : "Transaction failed.");
    }
  }

  async function handleCancel() {
    if (!window.confirm("Cancel this card permanently? This cannot be undone.")) return;
    try {
      await cancel(card.cardId);
      toast("Card cancel submitted — appears after confirmation.");
      onClosed();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Transaction failed.");
    }
  }

  const badgeTone = status === "active" ? "ok" : status === "frozen" ? "mut" : "bad";

  return (
    <>
      <h2 className="serif">{card.label}</h2>
      <div className="kv">
        <div className="k">Status</div>
        <div>
          <Badge tone={badgeTone}>{status}</Badge>
        </div>
        <div className="k">Number</div>
        <div className="mono">#{card.cardId}</div>
        <div className="k">Period limit</div>
        <div>{limitText(card)}</div>
        <div className="k">Spent</div>
        <div>{formatUsd(card.spent)}</div>
        <div className="k">Expiry</div>
        <div>{expiryLabel(card.expiry)}</div>
        <div className="k">Allowlist</div>
        <div>
          <Badge tone={card.allowlisted ? "info" : "mut"}>{card.allowlisted ? "restricted" : "open"}</Badge>
        </div>
      </div>

      {status !== "cancelled" && (
        <button className="toggle" aria-pressed={status !== "active"} onClick={handleToggle} disabled={pending}>
          <span className="sw" />
          <span className="tl">
            {status === "active" ? "Freeze card" : "Unfreeze card"}
            <small>Blocks every future charge instantly. Reversible.</small>
          </span>
        </button>
      )}

      {status !== "cancelled" && (
        <button className="danger-link" onClick={handleCancel} disabled={pending}>
          Cancel card permanently…
        </button>
      )}
    </>
  );
}

/* ================================================================ */
/* Gallery                                                            */
/* ================================================================ */

function Gallery({ events }: { events: EventRow[] }) {
  const { cards, isLoading } = useMyCards(events);
  const [mintOpen, setMintOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = cards.find((c) => c.cardId === selectedId) ?? null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div>
          <h1>My cards</h1>
          <p className="sub">Scoped, limited, revocable — approve nothing blindly.</p>
        </div>
        <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => setMintOpen(true)}>
          Mint card
        </button>
      </div>

      {cards.length === 0 ? (
        <p className="empty-note">
          {isLoading ? "Loading your cards…" : "No cards yet — mint one to start scoping agent or personal spend."}
        </p>
      ) : (
        <>
          <div className="cards-grid">
            {cards.map((c) => (
              <ScrupleCard
                key={c.cardId}
                label={c.label}
                cardId={c.cardId}
                limitText={limitText(c)}
                spent={c.spent}
                limit={c.limit}
                expiry={expiryLabel(c.expiry)}
                status={c.status}
                allowlistCount={c.allowlisted ? null : 0}
                onClick={() => setSelectedId(c.cardId)}
              />
            ))}
          </div>
          <p className="empty-note">Tap a card for details, limits, and the freeze switch.</p>
        </>
      )}

      <Drawer open={mintOpen} onClose={() => setMintOpen(false)}>
        {mintOpen && <MintCardForm onDone={() => setMintOpen(false)} />}
      </Drawer>

      <Drawer open={selected !== null} onClose={() => setSelectedId(null)}>
        {selected && <CardDetail key={selected.cardId} card={selected} onClosed={() => setSelectedId(null)} />}
      </Drawer>
    </>
  );
}

/* ================================================================ */
/* Activity                                                           */
/* ================================================================ */

interface ActivityRow {
  id: string;
  at: number;
  card: string;
  merchant: string;
  what: string;
  amount: string;
  result: "paid";
}

function Activity({ events }: { events: EventRow[] }) {
  const { address } = useAccount();

  const subInfo = useMemo(() => {
    const map = new Map<string, { customer: string; cardId: string; planId: string }>();
    for (const e of events) {
      if (e.type !== "subscription.created") continue;
      map.set(e.payload.subId, { customer: e.payload.customer, cardId: e.payload.cardId, planId: e.payload.planId });
    }
    return map;
  }, [events]);

  const merchantByPlan = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.type !== "plan.created") continue;
      map.set(e.payload.planId, e.payload.merchant);
    }
    return map;
  }, [events]);

  const rows = useMemo<ActivityRow[]>(() => {
    if (!address) return [];
    const target = address.toLowerCase();
    const out: ActivityRow[] = [];
    for (const e of events) {
      if (e.type === "payment.succeeded") {
        const info = subInfo.get(e.payload.subId);
        if (!info || info.customer.toLowerCase() !== target) continue;
        const merchant = merchantByPlan.get(info.planId);
        out.push({
          id: e.id,
          at: e.at,
          card: `Card #${info.cardId}`,
          merchant: merchant ? shortAddr(merchant) : "—",
          what: `Plan #${info.planId} · subscription charge`,
          amount: e.payload.amount ?? "0",
          result: "paid",
        });
      } else if (e.type === "settlement.batched") {
        if ((e.payload.payer ?? "").toLowerCase() !== target) continue;
        out.push({
          id: e.id,
          at: e.at,
          card: "—",
          merchant: "—",
          what: e.payload.endpoint ?? "metered call",
          amount: e.payload.atomic ?? "0",
          result: "paid",
        });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [events, address, subInfo, merchantByPlan]);

  const nowMs = Date.now();

  return (
    <>
      <div>
        <h1>Activity</h1>
        <p className="sub">Everything your cards paid</p>
      </div>
      <Panel>
        {rows.length === 0 ? (
          <p className="empty-note">No activity yet — payments made with your cards will show up here.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Card</th>
                <th>Merchant</th>
                <th>What</th>
                <th className="num">Amount</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{timeAgo(r.at, nowMs)}</td>
                  <td>{r.card}</td>
                  <td className="mono">{r.merchant}</td>
                  <td className="mono">{r.what}</td>
                  <td className="num mono">{formatUsd(r.amount)}</td>
                  <td>
                    <Badge tone="ok">{r.result}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="empty-note">
        Declines are enforced client-side by the payer SDK before a request ever reaches the merchant, so they
        aren&apos;t recorded as on-chain or service events — this feed shows successful payments only.
      </p>
    </>
  );
}

/* ================================================================ */

export function Cards({ screen, events }: { screen: CardsScreen; events: EventRow[] }) {
  const { isConnected } = useAccount();

  if (!isConnected) {
    return (
      <Panel>
        <h2>Connect a wallet to see your cards.</h2>
        <p className="sub" style={{ marginBottom: 14 }}>
          Cards are scoped to the connected wallet — mint, freeze, and spend history all read from your address.
        </p>
        <ConnectButton />
      </Panel>
    );
  }

  return screen === "gallery" ? <Gallery events={events} /> : <Activity events={events} />;
}
