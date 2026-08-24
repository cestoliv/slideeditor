import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Button } from "../Button/Button.js";
import { Input } from "../Input/Input.js";
import { Dialog } from "./Dialog.js";

function Rename() {
  return (
    <>
      <Button>Behind the dialog</Button>
      <Dialog.Root>
        <Dialog.Trigger asChild>
          <Button>Rename project</Button>
        </Dialog.Trigger>
        <Dialog.Content>
          <Dialog.Title>Rename project</Dialog.Title>
          <Dialog.Description>
            The name shows on the home screen and nowhere else.
          </Dialog.Description>
          <Input aria-label="Project name" defaultValue="Morning routine" />
          <Dialog.Actions>
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <Button variant="solid">Save</Button>
            </Dialog.Close>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

it("opens from its trigger", async () => {
  const screen = await render(<Rename />);
  await screen.getByRole("button", { name: "Rename project" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
});

it("names itself from the title and describes itself from the description", async () => {
  const screen = await render(<Rename />);
  await screen.getByRole("button", { name: "Rename project" }).click();
  const panel = screen.getByRole("dialog", { name: "Rename project" });
  await expect.element(panel).toBeVisible();
  const describedBy = panel.element().getAttribute("aria-describedby");
  expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
    "The name shows on the home screen and nowhere else.",
  );
});

it("traps focus inside itself", async () => {
  const screen = await render(<Rename />);
  // Grab the outside button first. Once the dialog opens Radix hides the rest of
  // the page from the accessibility tree, and getByRole stops finding it.
  const outside = screen.getByRole("button", { name: "Behind the dialog" }).element();
  await screen.getByRole("button", { name: "Rename project" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  const dialog = screen.getByRole("dialog").element();

  // Six presses is more than the dialog holds, so a leak would have shown by now.
  for (let press = 0; press < 6; press += 1) {
    await userEvent.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(outside);
  }
});

it("closes on Escape and gives focus back to the trigger", async () => {
  const screen = await render(<Rename />);
  const trigger = screen.getByRole("button", { name: "Rename project" });
  await trigger.click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => screen.getByRole("dialog").query()).toBe(null);
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("closes from a Close button and gives focus back to the trigger", async () => {
  const screen = await render(<Rename />);
  const trigger = screen.getByRole("button", { name: "Rename project" });
  await trigger.click();
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => screen.getByRole("dialog").query()).toBe(null);
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("closes on a click outside itself", async () => {
  const screen = await render(<Rename />);
  await screen.getByRole("button", { name: "Rename project" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  const box = screen.getByRole("dialog").element().getBoundingClientRect();
  // The backdrop, well clear of the panel.
  await userEvent.click(document.body, {
    position: { x: Math.round(box.left / 2), y: Math.round(box.top / 2) },
  });
  await expect.poll(() => screen.getByRole("dialog").query()).toBe(null);
});

it("hides the page behind it from the accessibility tree", async () => {
  const screen = await render(<Rename />);
  const outside = screen.getByRole("button", { name: "Behind the dialog" }).element();
  expect(outside.closest("[aria-hidden='true']")).toBe(null);

  await screen.getByRole("button", { name: "Rename project" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();

  // A screen reader user must not be able to wander out of an open dialog, so
  // everything that is not the dialog goes behind aria-hidden while it is up.
  await expect.poll(() => outside.closest("[aria-hidden='true']")).not.toBe(null);
  expect(screen.getByRole("button", { name: "Behind the dialog" }).query()).toBe(null);
});

it("puts the panel above its own backdrop", async () => {
  const screen = await render(<Rename />);
  await screen.getByRole("button", { name: "Rename project" }).click();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  const dialog = screen.getByRole("dialog").element();
  const overlay = dialog.previousElementSibling;
  expect(overlay).not.toBe(null);
  // Same rung on the scale, so the later sibling wins and the panel stays legible.
  const panelZ = getComputedStyle(dialog).zIndex;
  expect(panelZ).toBe(getComputedStyle(overlay as Element).zIndex);
  expect(dialog.compareDocumentPosition(overlay as Element)).toBe(
    Node.DOCUMENT_POSITION_PRECEDING,
  );
});

it("draws the shared focus ring on a panel that holds nothing focusable", async () => {
  const screen = await render(
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button>Show the note</Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>Nothing to press</Dialog.Title>
        <Dialog.Description>
          A message only dialog, or one still loading.
        </Dialog.Description>
      </Dialog.Content>
    </Dialog.Root>,
  );
  await userEvent.keyboard("{Tab}{Enter}");
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  const panel = screen.getByRole("dialog").element();
  // Radix focuses the panel itself when it holds no focusable child, so this is
  // a real keyboard destination and not a hypothetical one.
  await expect.poll(() => document.activeElement).toBe(panel);
  expect(panel.matches(":focus-visible")).toBe(true);

  const style = getComputedStyle(panel);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  // The ink companion has to survive the panel's own shadow. Without it the cyan
  // outline stands alone at 1.2:1 on paper, which is the defect part A removed.
  expect(style.boxShadow).toContain("rgb(21, 21, 21) 0px 0px 0px 5px");
  // And the pop shadow is still there, so the fix did not cost the panel its look.
  expect(style.boxShadow).toContain("rgb(37, 244, 238) 9px 9px");
});
