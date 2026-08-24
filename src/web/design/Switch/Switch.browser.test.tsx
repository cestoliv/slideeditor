import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Field } from "../Field/Field.js";
import { Switch } from "./Switch.js";

/* Inside a Field the name comes from the label, so aria-label is left off. */
function Controlled({ named = true }: { named?: boolean }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      {...(named ? { "aria-label": "Snap to grid" } : {})}
      checked={on}
      onCheckedChange={setOn}
    />
  );
}

it("reports its state through the switch role rather than a button", async () => {
  const screen = await render(<Switch aria-label="Snap to grid" />);
  await expect
    .element(screen.getByRole("switch", { name: "Snap to grid" }))
    .toHaveAttribute("aria-checked", "false");
});

it("toggles on click", async () => {
  const screen = await render(<Controlled />);
  const control = screen.getByRole("switch", { name: "Snap to grid" });
  await control.click();
  await expect.element(control).toHaveAttribute("aria-checked", "true");
  await control.click();
  await expect.element(control).toHaveAttribute("aria-checked", "false");
});

it("toggles on Space from the keyboard", async () => {
  const screen = await render(<Controlled />);
  const control = screen.getByRole("switch", { name: "Snap to grid" });
  await userEvent.keyboard("{Tab}");
  expect(control.element()).toBe(document.activeElement);
  await userEvent.keyboard(" ");
  await expect.element(control).toHaveAttribute("aria-checked", "true");
});

it("stays put when it is disabled", async () => {
  let changes = 0;
  const screen = await render(
    <Switch
      aria-label="Snap to grid"
      disabled
      onCheckedChange={() => {
        changes += 1;
      }}
    />,
  );
  await screen.getByRole("switch", { name: "Snap to grid" }).click({ force: true });
  expect(changes).toBe(0);
});

it("takes its name and its id from a surrounding Field", async () => {
  const screen = await render(
    <Field label="Snap to grid" hint="Layers land on the 24px grid.">
      <Controlled named={false} />
    </Field>,
  );
  // The Field owns the label, so the switch must not carry a name of its own.
  const control = screen.getByRole("switch", { name: "Snap to grid" });
  await expect.element(control).toBeVisible();
  const describedBy = control.element().getAttribute("aria-describedby");
  expect(describedBy).not.toBe(null);
  expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
    "Layers land on the 24px grid.",
  );
});

it("parks the thumb the same distance from each end of the track", async () => {
  const screen = await render(<Controlled />);
  const control = screen.getByRole("switch", { name: "Snap to grid" });
  const track = control.element();
  const thumb = track.firstElementChild;
  expect(thumb).not.toBe(null);

  const settle = async () => {
    await Promise.allSettled(
      (thumb?.getAnimations() ?? []).map((animation) => animation.finished),
    );
  };

  // clientLeft and clientWidth are the track inside its own borders, which is
  // the box the thumb actually travels. Measuring against the border box would
  // hide a thumb that overshoots by exactly the border width.
  const inner = () => {
    const box = track.getBoundingClientRect();
    return { left: box.left + track.clientLeft, width: track.clientWidth };
  };

  await settle();
  const before = thumb?.getBoundingClientRect() ?? new DOMRect();
  const off = inner();
  const leftGap = before.left - off.left;

  await control.click();
  await expect.element(control).toHaveAttribute("aria-checked", "true");
  await settle();
  const after = thumb?.getBoundingClientRect() ?? new DOMRect();
  const on = inner();
  const rightGap = on.left + on.width - after.right;

  expect(after.left).toBeGreaterThan(before.left);
  // The travel is a calc of four tokens, one of which is the track's own border
  // width. If that term stops matching the real border the thumb stops short or
  // hangs over the edge, and only an inside-the-borders measurement sees it.
  expect(leftGap).toBeGreaterThan(0);
  expect(rightGap).toBeCloseTo(leftGap, 1);
});

it("draws the shared focus ring when reached from the keyboard", async () => {
  const screen = await render(<Switch aria-label="Snap to grid" />);
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("switch", { name: "Snap to grid" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(element);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).not.toBe("none");
});
