import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Button } from "./Button.js";

it("calls onClick when pressed", async () => {
  let clicks = 0;
  const screen = await render(
    <Button
      onClick={() => {
        clicks += 1;
      }}
    >
      Export
    </Button>,
  );
  await screen.getByRole("button", { name: "Export" }).click();
  expect(clicks).toBe(1);
});

it("does not call onClick when disabled", async () => {
  let clicks = 0;
  const screen = await render(
    <Button
      disabled
      onClick={() => {
        clicks += 1;
      }}
    >
      Export
    </Button>,
  );
  await screen.getByRole("button", { name: "Export" }).click({ force: true });
  expect(clicks).toBe(0);
});

it("takes focus from the keyboard and fires on Enter", async () => {
  let clicks = 0;
  await render(
    <Button
      onClick={() => {
        clicks += 1;
      }}
    >
      Export
    </Button>,
  );
  await userEvent.keyboard("{Tab}{Enter}");
  expect(clicks).toBe(1);
});

it("shows a busy state and blocks a second press", async () => {
  let clicks = 0;
  const screen = await render(
    <Button
      busy
      onClick={() => {
        clicks += 1;
      }}
    >
      Export
    </Button>,
  );
  await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  await screen.getByRole("button").click({ force: true });
  expect(clicks).toBe(0);
});

it("draws a visible focus ring when reached from the keyboard", async () => {
  const screen = await render(<Button>Export</Button>);
  await userEvent.keyboard("{Tab}");
  const button = screen.getByRole("button").element();
  const style = getComputedStyle(button);
  // The cyan outline alone is 1.2:1 on paper, so the ink companion has to be there too.
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).not.toBe("none");
});

it("keeps the solid variant's pop shadow while it is focused", async () => {
  const screen = await render(<Button variant="solid">Export</Button>);
  await userEvent.keyboard("{Tab}");
  const shadow = getComputedStyle(screen.getByRole("button").element()).boxShadow;
  // Two shadows: the focus ring first, then the offset pop it must not lose.
  expect(shadow.split("rgb").length - 1).toBeGreaterThanOrEqual(3);
});

it("keeps the ink companion on a solid button that is hovered and focused", async () => {
  const screen = await render(<Button variant="solid">Export</Button>);
  const button = screen.getByRole("button");
  // Both states have to match at once, which is the pairing the specificity bug
  // hit: an unwrapped :not() in the hover rule outranked the focus rule and the
  // ink companion vanished, leaving the 1.2:1 cyan alone.
  await userEvent.keyboard("{Tab}");
  await button.hover();
  const element = button.element();
  expect(element.matches(":hover")).toBe(true);
  expect(element.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(element);
  expect(style.outlineStyle).toBe("solid");
  // The ring plus the two-colour pop shadow: three colours, not one.
  expect(style.boxShadow.split("rgb").length - 1).toBeGreaterThanOrEqual(3);
});

it("gives each variant its own paint", async () => {
  const screen = await render(
    <>
      <Button variant="solid">Solid</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
    </>,
  );
  const paint = (name: string) => {
    const style = getComputedStyle(screen.getByRole("button", { name }).element());
    return `${style.color}|${style.backgroundColor}|${style.borderColor}`;
  };
  const paints = ["Solid", "Outline", "Ghost", "Danger"].map(paint);
  expect(new Set(paints).size).toBe(4);
});

it("makes the small size shorter and smaller than the default", async () => {
  const screen = await render(
    <>
      <Button size="md">Medium</Button>
      <Button size="sm">Small</Button>
    </>,
  );
  const medium = getComputedStyle(
    screen.getByRole("button", { name: "Medium" }).element(),
  );
  const small = getComputedStyle(screen.getByRole("button", { name: "Small" }).element());
  expect(parseFloat(small.minHeight)).toBeLessThan(parseFloat(medium.minHeight));
  expect(parseFloat(small.fontSize)).toBeLessThan(parseFloat(medium.fontSize));
});

it("merges a caller className rather than replacing its own", async () => {
  const screen = await render(<Button className="extra">Export</Button>);
  const button = screen.getByRole("button").element();
  expect(button.classList.contains("extra")).toBe(true);
  // The pill radius proves the component's own class survived the merge.
  expect(getComputedStyle(button).borderRadius).toBe("999px");
});

it("defaults to type button so it never submits a form by accident", async () => {
  const screen = await render(<Button>Export</Button>);
  await expect.element(screen.getByRole("button")).toHaveAttribute("type", "button");
});

it("renders an anchor that keeps its href when asChild is set", async () => {
  const screen = await render(
    <Button asChild variant="ghost">
      <a href="/library">Library</a>
    </Button>,
  );
  const link = screen.getByRole("link", { name: "Library" }).element();
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("/library");
  // A link has no type attribute, and it still takes the button's treatment.
  expect(link.hasAttribute("type")).toBe(false);
  expect(getComputedStyle(link).borderRadius).toBe("999px");
  expect(getComputedStyle(link).textDecorationLine).toBe("none");
});
