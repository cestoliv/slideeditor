import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
// Geometry comes from the token layer, so the tests load it the way the app does.
import "../tokens.css";
import { Input } from "../Input/Input.js";
import { Field } from "./Field.js";

it("focuses the control when the label is clicked", async () => {
  const screen = await render(
    <Field label="Project name">
      <Input />
    </Field>,
  );
  await screen.getByText("Project name").click();
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  expect(document.activeElement).toBe(input);
});

it("announces the error through aria-describedby", async () => {
  const screen = await render(
    <Field label="Project name" error="Name is required">
      <Input />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  const describedBy = input.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const description = document.getElementById(describedBy ?? "");
  expect(description?.textContent).toBe("Name is required");
});

it("announces the hint through aria-describedby", async () => {
  const screen = await render(
    <Field label="Project name" hint="Shown on the home screen">
      <Input />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  const describedBy = input.getAttribute("aria-describedby") ?? "";
  const description = document.getElementById(describedBy);
  expect(description?.textContent).toBe("Shown on the home screen");
});

it("describes the error before the hint when both are present", async () => {
  const screen = await render(
    <Field label="Project name" hint="Shown on the home screen" error="Name is required">
      <Input />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
  expect(ids).toHaveLength(2);
  expect(document.getElementById(ids[0] ?? "")?.textContent).toBe("Name is required");
  expect(document.getElementById(ids[1] ?? "")?.textContent).toBe(
    "Shown on the home screen",
  );
});

it("gives the error an alert role so it is announced when it appears", async () => {
  const screen = await render(
    <Field label="Project name" error="Name is required">
      <Input />
    </Field>,
  );
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Name is required");
});

it("leaves aria-describedby off when there is nothing to describe", async () => {
  const screen = await render(
    <Field label="Project name">
      <Input />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "Project name" }).element();
  expect(input.hasAttribute("aria-describedby")).toBe(false);
});
