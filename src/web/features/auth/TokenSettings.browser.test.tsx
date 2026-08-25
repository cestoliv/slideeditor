import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TokenSettings } from "./TokenSettings.js";

const token = {
  id: "t1",
  name: "laptop",
  prefix: "sst_abcd",
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: null,
};

it("lists tokens by name and prefix", async () => {
  const screen = await render(
    <TokenSettings
      listTokens={vi.fn().mockResolvedValue({ tokens: [token] })}
      createToken={vi.fn()}
      deleteToken={vi.fn()}
    />,
  );
  await expect.element(screen.getByText("laptop")).toBeVisible();
  await expect.element(screen.getByText("sst_abcd")).toBeVisible();
});

it("shows a new secret once, with a warning", async () => {
  const createToken = vi.fn().mockResolvedValue({ token, secret: "sst_thesecretvalue" });
  const screen = await render(
    <TokenSettings
      listTokens={vi.fn().mockResolvedValue({ tokens: [] })}
      createToken={createToken}
      deleteToken={vi.fn()}
    />,
  );

  await screen.getByLabelText("Token name").fill("laptop");
  await screen.getByRole("button", { name: "Create token" }).click();

  expect(createToken).toHaveBeenCalledWith("laptop");
  await expect.element(screen.getByText("sst_thesecretvalue")).toBeVisible();
  await expect.element(screen.getByText(/will not be shown again/i)).toBeVisible();
});

it("revokes a token and refreshes the list", async () => {
  const deleteToken = vi.fn().mockResolvedValue(undefined);
  const listTokens = vi
    .fn()
    .mockResolvedValueOnce({ tokens: [token] })
    .mockResolvedValue({ tokens: [] });
  const screen = await render(
    <TokenSettings
      listTokens={listTokens}
      createToken={vi.fn()}
      deleteToken={deleteToken}
    />,
  );

  await screen.getByRole("button", { name: "Revoke laptop" }).click();
  expect(deleteToken).toHaveBeenCalledWith("t1");
  await vi.waitFor(() => expect(listTokens).toHaveBeenCalledTimes(2));
});
