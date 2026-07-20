import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly: an unrelated package-lock.json in the
  // host user's home directory otherwise gets picked up by Next's automatic
  // root inference and emits a spurious "multiple lockfiles" warning.
  turbopack: { root: path.join(__dirname, "..", "..") },
};
export default nextConfig;
