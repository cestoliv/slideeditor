import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Field } from "../Field/Field.js";
import { Slider } from "./Slider.js";

type ControlledProps = {
  start?: number;
  min?: number;
  max?: number;
  step?: number;
  named?: boolean;
  onChange?: (value: number) => void;
};

function Controlled({
  start = 50,
  min = 0,
  max = 100,
  step = 1,
  named = true,
  onChange,
}: ControlledProps) {
  const [value, setValue] = useState(start);
  return (
    <Slider
      {...(named ? { "aria-label": "Opacity" } : {})}
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

it("reports its value through aria-valuenow", async () => {
  const screen = await render(<Controlled start={40} />);
  await expect
    .element(screen.getByRole("slider", { name: "Opacity" }))
    .toHaveAttribute("aria-valuenow", "40");
});

it("moves one step per arrow key", async () => {
  const screen = await render(<Controlled start={40} />);
  const slider = screen.getByRole("slider", { name: "Opacity" });
  await userEvent.keyboard("{Tab}");
  expect(slider.element()).toBe(document.activeElement);
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "42");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "41");
});

it("clamps at the top and stops emitting once it is there", async () => {
  let last = -1;
  let changes = 0;
  const screen = await render(
    <Controlled
      start={99}
      onChange={(value) => {
        last = value;
        changes += 1;
      }}
    />,
  );
  const slider = screen.getByRole("slider", { name: "Opacity" });
  await userEvent.keyboard("{Tab}");
  await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "100");
  expect(last).toBe(100);
  // Three presses, one real move: a clamped slider must not keep firing at the end.
  expect(changes).toBe(1);
});

it("clamps at the bottom", async () => {
  const screen = await render(<Controlled start={1} />);
  const slider = screen.getByRole("slider", { name: "Opacity" });
  await userEvent.keyboard("{Tab}");
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "0");
});

it("jumps to each end with Home and End", async () => {
  const screen = await render(<Controlled start={50} min={10} max={90} />);
  const slider = screen.getByRole("slider", { name: "Opacity" });
  await userEvent.keyboard("{Tab}");
  await userEvent.keyboard("{Home}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "10");
  await userEvent.keyboard("{End}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "90");
});

it("carries its own min and max into the announcement", async () => {
  const screen = await render(<Controlled start={5} min={1} max={8} />);
  const slider = screen.getByRole("slider", { name: "Opacity" }).element();
  expect(slider.getAttribute("aria-valuemin")).toBe("1");
  expect(slider.getAttribute("aria-valuemax")).toBe("8");
});

it("honours a step larger than one", async () => {
  const screen = await render(<Controlled start={50} step={10} />);
  const slider = screen.getByRole("slider", { name: "Opacity" });
  await userEvent.keyboard("{Tab}{ArrowRight}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "60");
});

it("puts the Field's description on the thumb, where the role is", async () => {
  const screen = await render(
    <Field label="Opacity" hint="Zero hides the layer.">
      <Controlled />
    </Field>,
  );
  const slider = screen.getByRole("slider", { name: "Opacity" }).element();
  const describedBy = slider.getAttribute("aria-describedby");
  expect(describedBy).not.toBe(null);
  expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
    "Zero hides the layer.",
  );
});

/*
 * A <label for> names only a labelable element, and the thumb that carries
 * role="slider" is a span. Switch and Select take their name from a Field for
 * free because both render a real button; a Slider cannot, so it asks for one.
 */
it("still needs its own aria-label inside a Field", async () => {
  const screen = await render(
    <Field label="Opacity">
      <Controlled named={false} />
    </Field>,
  );
  const slider = screen.getByRole("slider").element();
  expect(slider.getAttribute("aria-label")).toBe(null);
  expect(slider.getAttribute("aria-labelledby")).toBe(null);
});

it("fills the track up to the value", async () => {
  // A fixed width, so the ratio below means the same thing on every run.
  const screen = await render(
    <div style={{ width: "200px" }}>
      <Controlled start={25} />
    </div>,
  );
  const slider = screen.getByRole("slider", { name: "Opacity" }).element();
  // Radix wraps the thumb in its own positioning span, so the root is two up.
  const root = slider.parentElement?.parentElement;
  const range = root?.firstElementChild?.firstElementChild;
  expect(range).not.toBe(undefined);
  const rangeWidth = range?.getBoundingClientRect().width ?? 0;
  const rootWidth = root?.getBoundingClientRect().width ?? 1;
  // A quarter of the way along, allowing for the thumb's own width at each end.
  expect(rangeWidth / rootWidth).toBeGreaterThan(0.15);
  expect(rangeWidth / rootWidth).toBeLessThan(0.35);
});

it("does not move when it is disabled", async () => {
  const screen = await render(<Slider aria-label="Opacity" defaultValue={30} disabled />);
  const slider = screen.getByRole("slider", { name: "Opacity" });
  await userEvent.keyboard("{Tab}{ArrowRight}");
  await expect.element(slider).toHaveAttribute("aria-valuenow", "30");
});
