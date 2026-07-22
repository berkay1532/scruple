// Arc testnet chain definition + deployed contract addresses + the shared
// wagmi config (injected connector only — MVP has no WalletConnect/Coinbase
// wallet support). SSR-safety: `ssr: true` tells wagmi to render a
// disconnected snapshot on the server and during the first client render,
// then reconcile with any persisted connection after mount — this avoids a
// hydration mismatch without needing cookie-based initial state plumbing
// through the server layout.
import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

// Default reads go through the same-origin /api/rpc proxy (see
// app/api/rpc/route.ts) so the browser never talks cross-origin to the
// authenticated canteen RPC (CORS-blocked) or hammers the public RPC
// (rate-limited). NEXT_PUBLIC_RPC_URL stays supported as an explicit
// override for anyone pointing at their own CORS-enabled RPC.
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "/api/rpc";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
});

export const ADDRESSES = {
  cardIssuer: "0xE20EB808cF87B73D716C96CBbb1eee62282506d0" as `0x${string}`,
  subscriptionManager: "0x3d0b19b6B06E568A23AA916270008012Dca55795" as `0x${string}`,
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
} as const;

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  // `batch: { wait: 16 }` collapses simultaneous reads (dashboard tables
  // firing several parallel contract reads on load) into a single JSON-RPC
  // batch request (a JSON array body) instead of one HTTP round trip per
  // read — see lib/rpc-forwarder.ts / app/api/rpc/route.ts for the
  // array-aware handling this requires on the proxy side.
  transports: {
    [arcTestnet.id]: http(rpcUrl, { batch: { wait: 16 } }),
  },
  ssr: true,
});
