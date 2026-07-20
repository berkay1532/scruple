// Ports the mock's .scard markup (docs/design/dashboard-mock.html) exactly —
// brand row + status badge, cosmetic number, label, meta, spend progress bar,
// netline, and a FROZEN stamp overlay for frozen cards.
import { cardProgress } from "../lib/cards";
import { formatUsd, cosmeticCardNumber } from "../lib/format";
import { Badge, type BadgeTone } from "./ui";

export type CardStatus = "active" | "frozen" | "cancelled";

const STATUS_BADGE: Record<CardStatus, { tone: BadgeTone; text: string }> = {
  active: { tone: "ok", text: "Active" },
  frozen: { tone: "mut", text: "Frozen" },
  cancelled: { tone: "bad", text: "Cancelled" },
};

export function ScrupleCard({
  label,
  cardId,
  limitText,
  spent,
  limit,
  expiry,
  status,
  allowlistCount,
  onClick,
}: {
  label: string;
  cardId: string;
  limitText: string;
  spent: bigint;
  limit: bigint;
  expiry: string;
  status: CardStatus;
  allowlistCount: number;
  onClick?: () => void;
}) {
  const { pct, tone } = cardProgress(spent, limit);
  const badge = STATUS_BADGE[status];
  const frozen = status === "frozen";
  const lockText = allowlistCount > 0 ? `🔒 ${allowlistCount} merchant${allowlistCount === 1 ? "" : "s"}` : "open";

  return (
    <button
      type="button"
      className={frozen ? "scard frozen" : "scard"}
      aria-label={`${label} card, ${status}`}
      onClick={onClick}
    >
      <span className="row1">
        <span className="brand serif">⚖ Scruple</span>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </span>
      <span className="number mono">{cosmeticCardNumber(cardId)}</span>
      <span className="label">{label}</span>
      <span className="meta">
        <span>
          limit <b>{limitText}</b>
        </span>
        <span>
          spent <b>{formatUsd(spent)}</b>
        </span>
        <span>
          exp <b>{expiry}</b>
        </span>
      </span>
      <span className="bar">
        <i className={tone === "ok" ? undefined : tone} style={{ width: `${pct}%` }} />
      </span>
      <span className="netline">
        Arc · USDC <span className="lock">{lockText}</span>
      </span>
      {frozen && <span className="stamp serif">FROZEN</span>}
    </button>
  );
}
