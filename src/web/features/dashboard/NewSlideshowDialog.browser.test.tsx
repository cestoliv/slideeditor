import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { Account } from "@shared/schema/index.js";
import "../../design/tokens.css";
import "../../design/reset.css";
import { ToastProvider } from "../../design/index.js";
import { NewSlideshowDialog } from "./NewSlideshowDialog.js";

const LAST_ACCOUNT_KEY = "slide-studio:last-account";

// Vitest browser mode does not isolate localStorage between test files on the
// same origin, and this file both reads and writes the one real key the
// dialog uses, so a value another test's run left behind (or one this test
// leaves for the next) is a stray it needs cleaning up either side of.
beforeEach(() => {
  localStorage.removeItem(LAST_ACCOUNT_KEY);
});

afterEach(() => {
  localStorage.removeItem(LAST_ACCOUNT_KEY);
});

function account(id: string, name: string): Account {
  return {
    id,
    name,
    defaults: {
      ratio: { w: 9, h: 16 },
      text: {
        fontFamily: "TikTok Sans",
        size: 64,
        style: "plain",
        color: "#FFFFFF",
        background: "white",
        backgroundShape: "lines",
        align: "center",
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

it("preselects the remembered account and remembers a new choice", async () => {
  localStorage.setItem(LAST_ACCOUNT_KEY, "a2");
  const onCreate = vi.fn().mockResolvedValue(true);
  const screen = await render(
    <ToastProvider>
      <NewSlideshowDialog
        open
        accounts={[account("a1", "Main brand"), account("a2", "Side project")]}
        onCreate={onCreate}
        onOpenChange={() => undefined}
      />
    </ToastProvider>,
  );
  await expect.element(screen.getByText("Side project")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await expect.poll(() => onCreate.mock.calls.length).toBe(1);
  expect(onCreate).toHaveBeenCalledWith("a2");
  expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBe("a2");
});

/*
 * Finding 8: onCreate used to be typed Promise<void>, so submit() wrote
 * LAST_ACCOUNT_KEY the instant onCreate's promise settled — and Dashboard's
 * own startProject() catches its own error and only toasts, so that promise
 * always resolved regardless of whether a project was actually created. A
 * server error, a 401 or a timeout still recorded the account, and the next
 * visit preselected one the reader never successfully used. onCreate now
 * resolves `false` for exactly that case, and submit() must not write the
 * key when it does.
 */
it("does not remember the account when onCreate reports the create failed", async () => {
  const onCreate = vi.fn().mockResolvedValue(false);
  const screen = await render(
    <ToastProvider>
      <NewSlideshowDialog
        open
        accounts={[account("a1", "Main brand"), account("a2", "Side project")]}
        onCreate={onCreate}
        onOpenChange={() => undefined}
      />
    </ToastProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await expect.poll(() => onCreate.mock.calls.length).toBe(1);
  expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
});
