import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Button } from "../Button/Button.js";
import { DropdownMenu } from "./DropdownMenu.js";

type LayerMenuProps = { onAction?: (action: string) => void };

/* The rows showLayerMenu built by hand at app.js:641-681. */
function LayerMenu({ onAction }: LayerMenuProps) {
  return (
    <>
      <Button>Elsewhere on the page</Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button>Layer actions</Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            icon="front"
            onSelect={() => {
              onAction?.("front");
            }}
          >
            Bring to front
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon="up"
            onSelect={() => {
              onAction?.("up");
            }}
          >
            Bring up a level
          </DropdownMenu.Item>
          <DropdownMenu.Item icon="crop" disabled>
            Crop
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            icon="trash"
            danger
            onSelect={() => {
              onAction?.("remove");
            }}
          >
            Remove
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </>
  );
}

/* The shape of showRatioMenu at app.js:806, which was a radio group in disguise. */
function RatioMenu() {
  const [ratio, setRatio] = useState("9:16");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button>Ratio</Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.RadioGroup value={ratio} onValueChange={setRatio}>
          <DropdownMenu.RadioItem value="9:16" tag="TikTok">
            Vertical
          </DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="1:1" tag="Instagram">
            Square
          </DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

it("opens from its trigger and lists its rows", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await expect
    .element(screen.getByRole("menuitem", { name: "Bring to front" }))
    .toBeVisible();
});

it("moves the highlight with the arrow keys and picks with Enter", async () => {
  const picked: string[] = [];
  const screen = await render(
    <LayerMenu
      onAction={(action) => {
        picked.push(action);
      }}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Layer actions" });
  await userEvent.keyboard("{Tab}{Tab}");
  expect(trigger.element()).toBe(document.activeElement);
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring to front");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring up a level");
  await userEvent.keyboard("{Enter}");
  expect(picked).toEqual(["up"]);
});

it("steps over a disabled row rather than landing on it", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  // A pointer opens the menu with nothing highlighted, so the first press lands
  // on the first row. Then Crop is stepped over and the third press hits Remove.
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring to front");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring up a level");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Remove");
});

it("closes on Escape and gives focus back to the trigger", async () => {
  const screen = await render(<LayerMenu />);
  const trigger = screen.getByRole("button", { name: "Layer actions" });
  await trigger.click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("menu").query()).toBe(null);
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("closes on a click outside itself", async () => {
  const screen = await render(<LayerMenu />);
  // Grab it first: an open menu hides the rest of the page from the
  // accessibility tree, so getByRole stops finding anything outside it.
  const outside = screen.getByRole("button", { name: "Elsewhere on the page" }).element();
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await userEvent.click(outside, { force: true });
  await expect.poll(() => screen.getByRole("menu").query()).toBe(null);
});

it("gives focus back to the trigger after a row is picked", async () => {
  const screen = await render(<LayerMenu />);
  const trigger = screen.getByRole("button", { name: "Layer actions" });
  await trigger.click();
  await screen.getByRole("menuitem", { name: "Bring to front" }).click();
  await expect.poll(() => screen.getByRole("menu").query()).toBe(null);
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("does not fire a disabled row", async () => {
  const picked: string[] = [];
  const screen = await render(
    <LayerMenu
      onAction={(action) => {
        picked.push(action);
      }}
    />,
  );
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await screen.getByRole("menuitem", { name: "Crop" }).click({ force: true });
  expect(picked).toEqual([]);
  await expect.element(screen.getByRole("menu")).toBeVisible();
});

it("paints a destructive row in the danger colour", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  const remove = screen.getByRole("menuitem", { name: "Remove" }).element();
  const plain = screen.getByRole("menuitem", { name: "Bring to front" }).element();
  // The danger tint is the whole point of the prop, so it is worth asserting.
  expect(getComputedStyle(remove).color).toBe("rgb(167, 33, 58)");
  expect(getComputedStyle(plain).color).not.toBe(getComputedStyle(remove).color);
});

it("reports which row of a radio group is chosen, and moves the mark", async () => {
  const screen = await render(<RatioMenu />);
  const trigger = screen.getByRole("button", { name: "Ratio" });
  await trigger.click();
  await expect
    .element(screen.getByRole("menuitemradio", { name: "Vertical TikTok" }))
    .toHaveAttribute("aria-checked", "true");
  await screen.getByRole("menuitemradio", { name: "Square Instagram" }).click();
  await trigger.click();
  await expect
    .element(screen.getByRole("menuitemradio", { name: "Square Instagram" }))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(screen.getByRole("menuitemradio", { name: "Vertical TikTok" }))
    .toHaveAttribute("aria-checked", "false");
});

it("keeps the labels of a radio group in one column, checked or not", async () => {
  const screen = await render(<RatioMenu />);
  await screen.getByRole("button", { name: "Ratio" }).click();
  const checked = screen
    .getByRole("menuitemradio", { name: "Vertical TikTok" })
    .element();
  const unchecked = screen
    .getByRole("menuitemradio", { name: "Square Instagram" })
    .element();
  // The label is the last span on the row: the tag beside it is an <em>, and the
  // check that only the chosen row renders comes before it.
  const labelLeft = (row: Element) =>
    [...row.querySelectorAll("span")].at(-1)?.getBoundingClientRect().left ?? 0;
  // The indicator column is reserved on both rows, so the text does not jump by
  // 16px when the selection moves. That is the .menu-icon-space of styles.css:2666.
  expect(labelLeft(checked)).toBe(labelLeft(unchecked));
});

it("takes the menu rung of the stacking scale", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  const menu = screen.getByRole("menu");
  await expect.element(menu).toBeVisible();
  expect(getComputedStyle(menu.element()).zIndex).toBe("80");
});

it("paints the highlighted row so a keyboard user can see where they are", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring to front");

  const highlighted = screen.getByRole("menuitem", { name: "Bring to front" }).element();
  const quiet = screen.getByRole("menuitem", { name: "Bring up a level" }).element();
  await Promise.allSettled(
    highlighted.getAnimations().map((animation) => animation.finished),
  );
  // The wash is the only thing that says which row the arrow keys are on. The
  // five menus it replaces had :hover and nothing else, so a keyboard user had
  // no position at all.
  expect(getComputedStyle(highlighted).backgroundColor).not.toBe(
    getComputedStyle(quiet).backgroundColor,
  );
  expect(getComputedStyle(quiet).backgroundColor).toBe("rgba(0, 0, 0, 0)");
});

