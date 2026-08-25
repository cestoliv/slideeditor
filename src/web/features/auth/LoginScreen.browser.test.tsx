import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LoginScreen } from "./LoginScreen.js";

it("sends the password and reports success", async () => {
  const onSignedIn = vi.fn();
  const login = vi.fn().mockResolvedValue(undefined);
  const screen = await render(<LoginScreen onSignedIn={onSignedIn} login={login} />);

  await screen.getByLabelText("Password").fill("hunter2hunter2");
  await screen.getByRole("button", { name: "Sign in" }).click();

  expect(login).toHaveBeenCalledWith("hunter2hunter2");
  await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalled());
});

it("shows the server's refusal and keeps the form", async () => {
  const login = vi.fn().mockRejectedValue(new Error("That password is not right."));
  const screen = await render(<LoginScreen onSignedIn={vi.fn()} login={login} />);

  await screen.getByLabelText("Password").fill("wrong");
  await screen.getByRole("button", { name: "Sign in" }).click();

  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("That password is not right.");
});

it("refuses to submit an empty password", async () => {
  const login = vi.fn();
  const screen = await render(<LoginScreen onSignedIn={vi.fn()} login={login} />);
  await screen.getByRole("button", { name: "Sign in" }).click();
  expect(login).not.toHaveBeenCalled();
});
