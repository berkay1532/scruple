/**
 * Local RPC shim: exposes the Arc public RPC on localhost with the same
 * burst-smoothing used by the dashboard proxy (serial queue, min-gap,
 * rate-limit backoff). Point any tool at it via RPC_URL=http://localhost:8547
 * when the public endpoint's per-IP limits bite (see docs/demo/runbook.md).
 */
import { createServer } from "node:http";
import { createRpcForwarder } from "@scruple/rpc-forwarder";

const UPSTREAM = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const PORT = Number(process.env.SHIM_PORT ?? 8547);

const forwarder = createRpcForwarder({ upstream: UPSTREAM });

createServer(async (req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    try {
      const out = await forwarder.forward(body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":"rpc upstream unavailable"}');
    }
  });
}).listen(PORT, () => {
  console.log(`[rpc-shim] smoothing proxy on :${PORT} → Arc public RPC`);
});
