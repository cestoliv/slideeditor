import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "./provided.js";
import {
  baseUrl,
  createSlideshow,
  editPath,
  openApp,
  seedLibrary,
  uniqueTag,
} from "./setup/fixtures.js";

/*
 * The second brand's whole path: an account of its own, a slideshow the agent
 * drops into it with an explicit accountId, and the dashboard filter narrowing
 * down to just that account's work.
 */

async function createAccount(name: string): Promise<{ id: string; name: string }> {
  const response = await fetch(`${baseUrl}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      defaults: {
        ratio: { w: 3, h: 4 },
        text: {
          fontFamily: "TikTok Sans",
          size: 56,
          style: "boxed",
          color: "#111111",
          background: "white",
          backgroundShape: "full",
          align: "left",
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Creating the account failed with ${await response.text()}`);
  }
  const { account } = (await response.json()) as {
    account: { id: string; name: string };
  };
  return account;
}

it("keeps a second brand's slideshow out of the default account's list", async () => {
  const tag = uniqueTag();
  const account = await createAccount(`Side project ${tag}`);
  const { backgrounds } = await seedLibrary(baseUrl, tag, account.id);

  const created = await createSlideshow(baseUrl, {
    name: `Side project launch ${tag}`,
    accountId: account.id,
    slides: [{ background: backgrounds[0]!.id, assets: [], texts: ["Launching soon"] }],
  });
  expect(created.slideCount).toBe(1);

  await openApp("/");
  await userEvent.click(page.getByLabelText("Account"));
  await userEvent.click(page.getByRole("option", { name: account.name }));
  await expect.element(page.getByText(`Side project launch ${tag}`)).toBeVisible();

  // The name promises an absence, not just a presence: filtering back to the
  // default account has to leave the side project's slideshow out, not merely
  // list it somewhere.
  await userEvent.click(page.getByLabelText("Account"));
  await userEvent.click(page.getByRole("option", { name: "Default" }));
  await expect
    .poll(() => page.getByText(`Side project launch ${tag}`).query())
    .toBe(null);

  await openApp(editPath(created.editUrl));
  await expect.element(page.getByText(account.name)).toBeVisible();
});
