import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { IconButton } from "./IconButton.js";

it("takes its accessible name from the label", async () => {
  const screen = await render(<IconButton icon="trash" label="Delete slide" />);
  await expect
    .element(screen.getByRole("button", { name: "Delete slide" }))
    .toBeVisible();
});

it("fires on click", async () => {
  let clicks = 0;
  const screen = await render(
    <IconButton
      icon="plus"
      label="Add slide"
      onClick={() => {
        clicks += 1;
      }}
    />,
  );
  await screen.getByRole("button", { name: "Add slide" }).click();
  expect(clicks).toBe(1);
});

it("carries the label as a hover tooltip", async () => {
  const screen = await render(<IconButton icon="download" label="Download" />);
  await expect
    .element(screen.getByRole("button", { name: "Download" }))
    .toHaveAttribute("title", "Download");
});

it("hides the glyph from assistive technology", async () => {
  const screen = await render(<IconButton icon="edit" label="Rename" />);
  const svg = screen.getByRole("button").element().querySelector("svg");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
});

it("does not fire when disabled", async () => {
  let clicks = 0;
  const screen = await render(
    <IconButton
      icon="trash"
      label="Delete slide"
      disabled
      onClick={() => {
        clicks += 1;
      }}
    />,
  );
  await screen.getByRole("button", { name: "Delete slide" }).click({ force: true });
  expect(clicks).toBe(0);
});

it("takes an image glyph and still requires a label", async () => {
  const screen = await render(
    <IconButton label="Share by AirDrop">
      <img src="/assets/airdrop.svg" alt="" />
    </IconButton>,
  );
  const button = screen.getByRole("button", { name: "Share by AirDrop" }).element();
  const image = button.querySelector("img");
  expect(image).not.toBeNull();
  // The image takes the same box as a glyph from the map.
  expect(getComputedStyle(image as Element).width).toBe("18px");
  // alt="" keeps the image out of the accessible name, which the label owns.
  expect(image?.getAttribute("alt")).toBe("");
});

it("draws the shared focus ring when reached from the keyboard", async () => {
  const screen = await render(<IconButton icon="plus" label="Add slide" />);
  await userEvent.keyboard("{Tab}");
  const style = getComputedStyle(screen.getByRole("button").element());
  expect(style.outlineStyle).toBe("solid");
  expect(style.boxShadow).not.toBe("none");
});

it("merges a caller className rather than replacing its own", async () => {
  const screen = await render(
    <IconButton icon="plus" label="Add slide" className="extra" />,
  );
  const button = screen.getByRole("button").element();
  expect(button.classList.contains("extra")).toBe(true);
  expect(getComputedStyle(button).width).toBe("38px");
});
