import { useEffect } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// The stylesheets as text. A computed z-index cannot tell var(--z-popover) from
// the literal 90, so the rule "no component invents a rung" needs the source.
import dialogCss from "./Dialog/Dialog.module.css?raw";
import menuCss from "./menu/menu.module.css?raw";
import popoverCss from "./Popover/Popover.module.css?raw";
import galleryCss from "./gallery/Gallery.module.css?raw";
import toastCss from "./Toast/Toast.module.css?raw";
import tooltipCss from "./Tooltip/Tooltip.module.css?raw";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "./tokens.css";
import "./reset.css";
import { Button } from "./Button/Button.js";
import { Dialog } from "./Dialog/Dialog.js";
import { DropdownMenu } from "./DropdownMenu/DropdownMenu.js";
import { Popover } from "./Popover/Popover.js";
import { ToastProvider, useToast } from "./Toast/Toast.js";
import { Tooltip } from "./Tooltip/Tooltip.js";

/*
 * Every overlay portals to the end of <body>, so DOM order alone would decide
 * which one paints on top, and that order changes with the order the user opens
 * things. The z-index scale in tokens.css is what makes it deliberate instead.
 * This file is the proof that the five rungs are in the right relation.
 *
 * Each layer is held open through its open prop rather than by clicking, because
 * a pointer press anywhere dismisses the layer under it, and only one of these
 * can ever be reached through the accessibility tree at a time.
 */
function Everything() {
  const { toast } = useToast();

  useEffect(() => {
    toast("Project saved", { duration: Infinity });
  }, [toast]);

  return (
    <Dialog.Root open>
      <Dialog.Content>
        <Dialog.Title>Export</Dialog.Title>
        <DropdownMenu.Root open>
          <DropdownMenu.Trigger asChild>
            <Button>Menu</Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item>Bring to front</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <Popover.Root open>
          <Popover.Trigger asChild>
            <Button>Popover</Button>
          </Popover.Trigger>
          <Popover.Content aria-label="Custom ratio">Ratio</Popover.Content>
        </Popover.Root>
        <Tooltip content="Tip" open>
          <Button>Tipped</Button>
        </Tooltip>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/*
 * The accessibility tree is not usable here: each open layer hides the others
 * from it, which is exactly what those layers are supposed to do. Painting order
 * is a DOM and CSS question, so these read the DOM.
 */
function find(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`nothing matched ${selector}`);
  return element;
}

const rung = (element: Element) => Number(getComputedStyle(element).zIndex);

it("stacks the overlays in the order the design system intends", async () => {
  await render(
    <ToastProvider>
      <Everything />
    </ToastProvider>,
  );

  const dialog = find("[role='dialog'][aria-labelledby]");
  const menu = find("[role='menu']");
  const popover = find("[role='dialog'][aria-label='Custom ratio']");
  const tooltip = find("[role='tooltip']").parentElement;
  const toast = find("ol");

  expect(tooltip).not.toBe(null);
  // A menu opens over the dialog holding it. A tooltip on a control inside a
  // popover clears the popover. A toast reporting a failure clears everything.
  expect(rung(dialog)).toBeLessThan(rung(menu));
  expect(rung(menu)).toBeLessThan(rung(popover));
  expect(rung(popover)).toBeLessThan(rung(tooltip as Element));
  expect(rung(tooltip as Element)).toBeLessThan(rung(toast));
});

it("resolves every rung to the value its token carries", async () => {
  await render(
    <ToastProvider>
      <Everything />
    </ToastProvider>,
  );
  const scale = getComputedStyle(document.documentElement);
  const named = (token: string) => Number(scale.getPropertyValue(token));

  expect(rung(find("[role='dialog'][aria-labelledby]"))).toBe(named("--z-overlay"));
  expect(rung(find("[role='menu']"))).toBe(named("--z-menu"));
  expect(rung(find("[role='dialog'][aria-label='Custom ratio']"))).toBe(
    named("--z-popover"),
  );
  expect(rung(find("[role='tooltip']").parentElement as Element)).toBe(
    named("--z-tooltip"),
  );
  expect(rung(find("ol"))).toBe(named("--z-toast"));
});

/*
 * The test above compares two numbers that are equal whether the stylesheet says
 * var(--z-popover) or the literal 90, so on its own it cannot see a component
 * that has invented a rung. Only the source can.
 *
 * This list is every stylesheet under src/web/design that declares a z-index,
 * checked by grep when it was written. It is hand-maintained, so a new overlay
 * added without an entry here is a gap: the resolution test above still covers
 * whether its rung resolves, but nothing would catch a literal in it.
 */
const stackingStylesheets = [
  ["Dialog", dialogCss],
  ["Popover", popoverCss],
  ["menu", menuCss],
  ["Tooltip", tooltipCss],
  ["Toast", toastCss],
  // The gallery is dev-only and still takes a rung for its sticky nav, so the
  // rule covers it too. Six files, and every z-index in src/web/design is in one.
  ["gallery", galleryCss],
] as const;

it("takes every z-index from the scale rather than writing a number", () => {
  const offScale: string[] = [];

  for (const [name, css] of stackingStylesheets) {
    const declarations = [...css.matchAll(/z-index:\s*([^;]+);/g)].map((match) =>
      (match[1] ?? "").trim(),
    );
    // A stylesheet that has stopped stacking at all is its own regression.
    expect(declarations.length, `${name} declares no z-index`).toBeGreaterThan(0);
    for (const value of declarations) {
      if (!/^var\(--z-[a-z]+\)$/.test(value)) offScale.push(`${name}: ${value}`);
    }
  }

  expect(offScale).toEqual([]);
});

it("leaves a menu inside a dialog clickable, not painted under the backdrop", async () => {
  await render(
    <ToastProvider>
      <Everything />
    </ToastProvider>,
  );
  const item = find("[role='menuitem']");
  const box = item.getBoundingClientRect();
  const hit = document.elementFromPoint(
    Math.round(box.left + box.width / 2),
    Math.round(box.top + box.height / 2),
  );
  // The dialog's backdrop covers the viewport, so a menu on a lower rung would
  // be visible and dead at the same time.
  expect(item.contains(hit)).toBe(true);
});
