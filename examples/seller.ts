import express from "express";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { scruple, formatAtomic, createServiceForwarder } from "@scruple/server";

const sellerAddress = process.env.SELLER_ADDRESS;
if (!sellerAddress) throw new Error("SELLER_ADDRESS env var required");

const serviceIngestUrl = process.env.SERVICE_INGEST_URL;
const serviceIngestSecret = process.env.SERVICE_INGEST_SECRET;

let forward: ((e: Parameters<typeof scruple>[0]["onPayment"]>[0]) => Promise<void>) | undefined;
if (serviceIngestUrl && serviceIngestSecret) {
  forward = createServiceForwarder({ url: serviceIngestUrl, secret: serviceIngestSecret });
  console.log("[scruple] forwarding enabled: metered payments → service ingest");
} else {
  console.log("[scruple] forwarding disabled");
}

const app = express();
app.use(scruple({
  rateCard: {
    "GET /api/quote": "$0.001",
    "GET /api/dataset": "$0.01",
    "POST /api/compute": "$0.0003",
  },
  sellerAddress,
  facilitator: new BatchFacilitatorClient(),
  onPayment: (e) => {
    console.log(`[scruple] ${e.endpoint} paid ${formatAtomic(e.atomic)} by ${e.payer} (tx: ${e.transaction ?? "batching"})`);
    if (forward) void forward(e);
  },
}));

app.get("/api/quote", (_req, res) => { res.json({ pair: "USDC/EURC", mid: 0.9214 }); });
app.get("/api/dataset", (_req, res) => { res.json({ rows: 128, sample: [1, 2, 3] }); });
app.post("/api/compute", (_req, res) => { res.json({ result: 42 }); });
app.get("/health", (_req, res) => { res.json({ ok: true }); });

app.listen(3000, () => console.log("Scruple demo seller on :3000"));
