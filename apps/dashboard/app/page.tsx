"use client";

import { useState } from "react";
import { Chrome, type Screen, type View } from "@/components/chrome";
import { Badge, Panel } from "@/components/ui";

export default function Page() {
  const [view, setView] = useState<View>("merchant");
  const [screen, setScreen] = useState<Screen>("overview");

  function handleViewChange(next: View) {
    setView(next);
    setScreen(next === "merchant" ? "overview" : "gallery");
  }

  return (
    <Chrome view={view} onViewChange={handleViewChange} screen={screen} onScreenChange={setScreen}>
      {/* ==== MERCHANT / OVERVIEW ==== */}
      <section className="screen active" id="s-overview">
        <div>
          <h1>Good afternoon — here&apos;s your money.</h1>
          <p className="sub">All figures are live from Arc testnet · chain 5042002</p>
        </div>

        <div className="grid cols-3">
          <Panel className="stat">
            <div className="k">Revenue · this month</div>
            <div className="v serif">$1,284.03</div>
            <div className="d">▲ 18.2% vs last month</div>
          </Panel>
          <Panel className="stat">
            <div className="k">Active subscriptions</div>
            <div className="v serif">42</div>
            <div className="d">+6 this week</div>
          </Panel>
          <Panel className="stat">
            <div className="k">Metered calls · today</div>
            <div className="v serif">18,204</div>
            <div className="d">$23.61 settled in 3 batches</div>
          </Panel>
        </div>

        <div className="grid overview">
          <Panel className="attn">
            <h2>Needs attention</h2>
            <div className="attn-row">
              <Badge tone="warn">at-risk</Badge>
              <div>
                <div>Sub #17 · Pro $29/mo</div>
                <div className="why">{"Balance $11.20 < $29 — renews in 2 days"}</div>
              </div>
              <button className="act">{"Nudge →"}</button>
            </div>
            <div className="attn-row">
              <Badge tone="bad">overdue</Badge>
              <div>
                <div>Sub #31 · Metered+ $9/mo</div>
                <div className="why">2 failed attempts · grace ends in 26h</div>
              </div>
              <button className="act">{"Review →"}</button>
            </div>
            <div className="attn-row">
              <Badge tone="warn">card-block</Badge>
              <div>
                <div>Sub #8 · Pro $29/mo</div>
                <div className="why">Card policy will decline next charge</div>
              </div>
              <button className="act">{"Contact →"}</button>
            </div>
          </Panel>
        </div>
      </section>
    </Chrome>
  );
}
