import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ScrupleCard } from "../components/scruple-card";

afterEach(cleanup);

describe("ScrupleCard", () => {
  it("renders the label and cosmetic card number", () => {
    const { container } = render(
      <ScrupleCard
        label="Data-API agent card"
        cardId="4"
        limitText="$2.00/day"
        spent={1_460_000n}
        limit={2_000_000n}
        expiry="08/26"
        status="active"
        allowlistCount={3}
      />,
    );

    expect(container.querySelector(".label")?.textContent).toBe("Data-API agent card");
    expect(container.querySelector(".number")?.textContent).toBe("5crp 0000 0000 0004");
  });

  it("adds the .frozen class and a FROZEN stamp when status is frozen", () => {
    const { container } = render(
      <ScrupleCard
        label="Experiments"
        cardId="2"
        limitText="$0.50/day"
        spent={0n}
        limit={50_000n}
        expiry="09/26"
        status="frozen"
        allowlistCount={0}
      />,
    );

    const card = container.querySelector(".scard");
    expect(card?.classList.contains("frozen")).toBe(true);
    expect(container.querySelector(".stamp")?.textContent).toBe("FROZEN");
  });

  it("does not render a FROZEN stamp or .frozen class for an active card", () => {
    const { container } = render(
      <ScrupleCard
        label="Subscriptions"
        cardId="0"
        limitText="$5.00/mo"
        spent={1_000_000n}
        limit={5_000_000n}
        expiry="—"
        status="active"
        allowlistCount={1}
      />,
    );

    const card = container.querySelector(".scard");
    expect(card?.classList.contains("frozen")).toBe(false);
    expect(container.querySelector(".stamp")).toBeNull();
  });

  it("sets the progress bar width style to match cardProgress's pct", () => {
    const { container } = render(
      <ScrupleCard
        label="Data-API agent card"
        cardId="4"
        limitText="$2.00/day"
        spent={1_460_000n}
        limit={2_000_000n}
        expiry="08/26"
        status="active"
        allowlistCount={3}
      />,
    );

    const bar = container.querySelector<HTMLElement>(".bar i");
    expect(bar?.style.width).toBe("73%");
    expect(bar?.classList.contains("warn")).toBe(true);
  });

  it("renders a plain bar with no tone class when progress is ok", () => {
    const { container } = render(
      <ScrupleCard
        label="Subscriptions"
        cardId="0"
        limitText="$5.00/mo"
        spent={1_000_000n}
        limit={5_000_000n}
        expiry="—"
        status="active"
        allowlistCount={1}
      />,
    );

    const bar = container.querySelector<HTMLElement>(".bar i");
    expect(bar?.style.width).toBe("20%");
    expect(bar?.className).toBe("");
  });

  it('renders "open" in the netline when allowlistCount is 0', () => {
    const { container } = render(
      <ScrupleCard
        label="Experiments"
        cardId="2"
        limitText="$0.50/day"
        spent={0n}
        limit={50_000n}
        expiry="09/26"
        status="frozen"
        allowlistCount={0}
      />,
    );

    expect(container.querySelector(".netline .lock")?.textContent).toBe("open");
  });

  it('renders "restricted" in the netline when allowlistCount is null', () => {
    const { container } = render(
      <ScrupleCard
        label="Data-API agent card"
        cardId="4"
        limitText="$2.00/day"
        spent={1_460_000n}
        limit={2_000_000n}
        expiry="08/26"
        status="active"
        allowlistCount={null}
      />,
    );

    expect(container.querySelector(".netline .lock")?.textContent).toBe("🔒 restricted");
  });

  it("renders the merchant count in the netline when allowlistCount is positive", () => {
    const { container } = render(
      <ScrupleCard
        label="Data-API agent card"
        cardId="4"
        limitText="$2.00/day"
        spent={1_460_000n}
        limit={2_000_000n}
        expiry="08/26"
        status="active"
        allowlistCount={3}
      />,
    );

    expect(container.querySelector(".netline .lock")?.textContent).toBe("🔒 3 merchants");
  });

  it("shows an Active badge and calls onClick when clicked", () => {
    const onClick = vi.fn();
    const { container, getByRole } = render(
      <ScrupleCard
        label="Subscriptions"
        cardId="0"
        limitText="$5.00/mo"
        spent={1_000_000n}
        limit={5_000_000n}
        expiry="—"
        status="active"
        allowlistCount={1}
        onClick={onClick}
      />,
    );

    expect(container.querySelector(".badge")?.textContent).toContain("Active");
    getByRole("button").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
