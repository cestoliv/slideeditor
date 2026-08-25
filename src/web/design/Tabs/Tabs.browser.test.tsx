import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Tabs } from "./Tabs.js";

function Inspector({ disableLayers = false }: { disableLayers?: boolean }) {
  return (
    <Tabs.Root defaultValue="slide">
      <Tabs.List aria-label="Inspector">
        <Tabs.Trigger value="slide">Slide</Tabs.Trigger>
        <Tabs.Trigger value="layers" disabled={disableLayers}>
          Layers
        </Tabs.Trigger>
        <Tabs.Trigger value="export">Export</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="slide">Background and ratio</Tabs.Content>
      <Tabs.Content value="layers">Order and crop</Tabs.Content>
      <Tabs.Content value="export">Size and format</Tabs.Content>
    </Tabs.Root>
  );
}

it("shows only the panel of the selected tab", async () => {
  const screen = await render(<Inspector />);
  await expect.element(screen.getByText("Background and ratio")).toBeVisible();
  expect(screen.getByText("Order and crop").query()).toBe(null);
});

it("moves between tabs with the arrow keys and the panel follows", async () => {
  const screen = await render(<Inspector />);
  await userEvent.keyboard("{Tab}");
  expect(screen.getByRole("tab", { name: "Slide" }).element()).toBe(
    document.activeElement,
  );
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(screen.getByRole("tab", { name: "Layers" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByText("Order and crop")).toBeVisible();
  expect(screen.getByText("Background and ratio").query()).toBe(null);
});

it("wraps from the last tab round to the first", async () => {
  const screen = await render(<Inspector />);
  await userEvent.keyboard("{Tab}");
  await userEvent.keyboard("{ArrowLeft}");
  await expect
    .element(screen.getByRole("tab", { name: "Export" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByText("Size and format")).toBeVisible();
});

it("jumps to each end with Home and End", async () => {
  const screen = await render(<Inspector />);
  await userEvent.keyboard("{Tab}{End}");
  await expect
    .element(screen.getByRole("tab", { name: "Export" }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Home}");
  await expect
    .element(screen.getByRole("tab", { name: "Slide" }))
    .toHaveAttribute("aria-selected", "true");
});

it("steps over a disabled tab", async () => {
  const screen = await render(<Inspector disableLayers />);
  await userEvent.keyboard("{Tab}{ArrowRight}");
  await expect
    .element(screen.getByRole("tab", { name: "Export" }))
    .toHaveAttribute("aria-selected", "true");
});

it("puts one stop in the tab order, not one per tab", async () => {
  const screen = await render(<Inspector />);
  await userEvent.keyboard("{Tab}");
  const slide = screen.getByRole("tab", { name: "Slide" }).element();
  const layers = screen.getByRole("tab", { name: "Layers" }).element();
  // The roving tabindex is what stops a six tab rail from costing six Tab presses.
  expect(slide.getAttribute("tabindex")).toBe("0");
  expect(layers.getAttribute("tabindex")).toBe("-1");
});

it("ties each tab to the panel it governs", async () => {
  const screen = await render(<Inspector />);
  const tab = screen.getByRole("tab", { name: "Slide" }).element();
  const panel = screen.getByRole("tabpanel").element();
  expect(tab.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
});

it("selects on click too", async () => {
  const screen = await render(<Inspector />);
  await screen.getByRole("tab", { name: "Export" }).click();
  await expect.element(screen.getByText("Size and format")).toBeVisible();
});

it("marks the selected tab so it reads as chosen, not merely hovered", async () => {
  const screen = await render(<Inspector />);
  const selected = screen.getByRole("tab", { name: "Slide" }).element();
  const other = screen.getByRole("tab", { name: "Export" }).element();
  await Promise.allSettled(selected.getAnimations().map((a) => a.finished));
  expect(getComputedStyle(selected).backgroundColor).not.toBe(
    getComputedStyle(other).backgroundColor,
  );
});

it("draws the shared focus ring when reached from the keyboard", async () => {
  const screen = await render(<Inspector />);
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("tab", { name: "Slide" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(element);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).not.toBe("none");
});
