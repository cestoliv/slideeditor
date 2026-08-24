import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Gallery } from "./Gallery.js";

/*
 * The gallery composes every primitive from both halves of the design system, so
 * it is the one place a bad composition shows up without a human looking. These
 * are smoke tests: they check the page comes up and its overlays still work
 * inside it, not that any primitive behaves, which each primitive's own file does.
 */

it("renders every section", async () => {
  const screen = await render(<Gallery />);
  for (const heading of [
    "Tokens",
    "Light and dark",
    "Buttons",
    "Forms",
    "Content",
    "Overlays",
    "Menus",
    "Feedback",
    "Icons",
  ]) {
    await expect.element(screen.getByRole("heading", { name: heading })).toBeVisible();
  }
});

it("resolves the swatch values rather than showing empty chips", async () => {
  const screen = await render(<Gallery />);
  // The swatch reads its own computed value, which is how the same token can
  // report two different colours in the light and dark panels.
  await expect.element(screen.getByText("#151515").first()).toBeVisible();
  await expect.element(screen.getByText("#f4f5f0").first()).toBeVisible();
});

it("opens a dialog from inside the gallery", async () => {
  const screen = await render(<Gallery />);
  await screen.getByRole("button", { name: "Rename project" }).click();
  await expect
    .element(screen.getByRole("dialog", { name: "Rename project" }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .poll(() => screen.getByRole("dialog", { name: "Rename project" }).query())
    .toBe(null);
});

it("pins the theme on the document so portalled overlays follow it", async () => {
  const screen = await render(<Gallery />);
  await screen.getByRole("combobox", { name: "Theme" }).click();
  await screen.getByRole("option", { name: "Dark" }).click();
  // A menu portals to the end of <body>, so pinning the page wrapper would leave
  // every overlay on the operating system's theme.
  await expect
    .poll(() => document.documentElement.getAttribute("data-theme"))
    .toBe("dark");
});

it("fires a toast from the feedback section", async () => {
  const screen = await render(<Gallery />);
  await screen.getByRole("button", { name: "Report a change" }).click();
  await expect
    .element(screen.getByText("Slides are now 9:16 · 1080 × 1920").first())
    .toBeVisible();
});
