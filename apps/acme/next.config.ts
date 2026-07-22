import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly, same reason as apps/dashboard: an
  // unrelated package-lock.json in the host user's home directory otherwise
  // gets picked up by Next's automatic root inference and emits a spurious
  // "multiple lockfiles" warning.
  turbopack: { root: path.join(__dirname, "..", "..") },
  // @scruple/checkout ships raw TypeScript (`main: "src/index.ts"`, no
  // compiled dist/) — this is the first app to consume it, so it needs to be
  // transpiled by Next's build pipeline like first-party app code instead of
  // being treated as an already-built external dependency.
  transpilePackages: ["@scruple/checkout"],
};
export default nextConfig;