it("gives the highlighted row the whole shared ring, not half of it", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring to front");

  const row = screen.getByRole("menuitem", { name: "Bring to front" }).element();
  const style = getComputedStyle(row);
  // An outline: none on the highlight rule beats reset.css regardless of order,
  // which left menu rows the one control in the system showing ink and no cyan.
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
});

it("leaves room inside the panel for the ring the rows draw", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring to front");

  const panel = screen.getByRole("menu").element();
  const row = screen.getByRole("menuitem", { name: "Bring to front" }).element();
  const padding = parseFloat(getComputedStyle(panel).paddingLeft);
  const ring =
    parseFloat(getComputedStyle(row).outlineOffset) +
    parseFloat(getComputedStyle(row).outlineWidth) +
    1;
  // The ring extends five pixels past the row. Four pixels of panel padding, the
  // legacy value, would let the band cross the panel's own border.
  expect(padding).toBeGreaterThanOrEqual(ring);
});

/*
 * Radix sets outline: none inline on the menu surface, which no stylesheet can
 * beat, and it is right to: the panel is a container, and a ring around the
 * whole menu on top of the ring on the row inside it is two indicators for one
 * position. This pins the exception so it stays deliberate.
 */
it("does not ring the panel itself, only the row inside it", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  const panel = screen.getByRole("menu").element();
  await expect.poll(() => document.activeElement).toBe(panel);
  expect(getComputedStyle(panel).outlineStyle).toBe("none");

  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Bring to front");
  // Focus does not stay on the panel: the first arrow key moves it to a row that
  // does show the ring, so the container is never the resting place.
  expect(document.activeElement).not.toBe(panel);
  expect(getComputedStyle(document.activeElement as Element).outlineStyle).toBe("solid");
});

it("jumps to a row when its name is typed", async () => {
  const screen = await render(<LayerMenu />);
  await screen.getByRole("button", { name: "Layer actions" }).click();
  await expect.element(screen.getByRole("menu")).toBeVisible();
  // Type ahead. None of the five hand-rolled menus had it, and a menu of eight
  // layer commands is exactly where it saves a keyboard user the arrow keys.
  await userEvent.keyboard("rem");
  await expect.poll(() => document.activeElement?.textContent).toBe("Remove");
});
