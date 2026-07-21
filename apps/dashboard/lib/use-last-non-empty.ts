"use client";

// Retains the last non-empty array seen for a value that flaps between
// populated and empty across renders — e.g. a useReadContracts result that
// goes empty for one poll because the public Arc RPC rate-limited a
// multicall (-32011 "request limit reached") and the hook's parser dropped
// the per-contract failures.
//
// Tradeoff: this means a *genuine* transition to empty (e.g. every card for
// this wallet was cancelled elsewhere) won't show as empty until the page is
// reloaded — it'll keep showing the stale last-good list. That's an
// acceptable cost against the alternative, which is the UI flapping
// 1 -> 0 -> 1 every ~5-15s whenever the RPC throttles a poll.
import { useRef } from "react";

export function useLastNonEmpty<T>(value: T[]): T[] {
  const lastNonEmpty = useRef<T[]>(value);

  if (value.length > 0) {
    lastNonEmpty.current = value;
    return value;
  }

  return lastNonEmpty.current;
}
