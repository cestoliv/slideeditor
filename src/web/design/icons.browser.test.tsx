import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "./tokens.css";
import { Icon, iconNames } from "./icons.js";

it("hides the glyph from assistive technology when it has no title", async () => {
  const screen = await render(<Icon name="check" data-testid="glyph" />);
  const svg = screen.getByTestId("glyph").element();
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.hasAttribute("role")).toBe(false);
});

it("becomes a labelled image when it has a title", async () => {
  const screen = await render(<Icon name="check" title="Saved" />);
  await expect.element(screen.getByRole("img", { name: "Saved" })).toBeVisible();
});

it("takes the icon size token when no size is given", async () => {
  const screen = await render(<Icon name="plus" data-testid="glyph" />);
  const svg = screen.getByTestId("glyph").element();
  expect(svg.getAttribute("style")).toContain("var(--icon-size)");
});

it("accepts an explicit pixel size", async () => {
  const screen = await render(<Icon name="plus" size={32} data-testid="glyph" />);
  const svg = screen.getByTestId("glyph").element();
  expect(getComputedStyle(svg).width).toBe("32px");
});

it("keeps its size when the caller passes a style", async () => {
  const screen = await render(
    <Icon name="trash" style={{ opacity: 0.5 }} data-testid="glyph" />,
  );
  const style = getComputedStyle(screen.getByTestId("glyph").element());
  // The caller's style must merge over the box, never replace it.
  expect(style.opacity).toBe("0.5");
  expect(style.width).toBe("18px");
  expect(style.height).toBe("18px");
});

it("lets a caller override the size through style when they mean to", async () => {
  const screen = await render(
    <Icon name="trash" style={{ width: "40px" }} data-testid="glyph" />,
  );
  expect(getComputedStyle(screen.getByTestId("glyph").element()).width).toBe("40px");
});

it("draws every name in the map", async () => {
  const screen = await render(
    <>
      {iconNames.map((name) => (
        <Icon key={name} name={name} title={name} />
      ))}
    </>,
  );
  for (const name of iconNames) {
    await expect
      .element(screen.getByRole("img", { name, exact: true }))
      .toBeInTheDocument();
  }
});
