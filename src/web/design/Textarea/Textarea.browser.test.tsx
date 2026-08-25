import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import "../reset.css";
import { userEvent } from "vitest/browser";
import { Field } from "../Field/Field.js";
import { Textarea } from "./Textarea.js";

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
  const screen = await render(<Textarea aria-label="Caption" />);
  const control = screen.getByRole("textbox", { name: "Caption" });
  await control.fill("Swipe for the recipe");
  await expect.element(control).toHaveValue("Swipe for the recipe");
});

it("marks the invalid state for assistive technology", async () => {
  const screen = await render(<Textarea aria-label="Caption" invalid />);
  await expect
    .element(screen.getByRole("textbox", { name: "Caption" }))
    .toHaveAttribute("aria-invalid", "true");
});

it("takes its name from the Field label", async () => {
  const screen = await render(
    <Field label="Caption">
      <Textarea />
    </Field>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Caption" })).toBeVisible();
});

it("inherits the invalid state from a Field carrying an error", async () => {
  const screen = await render(
    <Field label="Caption" error="Caption is too long">
      <Textarea />
    </Field>,
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Caption" }))
    .toHaveAttribute("aria-invalid", "true");
});

it("draws the shared focus ring when reached from the keyboard", async () => {
  const screen = await render(<Textarea aria-label="Caption" />);
  await userEvent.keyboard("{Tab}");
  const style = getComputedStyle(
    screen.getByRole("textbox", { name: "Caption" }).element(),
  );
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.boxShadow).not.toBe("none");
});

it("keeps the danger border while an invalid textarea is focused", async () => {
  const screen = await render(<Textarea aria-label="Caption" invalid />);
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("textbox", { name: "Caption" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  const style = await settled(element);
  // "You are here" and "this is wrong" are two signals. Focus must not eat one.
  expect(style.borderTopColor).toBe("rgb(167, 33, 58)");
  expect(style.outlineStyle).toBe("solid");
  expect(style.boxShadow).not.toBe("none");
});

it("keeps the danger border on a focused control inside an errored Field", async () => {
  const screen = await render(
    <Field label="Caption" error="That value is not allowed">
      <Textarea />
    </Field>,
  );
  await userEvent.keyboard("{Tab}");
  const element = screen.getByRole("textbox", { name: "Caption" }).element();
  expect(element.matches(":focus-visible")).toBe(true);
  expect((await settled(element)).borderTopColor).toBe("rgb(167, 33, 58)");
});
