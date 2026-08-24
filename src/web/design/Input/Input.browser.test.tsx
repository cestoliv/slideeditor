import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Field } from "../Field/Field.js";
import { Input } from "./Input.js";

/*
 * border-color is transitioned, so a single read catches a blend partway
 * through and polling succeeds on the value the transition is leaving. Waiting
 * for the element's running transitions to finish asserts where it settles.
 */
async function settled(element: Element): Promise<CSSStyleDeclaration> {
  await Promise.allSettled(
    element.getAnimations().map((animation) => animation.finished),
  );
  return getComputedStyle(element);
}

it("reflects typed text", async () => {
  const screen = await render(<Input aria-label="Project name" />);
  const input = screen.getByRole("textbox", { name: "Project name" });
  await input.fill("Morning routine");
  await expect.element(input).toHaveValue("Morning routine");
});

it("marks the invalid state for assistive technology", async () => {
  const screen = await render(<Input aria-label="Project name" invalid />);
  await expect
    .element(screen.getByRole("textbox", { name: "Project name" }))
    .toHaveAttribute("aria-invalid", "true");
});

it("is not invalid by default", async () => {
  const screen = await render(<Input aria-label="Project name" />);
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  expect(input.hasAttribute("aria-invalid")).toBe(false);
});

it("takes its name from the Field label", async () => {
  const screen = await render(
    <Field label="Project name">
      <Input />
    </Field>,
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Project name" }))
    .toBeVisible();
});

it("inherits the invalid state from a Field carrying an error", async () => {
  const screen = await render(
    <Field label="Project name" error="Name is required">
      <Input />
    </Field>,
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Project name" }))
    .toHaveAttribute("aria-invalid", "true");
});

it("keeps typing working when the value is controlled", async () => {
  function Controlled() {
    const [value, setValue] = useState("a");
    return (
      <Input
        aria-label="Slug"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
    );
  }
  const screen = await render(<Controlled />);
  const input = screen.getByRole("textbox", { name: "Slug" });
  await userEvent.click(input);
  await userEvent.keyboard("bc");
  await expect.element(input).toHaveValue("abc");
});

it("draws the shared focus ring when reached from the keyboard", async () => {
  const screen = await render(<Input aria-label="Project name" />);
  await userEvent.keyboard("{Tab}");
  const style = getComputedStyle(
    screen.getByRole("textbox", { name: "Project name" }).element(),
  );
  // The legacy sheet set outline: 0 here, which left a keyboard user with a
  // 1.2:1 cyan glow. The outline has to come back for forced-colors mode too.
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).not.toBe("none");
});

it("makes the small size shorter and tighter than the default", async () => {
  const screen = await render(
    <>
      <Input aria-label="Medium" />
      <Input aria-label="Small" inputSize="sm" />
    </>,
  );
  const medium = getComputedStyle(
    screen.getByRole("textbox", { name: "Medium" }).element(),
  );
  const small = getComputedStyle(
    screen.getByRole("textbox", { name: "Small" }).element(),
  );
  expect(parseFloat(small.minHeight)).toBeLessThan(parseFloat(medium.minHeight));
  expect(parseFloat(small.borderRadius)).toBeLessThan(parseFloat(medium.borderRadius));
});

it("merges a caller className rather than replacing its own", async () => {
  const screen = await render(<Input aria-label="Project name" className="extra" />);
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  expect(input.classList.contains("extra")).toBe(true);
  expect(parseFloat(getComputedStyle(input).minHeight)).toBeGreaterThan(0);
});

it("keeps the danger border while an invalid input is focused", async () => {
  const screen = await render(<Input aria-label="Project name" invalid />);
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("textbox", { name: "Project name" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  const style = await settled(element);
  // "You are here" and "this is wrong" are two signals. Focus must not eat one.
  expect(style.borderTopColor).toBe("rgb(167, 33, 58)");
  expect(style.outlineStyle).toBe("solid");
  expect(style.boxShadow).not.toBe("none");
});

it("keeps the danger border on a focused control inside an errored Field", async () => {
  const screen = await render(
    <Field label="Project name" error="That value is not allowed">
      <Input />
    </Field>,
  );
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("textbox", { name: "Project name" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  expect((await settled(element)).borderTopColor).toBe("rgb(167, 33, 58)");
});
