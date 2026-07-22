"use client";

// Real wagmi + react-query providers, same ssr-safe pattern as
// apps/dashboard/components/providers.tsx + lib/chain.ts, trimmed down and
// inlined here since this demo only needs one chain (see the rpcUrl comment
// below for the server-side RPC proxy this app does use). The QueryClient is
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

// Default reads go through the same-origin /api/rpc proxy (see
// app/api/rpc/route.ts), same as the dashboard's lib/chain.ts: the public
// Arc RPC rate-limits the burst of parallel reads a checkout mount fires on
// load, which otherwise stalls the panel on "Loading plan…" and surfaces
// "RPC Request failed". NEXT_PUBLIC_RPC_URL stays supported as an explicit
// override for anyone pointing at their own CORS-enabled RPC.
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "/api/rpc";

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
