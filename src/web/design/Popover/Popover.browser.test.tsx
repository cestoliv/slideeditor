import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Button } from "../Button/Button.js";
import { Input } from "../Input/Input.js";
import { Popover } from "./Popover.js";

function CustomRatio() {
  return (
    <>
      <Button>Elsewhere on the page</Button>
      <Popover.Root>
        <Popover.Trigger asChild>
          <Button>Custom ratio</Button>
        </Popover.Trigger>
        <Popover.Content aria-label="Custom ratio">
          <Input aria-label="Ratio width" defaultValue="9" />
          <Input aria-label="Ratio height" defaultValue="16" />
          <Popover.Close asChild>
            <Button variant="solid">Apply</Button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Root>
    </>
  );
}

it("opens from its trigger", async () => {
  const screen = await render(<CustomRatio />);
  await screen.getByRole("button", { name: "Custom ratio" }).click();
  await expect
    .element(screen.getByRole("dialog", { name: "Custom ratio" }))
    .toBeVisible();
});

it("moves focus into the panel so the form is usable at once", async () => {
  const screen = await render(<CustomRatio />);
  await screen.getByRole("button", { name: "Custom ratio" }).click();
  await expect
    .element(screen.getByRole("dialog", { name: "Custom ratio" }))
    .toBeVisible();
  const panel = screen.getByRole("dialog", { name: "Custom ratio" }).element();
  await expect.poll(() => panel.contains(document.activeElement)).toBe(true);
});

it("closes on Escape and gives focus back to the trigger", async () => {
  const screen = await render(<CustomRatio />);
  const trigger = screen.getByRole("button", { name: "Custom ratio" });
  await trigger.click();
  await expect
    .element(screen.getByRole("dialog", { name: "Custom ratio" }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .poll(() => screen.getByRole("dialog", { name: "Custom ratio" }).query())
    .toBe(null);
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("closes on a click outside itself", async () => {
  const screen = await render(<CustomRatio />);
  await screen.getByRole("button", { name: "Custom ratio" }).click();
  await expect
    .element(screen.getByRole("dialog", { name: "Custom ratio" }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Elsewhere on the page" }).click();
  await expect
    .poll(() => screen.getByRole("dialog", { name: "Custom ratio" }).query())
    .toBe(null);
});

it("closes from a Close button and gives focus back to the trigger", async () => {
  const screen = await render(<CustomRatio />);
  const trigger = screen.getByRole("button", { name: "Custom ratio" });
  await trigger.click();
  await screen.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(() => screen.getByRole("dialog", { name: "Custom ratio" }).query())
    .toBe(null);
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("keeps the controls inside it working", async () => {
  const screen = await render(<CustomRatio />);
  await screen.getByRole("button", { name: "Custom ratio" }).click();
  const width = screen.getByRole("textbox", { name: "Ratio width" });
  await width.fill("4");
  await expect.element(width).toHaveValue("4");
  // Typing inside the panel must not dismiss it, which a naive outside-click
  // handler on document would have done.
  await expect
    .element(screen.getByRole("dialog", { name: "Custom ratio" }))
    .toBeVisible();
});

it("sits above a menu and below a tooltip on the stacking scale", async () => {
  const screen = await render(<CustomRatio />);
  await screen.getByRole("button", { name: "Custom ratio" }).click();
  const opened = screen.getByRole("dialog", { name: "Custom ratio" });
  await expect.element(opened).toBeVisible();
  const panel = opened.element();
  // The rung, not a number invented here: --z-popover is 90.
  expect(getComputedStyle(panel).zIndex).toBe("90");
});

it("draws the shared focus ring on a panel that holds nothing focusable", async () => {
  const screen = await render(
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button>Ratio note</Button>
      </Popover.Trigger>
      <Popover.Content aria-label="Ratio note">
        Instagram accepts 3:4 to 1.91:1. TikTok takes this one.
      </Popover.Content>
    </Popover.Root>,
  );
  await userEvent.keyboard("{Tab}{Enter}");
  await expect.element(screen.getByRole("dialog", { name: "Ratio note" })).toBeVisible();
  const panel = screen.getByRole("dialog", { name: "Ratio note" }).element();
  // A panel that reports rather than asks holds no focusable child, so Radix
  // gives it focus. Every popover that is a readout lands here.
  await expect.poll(() => document.activeElement).toBe(panel);
  expect(panel.matches(":focus-visible")).toBe(true);

  const style = getComputedStyle(panel);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  // .content paints --shadow-raised, which outranks :focus-visible and would
  // replace the whole indicator if the ring were not composed back in.
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
  expect(style.boxShadow).toContain("rgba(26, 24, 20, 0.1)");
});
