"use client";

// Real wagmi + react-query providers, same ssr-safe pattern as
// apps/dashboard/components/providers.tsx + lib/chain.ts, trimmed down and
// inlined here since this demo only needs one chain and doesn't need a
// server-side RPC proxy (see the rpcUrl comment below). The QueryClient is
// created once per component instance (lazy useState initializer) so a
// fresh client is used per mount instead of leaking state across server
// requests. wagmiConfig has `ssr: true` so wagmi itself renders a
// disconnected snapshot until the client has mounted and reconciled any
// persisted connector state — no hydration mismatch, no cookie plumbing
// needed for this demo.
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defineChain } from "viem";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

// Unlike the dashboard, this demo talks straight to the public Arc RPC
// instead of proxying through a same-origin API route — a real production
// embed host would likely add that proxy (see
// apps/dashboard/app/api/rpc/route.ts) to dodge the public endpoint's rate
// limiting, but that's dashboard-specific plumbing this example deliberately
// skips to stay small. NEXT_PUBLIC_RPC_URL still overrides it for anyone
// pointing at their own endpoint.
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.arc.network";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: { [arcTestnet.id]: http() },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
