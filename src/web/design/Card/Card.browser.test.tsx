import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import { userEvent } from "vitest/browser";
import "../tokens.css";
import "../reset.css";
import { Card } from "./Card.js";

it("renders its children", async () => {
  const screen = await render(
    <Card>
      <h2>Morning routine</h2>
    </Card>,
  );
  await expect
    .element(screen.getByRole("heading", { name: "Morning routine" }))
    .toBeVisible();
});

it("carries no implicit role of its own", async () => {
  const screen = await render(<Card>Plain surface</Card>);
  const card = screen.getByText("Plain surface").element();
  expect(card.tagName).toBe("DIV");
  expect(card.hasAttribute("role")).toBe(false);
});

it("passes a role through when the caller gives it one", async () => {
  const screen = await render(
    <Card role="group" aria-label="Slide 1">
      Contents
    </Card>,
  );
  await expect.element(screen.getByRole("group", { name: "Slide 1" })).toBeVisible();
});

it("keeps the interactive variant clickable", async () => {
  let clicks = 0;
  const screen = await render(
    <Card
      interactive
      onClick={() => {
        clicks += 1;
      }}
    >
      Open project
    </Card>,
  );
  await screen.getByText("Open project").click();
  expect(clicks).toBe(1);
});

it("scales its padding with the padding prop", async () => {
  const screen = await render(
    <>
      <Card padding="none">None</Card>
      <Card padding="sm">Small</Card>
      <Card padding="lg">Large</Card>
    </>,
  );
  const padding = (label: string) =>
    parseFloat(getComputedStyle(screen.getByText(label).element()).paddingTop);
  expect(padding("None")).toBe(0);
  expect(padding("Small")).toBeGreaterThan(0);
  expect(padding("Large")).toBeGreaterThan(padding("Small"));
});

it("merges a caller className rather than replacing its own", async () => {
  const screen = await render(<Card className="extra">Surface</Card>);
  const card = screen.getByText("Surface").element();
  expect(card.classList.contains("extra")).toBe(true);
  expect(parseFloat(getComputedStyle(card).borderRadius)).toBeGreaterThan(0);
});

it("keeps the focus ring on an interactive card that is hovered and focused", async () => {
  const screen = await render(
    <Card interactive tabIndex={0}>
      Open project
    </Card>,
  );
  const card = screen.getByText("Open project");
  // Tab before hover. Acquisition order does not change which rules match, and
  // the browser's sequential focus starting point survives the previous test's
  // cleanup, so hovering first can leave {Tab} on BODY and fail for no reason.
  await userEvent.keyboard("{Tab}");
  await card.hover();
  const element = card.element();
  expect(element.matches(":hover")).toBe(true);
  expect(element.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(element);
  expect(style.outlineStyle).toBe("solid");
  // The ring plus the raised shadow, so the hover paint did not swallow it.
  expect(style.boxShadow.split("rgb").length - 1).toBeGreaterThanOrEqual(2);
});
