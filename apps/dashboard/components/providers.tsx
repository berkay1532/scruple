"use client";

// Real wagmi + react-query providers. The QueryClient is created once per
// component instance (lazy useState initializer) rather than at module
// scope, so a fresh client is used per mount instead of leaking state across
// server requests. wagmiConfig has `ssr: true` (lib/chain.ts) so wagmi
// itself renders a disconnected snapshot until the client has mounted and
// reconciled any persisted connector state — no hydration mismatch, no
// cookie plumbing needed for this MVP.
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/chain";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
