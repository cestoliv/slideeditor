import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Field } from "../Field/Field.js";
import { Select } from "./Select.js";
import type { SelectOption } from "./Select.js";

const ratios: readonly SelectOption[] = [
  { value: "9:16", label: "Vertical" },
  { value: "1:1", label: "Square" },
  { value: "4:5", label: "Portrait" },
  { value: "16:9", label: "Landscape", disabled: true },
];

function Controlled({ named = true }: { named?: boolean }) {
  // Radix reads the empty string as "nothing chosen", which keeps the control
  // controlled from the first render while still showing the placeholder.
  const [value, setValue] = useState("");
  return (
    <Select
      items={ratios}
      placeholder="Choose a ratio"
      {...(named ? { "aria-label": "Ratio" } : {})}
      value={value}
      onValueChange={setValue}
    />
  );
}

it("shows the placeholder until a value is chosen", async () => {
  const screen = await render(<Controlled />);
  await expect
    .element(screen.getByRole("combobox", { name: "Ratio" }))
    .toHaveTextContent("Choose a ratio");
});

it("opens on click and lists every option", async () => {
  const screen = await render(<Controlled />);
  await screen.getByRole("combobox", { name: "Ratio" }).click();
  await expect.element(screen.getByRole("option", { name: "Vertical" })).toBeVisible();
  await expect.element(screen.getByRole("option", { name: "Landscape" })).toBeVisible();
});

it("picks a value with the keyboard and reports it on the trigger", async () => {
  const screen = await render(<Controlled />);
  const trigger = screen.getByRole("combobox", { name: "Ratio" });
  await userEvent.keyboard("{Tab}");
  expect(trigger.element()).toBe(document.activeElement);
  // Enter opens the listbox, the arrow moves the highlight, Enter commits.
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("listbox")).toBeVisible();
  // Radix moves focus into the list a frame after it opens, so pressing the
  // arrow before that lands nowhere and the test would pass on the first option.
  await expect.poll(() => document.activeElement?.textContent).toBe("Vertical");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Square");
  await userEvent.keyboard("{Enter}");
  await expect.element(trigger).toHaveTextContent("Square");
});

it("returns focus to the trigger once a value is picked", async () => {
  const screen = await render(<Controlled />);
  const trigger = screen.getByRole("combobox", { name: "Ratio" });
  await trigger.click();
  await screen.getByRole("option", { name: "Portrait" }).click();
  await expect.element(trigger).toHaveTextContent("Portrait");
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("closes on Escape and keeps the value it had", async () => {
  const screen = await render(<Controlled />);
  const trigger = screen.getByRole("combobox", { name: "Ratio" });
  await trigger.click();
  await expect.element(screen.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("listbox").query()).toBe(null);
  await expect.element(trigger).toHaveTextContent("Choose a ratio");
});

it("marks the chosen option as selected when the list reopens", async () => {
  const screen = await render(<Controlled />);
  const trigger = screen.getByRole("combobox", { name: "Ratio" });
  await trigger.click();
  await screen.getByRole("option", { name: "Square" }).click();
  await trigger.click();
  await expect
    .element(screen.getByRole("option", { name: "Square" }))
    .toHaveAttribute("aria-selected", "true");
  await expect
    .element(screen.getByRole("option", { name: "Vertical" }))
    .toHaveAttribute("aria-selected", "false");
});

it("refuses a disabled option", async () => {
  const screen = await render(<Controlled />);
  const trigger = screen.getByRole("combobox", { name: "Ratio" });
  await trigger.click();
  await screen.getByRole("option", { name: "Landscape" }).click({ force: true });
  // The list stays open and nothing was chosen, because the row does not respond.
  await expect.element(screen.getByRole("listbox")).toBeVisible();
});

it("takes its name and description from a surrounding Field", async () => {
  const screen = await render(
    <Field label="Ratio" hint="Vertical exports at 1080 by 1920.">
      <Controlled named={false} />
    </Field>,
  );
  const trigger = screen.getByRole("combobox", { name: "Ratio" }).element();
  const describedBy = trigger.getAttribute("aria-describedby");
  expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
    "Vertical exports at 1080 by 1920.",
  );
});

it("inherits the invalid state from a Field carrying an error", async () => {
  const screen = await render(
    <Field label="Ratio" error="Pick a ratio before exporting.">
      <Controlled named={false} />
    </Field>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Ratio" }))
    .toHaveAttribute("aria-invalid", "true");
});

it("does not open when it is disabled", async () => {
  const screen = await render(
    <Select items={ratios} aria-label="Ratio" disabled placeholder="Choose a ratio" />,
  );
  await screen.getByRole("combobox", { name: "Ratio" }).click({ force: true });
  expect(screen.getByRole("listbox").query()).toBe(null);
});

it("draws the shared focus ring when reached from the keyboard", async () => {
  const screen = await render(<Controlled />);
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("combobox", { name: "Ratio" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(element);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).not.toBe("none");
});

it("paints the highlighted option so a keyboard user can see where they are", async () => {
  const screen = await render(<Controlled />);
  await screen.getByRole("combobox", { name: "Ratio" }).click();
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Square");

  const highlighted = screen.getByRole("option", { name: "Square" }).element();
  const quiet = screen.getByRole("option", { name: "Portrait" }).element();
  await Promise.allSettled(
    highlighted.getAnimations().map((animation) => animation.finished),
  );
  // The listbox borrows the menu's row from menu/menu.module.css, so the same
  // rule carries the position here.
  expect(getComputedStyle(highlighted).backgroundColor).not.toBe(
    getComputedStyle(quiet).backgroundColor,
  );
  expect(getComputedStyle(quiet).backgroundColor).toBe("rgba(0, 0, 0, 0)");
});

it("passes a caller's DOM props through to the trigger", async () => {
  const screen = await render(
    <Select
      items={ratios}
      aria-label="Ratio"
      placeholder="Choose a ratio"
      id="project-ratio"
      data-testid="ratio-select"
      title="Pick an aspect ratio"
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Ratio" }).element();
  // The props type is built from the Radix trigger's, so anything that belongs on
  // a button reaches the button rather than being silently dropped by a closed
  // twelve key object.
  expect(trigger.id).toBe("project-ratio");
  expect(trigger.getAttribute("data-testid")).toBe("ratio-select");
  expect(trigger.getAttribute("title")).toBe("Pick an aspect ratio");
});

it("reports opening and closing to a caller that is watching", async () => {
  const states: boolean[] = [];
  const screen = await render(
    <Select
      items={ratios}
      aria-label="Ratio"
      placeholder="Choose a ratio"
      onOpenChange={(next) => {
        states.push(next);
      }}
    />,
  );
  // onOpenChange lives on the Radix Root, which a closed props type made
  // unreachable. A rail that has to close a neighbouring panel needs it.
  await screen.getByRole("combobox", { name: "Ratio" }).click();
  await expect.element(screen.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("listbox").query()).toBe(null);
  expect(states).toEqual([true, false]);
});
