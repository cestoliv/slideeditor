import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import { Inline, Stack } from "./Layout.js";

it("stacks its children in a column", async () => {
  const screen = await render(
    <Stack>
      <span>One</span>
      <span>Two</span>
    </Stack>,
  );
  const stack = screen.getByText("One").element().parentElement;
  expect(stack).not.toBeNull();
  expect(getComputedStyle(stack as Element).flexDirection).toBe("column");
});

it("lays Inline children out in a row", async () => {
  const screen = await render(
    <Inline>
      <span>One</span>
      <span>Two</span>
    </Inline>,
  );
  const inline = screen.getByText("One").element().parentElement;
  expect(getComputedStyle(inline as Element).flexDirection).toBe("row");
});

it("resolves the gap step to a token value", async () => {
  const screen = await render(
    <Stack gap={5}>
      <span>One</span>
    </Stack>,
  );
  const stack = screen.getByText("One").element().parentElement;
  // --space-5 is 24px, so a gap step of 5 must land there and nowhere else.
  expect(getComputedStyle(stack as Element).rowGap).toBe("24px");
});

it("renders a different tag on request", async () => {
  const screen = await render(
    <Inline as="nav" aria-label="Slides">
      <span>One</span>
    </Inline>,
  );
  await expect.element(screen.getByRole("navigation", { name: "Slides" })).toBeVisible();
});

it("adds no role when it renders a plain div", async () => {
  const screen = await render(
    <Stack>
      <span>One</span>
    </Stack>,
  );
  const stack = screen.getByText("One").element().parentElement;
  expect(stack?.tagName).toBe("DIV");
  expect(stack?.hasAttribute("role")).toBe(false);
});
