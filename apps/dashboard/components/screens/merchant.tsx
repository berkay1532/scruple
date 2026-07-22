"use client";

// Live compositions for the Merchant view (Overview / Plans / Subscriptions /
// Payments / Webhooks). Ports docs/design/dashboard-mock.html's markup,
// classes, and copy 1:1 where the data is real; where the mock invents data
// this app can't honestly produce (metered rate card pricing, plan version
// history, subscriber nudge/reminder actions) the section is trimmed rather
// than faked — see the phase report for the full list of deviations. The
// Webhooks screen is live against the service's /admin API (Phase 5b) via
// the /api/admin proxy: endpoint CRUD + pause/resume + secret rotate, and a
// deliveries table with Resend.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import type { MerchantScreen } from "@/components/chrome";
import { Badge, Drawer, Panel, useToast } from "@/components/ui";
import { RevChart } from "@/components/rev-chart";
import {
  feedDesc,
  feedTone,
  needsAttention,
  revenueByDay,
  revenueTotalAtomic,
  scopedFeedEvents,
  scopedPaymentEvents,
  scopeToMerchant,
  type EventRow,
} from "@/lib/events";
import {
  formatDate,
  formatUsd,
  parseUsdToAtomic,
  shortAddr,
  shortEventId,
  shortHash,
  shortUrl,
  timeAgo,
  timeUntil,
} from "@/lib/format";
import { useMerchant, type MerchantPlan, type MerchantSub } from "@/lib/use-merchant";
import {
  createEndpoint,
  deleteEndpoint,
  resendDelivery,
  rotateEndpointSecret,
  setEndpointPaused,
  useAdmin,
  type AdminDelivery,
  type AdminEndpoint,
} from "@/lib/use-admin";

const DAY_MS = 24 * 60 * 60_000;
const ARC_TX_URL = "https://testnet.arcscan.app/tx/";

