import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Button } from "../Button/Button.js";
import { IconButton } from "../IconButton/IconButton.js";
import { Tooltip } from "./Tooltip.js";

function Toolbar() {
  return (
    <>
      <Tooltip content="Bring to front" delayDuration={0}>
        <IconButton icon="front" label="Bring to front" />
      </Tooltip>
      <Button>After the tooltip</Button>
    </>
  );
}

it("appears on hover", async () => {
  const screen = await render(<Toolbar />);
  await userEvent.hover(screen.getByRole("button", { name: "Bring to front" }));
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
});

it("appears on keyboard focus, which a title attribute never did", async () => {
  const screen = await render(<Toolbar />);
  await userEvent.keyboard("{Tab}");
  expect(screen.getByRole("button", { name: "Bring to front" }).element()).toBe(
    document.activeElement,
  );
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
});

it("describes its trigger, so the label is read whether it opens or not", async () => {
  const screen = await render(<Toolbar />);
  await userEvent.keyboard("{Tab}");
  const trigger = screen.getByRole("button", { name: "Bring to front" }).element();
  const describedBy = trigger.getAttribute("aria-describedby");
  expect(describedBy).not.toBe(null);
  expect(document.getElementById(describedBy ?? "")?.textContent).toBe("Bring to front");
});

it("is not focusable itself", async () => {
  const screen = await render(<Toolbar />);
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  const tooltip = screen.getByRole("tooltip").element();
  expect(tooltip.hasAttribute("tabindex")).toBe(false);

  // Tab goes past the tooltip to the next control, never into it.
  await userEvent.keyboard("{Tab}");
  await expect
    .poll(() => document.activeElement)
    .toBe(screen.getByRole("button", { name: "After the tooltip" }).element());
});

it("closes on Escape while the trigger keeps focus", async () => {
  const screen = await render(<Toolbar />);
  const trigger = screen.getByRole("button", { name: "Bring to front" });
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("tooltip").query()).toBe(null);
  expect(trigger.element()).toBe(document.activeElement);
});

it("closes when the trigger loses focus", async () => {
  const screen = await render(<Toolbar />);
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => screen.getByRole("tooltip").query()).toBe(null);
});

it("closes when the trigger is pressed", async () => {
  const screen = await render(<Toolbar />);
  const trigger = screen.getByRole("button", { name: "Bring to front" });
  await userEvent.hover(trigger);
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  // The tip explains a control that has not been used yet, so once it is used
  // the tip is in the way.
  await trigger.click();
  await expect.poll(() => screen.getByRole("tooltip").query()).toBe(null);
});

it("works with no Provider above it", async () => {
  // Radix throws without a Provider, so a Tooltip mounts its own when it has to.
  const screen = await render(
    <Tooltip content="Standalone" delayDuration={0}>
      <Button>Bare</Button>
    </Tooltip>,
  );
  await userEvent.hover(screen.getByRole("button", { name: "Bare" }));
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
});

it("uses the Provider above it when the app mounts one", async () => {
  const screen = await render(
    <Tooltip.Provider delayDuration={0}>
      <Tooltip content="Provided">
        <Button>Wrapped</Button>
      </Tooltip>
    </Tooltip.Provider>,
  );
  // The Provider's delay wins, so the tooltip is instant despite this Tooltip
  // carrying no delayDuration of its own.
  await userEvent.hover(screen.getByRole("button", { name: "Wrapped" }));
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
});

it("sits above a popover on the stacking scale", async () => {
  const screen = await render(<Toolbar />);
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  // A tooltip on a control inside a popover has to clear the popover, so 95 to 90.
  const painted = document.querySelector("[data-radix-popper-content-wrapper] > *");
  expect(getComputedStyle(painted as Element).zIndex).toBe("95");
});

it("clears a native title on its trigger, so only one tip shows", async () => {
  const screen = await render(<Toolbar />);
  const trigger = screen.getByRole("button", { name: "Bring to front" }).element();
  // IconButton sets title from its label. Two tooltips on one control is worse
  // than either alone, and the native one cannot be styled or reached by keyboard.
  expect(trigger.hasAttribute("title")).toBe(false);
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
});

it("still works on a trigger that never had a title", async () => {
  const screen = await render(
    <Tooltip content="Tip" delayDuration={0}>
      <Button>Plain</Button>
    </Tooltip>,
  );
  await userEvent.hover(screen.getByRole("button", { name: "Plain" }));
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
});

it("passes the Radix root's own props through", async () => {
  let opens = 0;
  const screen = await render(
    <Tooltip
      content="Bring to front"
      delayDuration={0}
      disableHoverableContent
      onOpenChange={(open) => {
        if (open) opens += 1;
      }}
    >
      <Button>Watched</Button>
    </Tooltip>,
  );
  // TooltipProps is built from the Radix Root's, so disableHoverableContent and
  // onOpenChange are reachable rather than dropped by a closed object type.
  await userEvent.hover(screen.getByRole("button", { name: "Watched" }));
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  expect(opens).toBe(1);
});
