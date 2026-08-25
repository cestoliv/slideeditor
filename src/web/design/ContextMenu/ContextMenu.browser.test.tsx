import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { ContextMenu } from "./ContextMenu.js";

type SlideMenuProps = { onAction?: (action: string) => void };

/* The rows showSlideMenu built by hand at app.js:718-753. */
function SlideMenu({ onAction }: SlideMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          style={{
            width: "300px",
            height: "200px",
            background: "var(--color-line-soft)",
          }}
        >
          Slide 1
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content compact>
        <ContextMenu.Item
          icon="image"
          onSelect={() => {
            onAction?.("change");
          }}
        >
          Change
        </ContextMenu.Item>
        <ContextMenu.Item
          icon="trash"
          danger
          onSelect={() => {
            onAction?.("remove");
          }}
        >
          Remove
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

async function openAt(target: Element, x: number, y: number) {
  await userEvent.click(target, { button: "right", position: { x, y } });
}

it("opens on a right click", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await expect.element(screen.getByRole("menuitem", { name: "Change" })).toBeVisible();
});

it("opens at the pointer rather than at the target", async () => {
  const screen = await render(<SlideMenu />);
  const target = screen.getByText("Slide 1").element();
  const box = target.getBoundingClientRect();
  await openAt(target, 200, 150);
  const opened = screen.getByRole("menu");
  await expect.element(opened).toBeVisible();
  const menuBox = opened.element().getBoundingClientRect();
  const pointer = { x: box.left + 200, y: box.top + 150 };
  // Radix anchors a virtual element at the cursor, which is what
  // positionLayerMenu(menu, event.clientX, event.clientY) did by hand.
  expect(Math.abs(menuBox.left - pointer.x)).toBeLessThan(12);
  expect(Math.abs(menuBox.top - pointer.y)).toBeLessThan(12);
});

it("follows the pointer when it opens somewhere else", async () => {
  const screen = await render(<SlideMenu />);
  const target = screen.getByText("Slide 1").element();
  await openAt(target, 30, 20);
  await expect.element(screen.getByRole("menu")).toBeVisible();
  const first = screen.getByRole("menu").element().getBoundingClientRect().left;
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("menu").query()).toBe(null);
  await openAt(target, 220, 20);
  await expect.element(screen.getByRole("menu")).toBeVisible();
  const second = screen.getByRole("menu").element().getBoundingClientRect().left;
  expect(second - first).toBeGreaterThan(150);
});

it("moves the highlight with the arrow keys and picks with Enter", async () => {
  const picked: string[] = [];
  const screen = await render(
    <SlideMenu
      onAction={(action) => {
        picked.push(action);
      }}
    />,
  );
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Change");
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Remove");
  await userEvent.keyboard("{Enter}");
  expect(picked).toEqual(["remove"]);
});

it("wraps from the last row back to the first", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await userEvent.keyboard("{ArrowUp}");
  // Up from nothing lands on the last row, which is how a menu is meant to work
  // and is something none of the five hand-rolled ones did.
  await expect.poll(() => document.activeElement?.textContent).toBe("Remove");
});

it("closes on Escape", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("menu").query()).toBe(null);
});

it("closes once a row is picked", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await screen.getByRole("menuitem", { name: "Change" }).click();
  await expect.poll(() => screen.getByRole("menu").query()).toBe(null);
});

it("paints a destructive row in the danger colour", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  const row = screen.getByRole("menuitem", { name: "Remove" });
  await expect.element(row).toBeVisible();
  expect(getComputedStyle(row.element()).color).toBe("rgb(167, 33, 58)");
});

it("takes the same menu rung and the same surface as the dropdown", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  const menu = screen.getByRole("menu");
  await expect.element(menu).toBeVisible();
  const style = getComputedStyle(menu.element());
  expect(style.zIndex).toBe("80");
  // compact is the .layer-menu--confirm width of styles.css:2630.
  expect(style.minWidth).toBe("132px");
});

it("paints the highlighted row so a keyboard user can see where they are", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Change");

  const highlighted = screen.getByRole("menuitem", { name: "Change" }).element();
  const quiet = screen.getByRole("menuitem", { name: "Remove" }).element();
  await Promise.allSettled(
    highlighted.getAnimations().map((animation) => animation.finished),
  );
  // Both menus share menu/menu.module.css, so this is the same rule the dropdown
  // pins. Both are asserted, because a shared rule with one owner has no owner.
  expect(getComputedStyle(highlighted).backgroundColor).not.toBe(
    getComputedStyle(quiet).backgroundColor,
  );
  expect(getComputedStyle(quiet).backgroundColor).toBe("rgba(0, 0, 0, 0)");
});

it("gives the highlighted row the whole shared ring, not half of it", async () => {
  const screen = await render(<SlideMenu />);
  await openAt(screen.getByText("Slide 1").element(), 40, 30);
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Change");

  const style = getComputedStyle(
    screen.getByRole("menuitem", { name: "Change" }).element(),
  );
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
});
