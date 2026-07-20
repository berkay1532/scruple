"use client";

import { useState } from "react";
import { Chrome, type CardsScreen, type MerchantScreen, type Screen, type View } from "@/components/chrome";
import { Merchant } from "@/components/screens/merchant";
import { Cards } from "@/components/screens/cards";
import { useEvents } from "@/lib/use-events";

export default function Page() {
  const [view, setView] = useState<View>("merchant");
  const [screen, setScreen] = useState<Screen>("overview");
  const { events, error } = useEvents();

  function handleViewChange(next: View) {
    setView(next);
    setScreen(next === "merchant" ? "overview" : "gallery");
  }

  return (
    <Chrome view={view} onViewChange={handleViewChange} screen={screen} onScreenChange={setScreen}>
      {error && <p className="empty-note">Live data unavailable: {error}</p>}
      {view === "merchant" ? (
        <Merchant screen={screen as MerchantScreen} events={events} />
      ) : (
        <Cards screen={screen as CardsScreen} events={events} />
      )}
    </Chrome>
  );
}
