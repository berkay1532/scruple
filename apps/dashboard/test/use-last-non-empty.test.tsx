import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLastNonEmpty } from "../lib/use-last-non-empty";

describe("useLastNonEmpty", () => {
  it("returns the value as-is when it is non-empty", () => {
    const { result } = renderHook(() => useLastNonEmpty([1, 2, 3]));
    expect(result.current).toEqual([1, 2, 3]);
  });

  it("retains the last non-empty value when the value goes empty", () => {
    const { result, rerender } = renderHook(({ value }) => useLastNonEmpty(value), {
      initialProps: { value: [1, 2, 3] as number[] },
    });
    expect(result.current).toEqual([1, 2, 3]);

    rerender({ value: [] });
    expect(result.current).toEqual([1, 2, 3]);
  });

  it("returns empty when the value has always been empty", () => {
    const { result } = renderHook(() => useLastNonEmpty<number>([]));
    expect(result.current).toEqual([]);
  });
});
