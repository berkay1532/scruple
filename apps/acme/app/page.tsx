"use client";

// Acme Analytics — a fake, deliberately foreign-branded SaaS pricing page
// that embeds <ScrupleCheckout/> on its Pro tier. Every pixel outside the
// modal's embedded panel is Acme's own cheerful light-mode identity (white
// ground, indigo accent, rounded system-ui sans); the panel itself keeps its
// own dark-ink/brass Scruple identity regardless — see globals.css's top
// comment for why that contrast is the whole point of this example.
import { useEffect, useState } from "react";
import { ScrupleCheckout } from "@scruple/checkout";

// The Pro tier's real on-chain plan id — a subscription-manager plan created
// out of band for this demo. Defaults to "0" so the page still renders (and
// builds) without any env configured; a real deployment points this at
// whatever plan id the merchant actually created.
function parsePlanId(raw: string | undefined): bigint {
  try { return BigInt(raw ?? "0"); } catch { return 0n; }
}
const PRO_PLAN_ID = parsePlanId(process.env.NEXT_PUBLIC_ACME_PLAN_ID);

interface Tier {
  name: string;
  amount: string;
  period: string;
  blurb: string;
  features: string[];
  cta: string;
  highlight?: boolean;
}

const TIERS: Tier[] = [
  {
    name: "Starter",
    amount: "$0",
    period: "forever",
    blurb: "Poke around, wire up your first dashboard, see if we click.",
    features: ["1 dashboard", "3 teammates", "7-day data history", "Community support"],
    cta: "Start for free",
  },
  {
    name: "Pro",
    amount: "$29",
    period: "/mo",
    blurb: "For teams who actually open their dashboards every morning.",
    features: [
      "Unlimited dashboards",
      "Unlimited teammates",
      "1-year data history",
      "Slack + email alerts",
      "Priority support",
    ],
    cta: "Upgrade to Pro",
    highlight: true,
  },
  {
    name: "Enterprise",
    amount: "Let's talk",
    period: "",
    blurb: "SSO, audit logs, and a Slack channel with our on-call team.",
    features: ["Everything in Pro", "SSO + SCIM", "Audit logs", "Dedicated CSM", "Custom contract"],
    cta: "Contact us",
  },
];

export default function Page() {
  const [modalOpen, setModalOpen] = useState(false);
  const [subId, setSubId] = useState<bigint | null>(null);

  useEffect(() => {
    if (!modalOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setModalOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen]);

  function handleTierClick(tier: Tier) {
    if (tier.name === "Pro") setModalOpen(true);
    // Starter and Enterprise are decorative in this demo — no real signup
    // flow behind them, this page exists to show off the Pro checkout embed.
  }

  return (
    <main className="page">
      <header className="nav">
        <div className="nav-brand">
          <span className="dot" aria-hidden="true" />
          Acme Analytics
        </div>
        <button type="button" className="nav-cta" onClick={() => setModalOpen(true)}>
          Upgrade to Pro
        </button>
      </header>

      <section className="hero">
        <span className="eyebrow">✨ Now with same-day cohorts</span>
        <h1>
          Acme Analytics — <span className="accent">dashboards your team actually reads</span>
        </h1>
        <p>
          Stop exporting CSVs nobody opens. Acme turns your product events into dashboards your team checks every
          morning, no data team required.
        </p>
        <div className="hero-ctas">
          <button type="button" className="btn btn-primary" onClick={() => setModalOpen(true)}>
            Upgrade to Pro
          </button>
          <a href="#pricing" className="btn btn-ghost">
            See pricing
          </a>
        </div>
      </section>

      {subId !== null ? (
        <p className="success-banner" role="status">
          You&rsquo;re on Pro! Subscription #{subId.toString()} is live — welcome aboard.
        </p>
      ) : null}

      <div className="pricing-heading" id="pricing">
        <h2>Simple pricing, no surprises</h2>
        <p>Cancel any time. Your data is always yours to export.</p>
      </div>

      <section className="pricing">
        {TIERS.map((tier) => (
          <div key={tier.name} className={`tier-card${tier.highlight ? " tier-card--highlight" : ""}`}>
            {tier.highlight ? <span className="tier-badge">Most popular</span> : null}
            <span className="tier-name">{tier.name}</span>
            <div className="tier-price">
              <span className="amount">{tier.amount}</span>
              {tier.period ? <span className="period">{tier.period}</span> : null}
            </div>
            <p className="tier-blurb">{tier.blurb}</p>
            <ul className="tier-features">
              {tier.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <button
              type="button"
              className={`tier-cta${tier.highlight ? " tier-cta--primary" : ""}`}
              onClick={() => handleTierClick(tier)}
            >
              {tier.cta}
            </button>
          </div>
        ))}
      </section>

      <footer className="footer">Acme Analytics is a fictional demo product — checkout runs for real, on Arc.</footer>

      {modalOpen ? (
        <div className="modal-scrim" onClick={() => setModalOpen(false)}>
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setModalOpen(false)} aria-label="Close">
              ×
            </button>
            <div className="modal-heading">
              <h3>Upgrade to Pro</h3>
              <p>Pay with USDC, wallet-to-wallet — nothing touches Acme&rsquo;s servers.</p>
            </div>
            <ScrupleCheckout
              planId={PRO_PLAN_ID}
              onSuccess={({ subId: newSubId }) => {
                setSubId(newSubId);
                setModalOpen(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}