function periodDaysLabel(periodS: number): string {
  const days = Math.round(periodS / 86_400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

const EMPTY_SUB_IDS: ReadonlySet<string> = new Set();
const EMPTY_PLAN_IDS: ReadonlySet<string> = new Set();

/* ================================================================ */
/* Overview                                                          */
/* ================================================================ */

function Overview({ events }: { events: EventRow[] }) {
  const { subs } = useMerchant(events);
  const { address } = useAccount();
  const nowMs = Date.now();

  // The events feed is shared across every merchant on this one contract
  // deployment (createPlan records merchant=msg.sender; the service indexes
  // all events), so revenue and attention rows below must be narrowed to
  // this merchant's own plans/subs before display — see lib/events.ts's
  // `scopeToMerchant` for the join and its subId-uniqueness caveat.
  const myScope = useMemo(
    () => (address ? scopeToMerchant(events, address) : null),
    [events, address],
  );
  const myPlanIds = myScope?.planIds ?? EMPTY_PLAN_IDS;
  const mySubIds = myScope?.subIds ?? EMPTY_SUB_IDS;

  const myPaymentEvents = useMemo(() => scopedPaymentEvents(events, mySubIds), [events, mySubIds]);

  const daily = useMemo(() => revenueByDay(myPaymentEvents, 30, nowMs), [myPaymentEvents, nowMs]);
  // Headline revenue is exact money — sum atomic bigints, not the chart's
  // float-bucketed `daily` vector (display-only, see lib/events.ts).
  const revenueThisMonth = useMemo(
    () => revenueTotalAtomic(myPaymentEvents, nowMs - 30 * DAY_MS, nowMs),
    [myPaymentEvents, nowMs],
  );

  const activeSubCount = subs.filter((s) => s.status !== "cancelled" && s.status !== "expired").length;

  const newSubsThisWeek = useMemo(() => {
    const subIds = new Set(subs.map((s) => s.subId));
    const cutoff = nowMs - 7 * DAY_MS;
    let count = 0;
    for (const e of events) {
      if (e.type !== "subscription.created") continue;
      if (!subIds.has(e.payload.subId)) continue;
      if (e.at >= cutoff) count++;
    }
    return count;
  }, [events, subs, nowMs]);

  const todayBatched = useMemo(
    () => events.filter((e) => e.type === "settlement.batched" && Math.floor(e.at / DAY_MS) === Math.floor(nowMs / DAY_MS)),
    [events, nowMs],
  );
  const meteredRevenueToday = todayBatched.reduce((sum, e) => sum + BigInt(e.payload.atomic || "0"), 0n);

  // needsAttention runs over the full (unscoped) feed, so filter its rows to
  // this merchant's own subs — otherwise another merchant's at-risk/overdue
  // subscribers would show up here.
  const attnRows = useMemo(
    () => needsAttention(events).filter((row) => mySubIds.has(row.subId)),
    [events, mySubIds],
  );
  // Scope the live-activity feed to this merchant too — same rationale as
  // attnRows above, applied per event type by scopedFeedEvents (see
  // lib/events.ts).
  const feedRows = useMemo(
    () =>
      scopedFeedEvents(events, myPlanIds, mySubIds)
        .sort((a, b) => b.at - a.at)
        .slice(0, 8),
    [events, myPlanIds, mySubIds],
  );

  return (
    <>
      <div>
        <h1>Good afternoon — here&apos;s your money.</h1>
        <p className="sub">
          All figures are live from Arc testnet · chain 5042002 — counters (including metered calls today) reflect
          only the most recent 200 events, so very old activity may not be represented.
        </p>
      </div>

      <div className="grid cols-3">
        <Panel className="stat">
          <div className="k">Revenue · this month</div>
          <div className="v serif">{formatUsd(revenueThisMonth)}</div>
          <div className="d">Last 30 days</div>
        </Panel>
        <Panel className="stat">
          <div className="k">Active subscriptions</div>
          <div className="v serif">{activeSubCount}</div>
          <div className="d">+{newSubsThisWeek} this week</div>
        </Panel>
        <Panel className="stat">
          <div className="k">Metered calls · today</div>
          <div className="v serif">{todayBatched.length.toLocaleString()}</div>
          <div className="d">{formatUsd(meteredRevenueToday)} settled today</div>
        </Panel>
      </div>

      <div className="grid overview">
        <Panel>
          <h2>
            Revenue <span className="sub" style={{ display: "inline" }}>— USDC, daily</span>
          </h2>
          <RevChart daily={daily} />
        </Panel>
        <Panel className="attn">
          <h2>Needs attention</h2>
          {attnRows.length === 0 ? (
            <p className="empty-note">Nothing needs attention right now.</p>
          ) : (
            attnRows.map((row) => (
              <div className="attn-row" key={row.subId}>
                <Badge tone={row.tone}>{row.tone === "warn" ? "at-risk" : "overdue"}</Badge>
                <div>
                  <div>{row.title}</div>
                  <div className="why">{row.why}</div>
                </div>
              </div>
            ))
          )}
        </Panel>
      </div>

      <Panel>
        <h2>Live activity</h2>
        {feedRows.length === 0 ? (
          <p className="empty-note">No events yet — activity appears here as it happens on-chain.</p>
        ) : (
          <div className="feed">
            {feedRows.map((e) => (
              <div className="feed-row" key={e.id}>
                <Badge tone={feedTone(e.type)}>{e.type}</Badge>
                <span className="desc">{feedDesc(e)}</span>
                <span className="t mono">{timeAgo(e.at, nowMs)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

/* ================================================================ */
/* Plans                                                              */
/* ================================================================ */

type PlanDrawerState = { kind: "new" } | { kind: "detail"; plan: MerchantPlan } | null;

function NewPlanForm({
  createPlan,
  pending,
  onDone,
}: {
  createPlan: (amountAtomic: bigint, periodS: number, trialS: number) => Promise<`0x${string}`>;
  pending: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const { isConnected } = useAccount();
  const [amount, setAmount] = useState("");
  const [periodDays, setPeriodDays] = useState("30");
  const [trialDays, setTrialDays] = useState("0");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isConnected) return;

    const amountAtomic = parseUsdToAtomic(amount);
    if (amountAtomic === null || amountAtomic <= 0n) {
      setError("Enter a price greater than $0.00.");
      return;
    }
    const periodNum = Number(periodDays);
    if (!Number.isInteger(periodNum) || periodNum <= 0) {
      setError("Billing period must be a whole number of days greater than 0.");
      return;
    }
    const trialNum = Number(trialDays || "0");
    if (!Number.isInteger(trialNum) || trialNum < 0) {
      setError("Trial must be zero or a whole number of days.");
      return;
    }

    try {
      await createPlan(amountAtomic, periodNum * 86_400, trialNum * 86_400);
      toast("Plan submitted — appears after confirmation.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed.");
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 className="serif">New plan</h2>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Price (USD / period)</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="29.00" inputMode="decimal" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Billing period (days)</span>
        <input value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} inputMode="numeric" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Trial (days, optional)</span>
        <input value={trialDays} onChange={(e) => setTrialDays(e.target.value)} inputMode="numeric" />
      </label>
      {error && <p className="empty-note" style={{ color: "var(--bad)" }}>{error}</p>}
      {!isConnected && <p className="empty-note">Connect a wallet first</p>}
      <button type="submit" className="btn primary" disabled={pending || !isConnected}>
        {pending ? "Confirm in wallet…" : "Create plan"}
      </button>
    </form>
  );
}

function PlanDetail({ plan, subCount }: { plan: MerchantPlan; subCount: number }) {
  return (
    <>
      <h2 className="serif">
        Plan #{plan.planId} — {formatUsd(plan.amount)} / {periodDaysLabel(plan.periodS)}
      </h2>
      <div className="kv">
        <div className="k">Status</div>
        <div>
          <Badge tone={plan.active ? "ok" : "mut"}>{plan.active ? "active" : "inactive"}</Badge>
        </div>
        <div className="k">Current version</div>
        <div>v{plan.version}</div>
        <div className="k">Trial</div>
        <div>{plan.trialS > 0 ? periodDaysLabel(plan.trialS) : "None"}</div>
        <div className="k">Active subs</div>
        <div>{subCount}</div>
        <div className="k">Plan id</div>
        <div className="mono">#{plan.planId} · on-chain</div>
      </div>
      <p className="empty-note">
        Price changes create a new immutable version — existing subscribers migrate at their next renewal, never
        mid-period. Version history and a &quot;push new version&quot; control aren&apos;t wired up in this MVP.
      </p>
    </>
  );
}

function Plans({ events }: { events: EventRow[] }) {
  const { plans, subs, pending, createPlan } = useMerchant(events);
  const [drawer, setDrawer] = useState<PlanDrawerState>(null);

  const subCountByPlan = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of subs) {
      if (s.status === "cancelled" || s.status === "expired") continue;
      map.set(s.planId, (map.get(s.planId) ?? 0) + 1);
    }
    return map;
  }, [subs]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div>
          <h1>Rate cards &amp; plans</h1>
          <p className="sub">One place for per-call pricing and recurring plans</p>
        </div>
        <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => setDrawer({ kind: "new" })}>
          New plan
        </button>
      </div>
      <Panel>
        <h2>Recurring plans</h2>
        {plans.length === 0 ? (
          <p className="empty-note">No plans yet — create one to start billing subscribers.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Price</th>
                <th>Period</th>
                <th>Version</th>
                <th className="num">Active subs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.planId} onClick={() => setDrawer({ kind: "detail", plan: p })}>
                  <td>Plan #{p.planId}</td>
                  <td className="mono">{formatUsd(p.amount)}</td>
                  <td>{periodDaysLabel(p.periodS)}</td>
                  <td>v{p.version}</td>
                  <td className="num">{subCountByPlan.get(p.planId) ?? 0}</td>
                  <td>
                    <Badge tone={p.active ? "ok" : "mut"}>{p.active ? "active" : "inactive"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Drawer open={drawer !== null} onClose={() => setDrawer(null)}>
        {drawer?.kind === "new" && (
          <NewPlanForm createPlan={createPlan} pending={pending} onDone={() => setDrawer(null)} />
        )}
        {drawer?.kind === "detail" && (
          <PlanDetail plan={drawer.plan} subCount={subCountByPlan.get(drawer.plan.planId) ?? 0} />
        )}
      </Drawer>
    </>
  );
}

/* ================================================================ */
/* Subscriptions                                                     */
/* ================================================================ */

const SUB_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "at-risk", label: "At-risk" },
  { key: "overdue", label: "Overdue" },
  { key: "cancelled", label: "Cancelled" },
  { key: "expired", label: "Expired" },
];

const SUB_STATUS_TONE: Record<MerchantSub["status"], "ok" | "warn" | "bad" | "mut"> = {
  active: "ok",
  "at-risk": "warn",
  overdue: "bad",
  cancelled: "mut",
  expired: "mut",
};

function Subs({ events }: { events: EventRow[] }) {
  const { plans, subs } = useMerchant(events);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<MerchantSub | null>(null);

  const attnWhy = useMemo(() => new Map(needsAttention(events).map((r) => [r.subId, r.why])), [events]);
  const planById = useMemo(() => new Map(plans.map((p) => [p.planId, p])), [plans]);

  const activeCount = subs.filter((s) => s.status !== "cancelled" && s.status !== "expired").length;
  const attnCount = subs.filter((s) => s.status === "at-risk" || s.status === "overdue").length;

  const filtered = filter === "all" ? subs : subs.filter((s) => s.status === filter);

  return (
    <>
      <div>
        <h1>Subscriptions</h1>
        <p className="sub">
          {activeCount} active · {attnCount} need attention
        </p>
      </div>
      <div className="chips" role="group" aria-label="Filter">
        {SUB_FILTERS.map((f) => (
          <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      <Panel>
        {filtered.length === 0 ? (
          <p className="empty-note">No subscriptions match this filter.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sub</th>
                <th>Customer</th>
                <th>Plan</th>
                <th>Next charge</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const plan = planById.get(s.planId);
                return (
                  <tr key={s.subId} onClick={() => setSelected(s)}>
                    <td className="mono">#{s.subId}</td>
                    <td className="mono">{shortAddr(s.customer)}</td>
                    <td>Plan #{s.planId}</td>
                    <td>{s.status === "cancelled" || s.status === "expired" ? "—" : formatDate(s.nextChargeAt)}</td>
                    <td className="num mono">{plan ? formatUsd(plan.amount) : "—"}</td>
                    <td>
                      <Badge tone={SUB_STATUS_TONE[s.status]}>{s.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Drawer open={selected !== null} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <h2 className="serif">Subscription #{selected.subId}</h2>
            <div className="kv">
              <div className="k">Status</div>
              <div>
                <Badge tone={SUB_STATUS_TONE[selected.status]}>{selected.status}</Badge>
              </div>
              <div className="k">Customer</div>
              <div className="mono">{shortAddr(selected.customer)}</div>
              <div className="k">Plan</div>
              <div>
                {(() => {
                  const plan = planById.get(selected.planId);
                  return plan
                    ? `Plan #${plan.planId} — ${formatUsd(plan.amount)} / ${periodDaysLabel(plan.periodS)}`
                    : `Plan #${selected.planId}`;
                })()}
              </div>
              <div className="k">Next charge</div>
              <div>
                {selected.status === "cancelled" || selected.status === "expired"
                  ? "—"
                  : formatDate(selected.nextChargeAt)}
              </div>
              <div className="k">Card</div>
              <div>Card #{selected.cardId}</div>
              {attnWhy.has(selected.subId) && (
                <>
                  <div className="k">Why flagged</div>
                  <div>{attnWhy.get(selected.subId)}</div>
                </>
              )}
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

/* ================================================================ */
/* Payments                                                           */
/* ================================================================ */

function txHashFor(e: EventRow): string {
  // Chain-decoded events use `${txHash}:${logIndex}` as their id (see
  // packages/service/src/events.ts decodeLog); metered settlement.batched
  // events carry the tx hash directly in payload.transaction, which is empty
  // until the batch has actually landed on-chain.
  if (e.type === "payment.succeeded") return e.id.split(":")[0] ?? "";
  return e.payload.transaction ?? "";
}

function Payments({ events }: { events: EventRow[] }) {
  const { address } = useAccount();

  // Scope payment.succeeded to this merchant's own subs — the events feed is
  // shared across every merchant on this one contract deployment, so
  // filtering by type alone would show other merchants' charges. See
  // lib/events.ts's `scopeToMerchant` for the join and its subId-uniqueness
  // caveat, and `scopedPaymentEvents` there for why settlement.batched rows
  // don't need the same treatment.
  const mySubIds = useMemo(
    () => (address ? scopeToMerchant(events, address).subIds : EMPTY_SUB_IDS),
    [events, address],
  );

  const rows = useMemo(
    () => scopedPaymentEvents(events, mySubIds).sort((a, b) => b.at - a.at),
    [events, mySubIds],
  );
  const nowMs = Date.now();

  return (
    <>
      <div>
        <h1>Payments</h1>
        <p className="sub">Subscription charges and batched metered settlements</p>
      </div>
      <Panel>
        {rows.length === 0 ? (
          <p className="empty-note">No payments yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Detail</th>
                <th className="num">Amount</th>
                <th className="num">Fee (1%)</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const isCharge = e.type === "payment.succeeded";
                const amount = isCharge ? e.payload.amount : e.payload.atomic;
                const hash = txHashFor(e);
                return (
                  <tr key={e.id}>
                    <td>{timeAgo(e.at, nowMs)}</td>
                    <td>
                      <Badge tone={isCharge ? "ok" : "info"}>{isCharge ? "charge" : "batch"}</Badge>
                    </td>
                    <td>{feedDesc(e)}</td>
                    <td className="num mono">{formatUsd(amount ?? "0")}</td>
                    <td className="num mono">{isCharge ? formatUsd(e.payload.fee ?? "0") : "—"}</td>
                    <td className="mono">
                      {hash ? (
                        <a href={`${ARC_TX_URL}${hash}`} target="_blank" rel="noreferrer">
                          {shortHash(hash)} ↗
                        </a>
                      ) : (
                        "batching…"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/* ================================================================ */
/* Webhooks                                                           */
/* ================================================================ */

const DELIVERY_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "delivered", label: "Delivered" },
  { key: "retrying", label: "Retrying" },
  { key: "pending", label: "Pending" },
  { key: "dead", label: "Dead" },
];

const DELIVERY_TONE: Record<AdminDelivery["status"], "ok" | "warn" | "bad" | "mut"> = {
  delivered: "ok",
  retrying: "warn",
  pending: "mut",
  dead: "bad",
};

type WebhookDrawerState =
  | { kind: "add" }
  | { kind: "secret"; heading: string; url: string; secret: string }
  | null;

function AddEndpointForm({
  onCreated,
}: {
  onCreated: (created: { url: string; secret: string }) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = url.trim();
    if (!/^https?:\/\/.+/.test(trimmed)) {
      setError("Enter a full http(s):// URL.");
      return;
    }
    setPending(true);
    try {
      const created = await createEndpoint(trimmed);
      onCreated({ url: created.url, secret: created.secret });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 className="serif">Add endpoint</h2>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sub">Endpoint URL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your.app/scruple/hooks"
          inputMode="url"
        />
      </label>
      <p className="empty-note">
        Every event is HMAC-SHA256-signed (<code className="mono">scruple-signature</code> header) with a secret
        generated on create, and retried at 1m → 5m → 30m → 2h → 12h before being marked dead.
      </p>
      {error && <p className="empty-note" style={{ color: "var(--bad)" }}>{error}</p>}
      <button type="submit" className="btn primary" disabled={pending}>
        {pending ? "Adding…" : "Add endpoint"}
      </button>
    </form>
  );
}

// Reveal-once view for a freshly created/rotated signing secret. The secret
// lives only in the parent's drawer state (cleared on close) — it is never
// listed again by the API, so this is the merchant's one chance to copy it.
function SecretReveal({
  heading,
  url,
  secret,
  onDone,
}: {
  heading: string;
  url: string;
  secret: string;
  onDone: () => void;
}) {
  const toast = useToast();

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      toast("Secret copied");
    } catch {
      toast("Copy failed — select the secret and copy it manually.");
    }
  }

  return (
    <>
      <h2 className="serif">{heading}</h2>
      <div className="kv">
        <div className="k">Endpoint</div>
        <div className="mono">{shortUrl(url)}</div>
        <div className="k">Signing secret</div>
        <div>
          <code
            className="mono"
            style={{
              display: "block",
              padding: "10px 12px",
              background: "var(--surface2)",
              border: "1px solid var(--line)",
              borderRadius: 7,
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {secret}
          </code>
        </div>
      </div>
      <p className="empty-note" style={{ color: "var(--warn)" }}>
        Shown once — store it now. It is never displayed again; rotate the endpoint to get a new one.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" onClick={copy}>
          Copy secret
        </button>
        <button className="btn" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}

function Webhooks() {
  const toast = useToast();
  const { endpoints, deliveries, error, refetch } = useAdmin();
  const [drawer, setDrawer] = useState<WebhookDrawerState>(null);
  const [filter, setFilter] = useState("all");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const nowMs = Date.now();

  // Delete is a two-click confirm; back out automatically if the second
  // click doesn't come within a few seconds.
  useEffect(() => {
    if (confirmDelete === null) return;
    const id = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(id);
  }, [confirmDelete]);

  async function run(action: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try {
      await action();
      toast(okMsg);
      await refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRotate(ep: AdminEndpoint) {
    setBusy(true);
    try {
      const res = await rotateEndpointSecret(ep.id);
      setDrawer({ kind: "secret", heading: "Secret rotated", url: ep.url, secret: res.secret });
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function handleDelete(id: number) {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    setConfirmDelete(null);
    run(() => deleteEndpoint(id), "Endpoint deleted");
  }

  const filtered = filter === "all" ? deliveries : deliveries.filter((d) => d.status === filter);

  return (
    <>
      <div>
        <h1>Webhooks</h1>
        <p className="sub">
          Signed with <code className="mono">scruple-signature</code> · retried 1m→5m→30m→2h→12h
        </p>
      </div>

      <Panel>
        <div className="whk-head">
          <h2 style={{ margin: 0 }}>Endpoints</h2>
          <button
            className="btn primary small"
            style={{ marginLeft: "auto" }}
            onClick={() => setDrawer({ kind: "add" })}
          >
            Add endpoint
          </button>
        </div>
        {error && (
          <p className="empty-note" style={{ color: "var(--bad)", marginTop: 10 }}>
            {error}
          </p>
        )}
        {endpoints.length === 0 ? (
          <p className="empty-note" style={{ marginTop: 10 }}>
            Add your first endpoint — every payment and subscription event will be signed and delivered to it.
          </p>
        ) : (
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Secret</th>
                <th>Status</th>
                <th className="num"></th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((ep) => (
                <tr key={ep.id}>
                  <td className="mono">{shortUrl(ep.url)}</td>
                  <td className="mono">{ep.secretPreview}</td>
                  <td>
                    <Badge tone={ep.paused ? "mut" : "ok"}>{ep.paused ? "paused" : "active"}</Badge>
                  </td>
                  <td className="num">
                    <span style={{ display: "inline-flex", gap: 8 }}>
                      <button
                        className="btn small"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => setEndpointPaused(ep.id, !ep.paused),
                            ep.paused ? "Endpoint resumed" : "Endpoint paused",
                          )
                        }
                      >
                        {ep.paused ? "Resume" : "Pause"}
                      </button>
                      <button className="btn small" disabled={busy} onClick={() => handleRotate(ep)}>
                        Rotate
                      </button>
                      <button
                        className="btn small"
                        disabled={busy}
                        style={
                          confirmDelete === ep.id
                            ? { borderColor: "var(--bad)", color: "var(--bad)" }
                            : undefined
                        }
                        onClick={() => handleDelete(ep.id)}
                      >
                        {confirmDelete === ep.id ? "Confirm delete" : "Delete"}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <h2>Deliveries</h2>
        <div className="chips" role="group" aria-label="Filter deliveries" style={{ marginTop: 10 }}>
          {DELIVERY_FILTERS.map((f) => (
            <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        {error && (
          <p className="empty-note" style={{ color: "var(--bad)", marginTop: 10 }}>
            {error}
          </p>
        )}
        {filtered.length === 0 ? (
          !error && (
            <p className="empty-note" style={{ marginTop: 12 }}>
              {deliveries.length === 0
                ? "No deliveries yet — rows appear here as events fire on-chain."
                : "No deliveries match this filter."}
            </p>
          )
        ) : (
          <table style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>Event</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th className="num">Attempts</th>
                <th className="num">HTTP</th>
                <th>Next attempt</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={`${d.endpointId}:${d.eventId}`}>
                  <td className="mono">{shortEventId(d.eventId)}</td>
                  <td>{d.type}</td>
                  <td className="mono">{shortUrl(d.url)}</td>
                  <td className="num">{d.attempts}</td>
                  <td className="num mono">{d.lastStatus ?? "—"}</td>
                  <td>{d.nextAttemptAt !== null ? timeUntil(d.nextAttemptAt * 1000, nowMs) : "—"}</td>
                  <td>
                    <Badge tone={DELIVERY_TONE[d.status]}>{d.status}</Badge>
                  </td>
                  <td>
                    {(d.status === "retrying" || d.status === "dead") && (
                      <button
                        className="btn small"
                        disabled={busy}
                        onClick={() => run(() => resendDelivery(d.endpointId, d.eventId), "Resend scheduled")}
                      >
                        Resend
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Drawer open={drawer !== null} onClose={() => setDrawer(null)}>
        {drawer?.kind === "add" && (
          <AddEndpointForm
            onCreated={(created) => {
              refetch();
              setDrawer({ kind: "secret", heading: "Endpoint added", url: created.url, secret: created.secret });
            }}
          />
        )}
        {drawer?.kind === "secret" && (
          <SecretReveal
            heading={drawer.heading}
            url={drawer.url}
            secret={drawer.secret}
            onDone={() => setDrawer(null)}
          />
        )}
      </Drawer>
    </>
  );
}

/* ================================================================ */

export function Merchant({ screen, events }: { screen: MerchantScreen; events: EventRow[] }) {
  switch (screen) {
    case "overview":
      return <Overview events={events} />;
    case "plans":
      return <Plans events={events} />;
    case "subs":
      return <Subs events={events} />;
    case "payments":
      return <Payments events={events} />;
    case "webhooks":
      return <Webhooks />;
  }
}
