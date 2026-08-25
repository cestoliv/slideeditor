import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import { Badge } from "./Badge.js";

/* Relative luminance, so a test can assert a real contrast ratio. */
function luminance(color: string): number {
  const parts = color.match(/[\d.]+/g);
  if (parts === null) {
    throw new Error(`Unreadable colour: ${color}`);
  }
  const channels = parts.slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it("renders its children", async () => {
  const screen = await render(<Badge>Draft</Badge>);
  await expect.element(screen.getByText("Draft")).toBeVisible();
});

it("carries no role of its own", async () => {
  const screen = await render(<Badge>Draft</Badge>);
  const badge = screen.getByText("Draft").element();
  expect(badge.tagName).toBe("SPAN");
  expect(badge.hasAttribute("role")).toBe(false);
});

it("gives each tone its own paint", async () => {
  const screen = await render(
    <>
      <Badge tone="neutral">Neutral</Badge>
      <Badge tone="accent">Accent</Badge>
      <Badge tone="warning">Warning</Badge>
      <Badge tone="success">Success</Badge>
      <Badge tone="danger">Danger</Badge>
    </>,
  );
  const paints = ["Neutral", "Accent", "Warning", "Success", "Danger"].map((label) => {
    const style = getComputedStyle(screen.getByText(label).element());
    return `${style.color}|${style.backgroundColor}`;
  });
  expect(new Set(paints).size).toBe(5);
});

it("clears 4.5:1 on every tone", async () => {
  const screen = await render(
    <>
      <Badge tone="neutral">Neutral</Badge>
      <Badge tone="accent">Accent</Badge>
      <Badge tone="warning">Warning</Badge>
      <Badge tone="success">Success</Badge>
      <Badge tone="danger">Danger</Badge>
    </>,
  );
  for (const label of ["Neutral", "Accent", "Warning", "Success", "Danger"]) {
    const style = getComputedStyle(screen.getByText(label).element());
    // 10px uppercase text is not large text, so AA wants 4.5:1.
    expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  }
});

it("uppercases its text through the stylesheet, not the markup", async () => {
  const screen = await render(<Badge>Draft</Badge>);
  const badge = screen.getByText("Draft").element();
  expect(badge.textContent).toBe("Draft");
  expect(getComputedStyle(badge).textTransform).toBe("uppercase");
});

it("merges a caller className rather than replacing its own", async () => {
  const screen = await render(<Badge className="extra">Draft</Badge>);
  const badge = screen.getByText("Draft").element();
  expect(badge.classList.contains("extra")).toBe(true);
  expect(getComputedStyle(badge).textTransform).toBe("uppercase");
});
