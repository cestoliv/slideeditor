import { expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { Account, Project } from "@shared/schema/index.js";
import { BUILTIN_DEFAULTS } from "@shared/schema/index.js";
import { ToastProvider } from "../../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../../app/accounts.js";
import { LibraryCache } from "../../../app/useLibrary.js";
import { Editor } from "../Editor.js";
import type { EditorClient } from "../Editor.js";
import { fixtureProject } from "../testing.js";
import { libraryItem } from "./testing.js";

/*
 * That the layers are reachable from the app, not only from the layer tests'
 * own harness.
 *
 * This is the one thing a unit test of the stack cannot show: a component can
 * be complete, tested and never rendered. The library feature sat unreachable
 * for a whole round for exactly that reason, so the wiring gets its own test.
 */

function defaultAccount(): Account {
  return {
    id: "default",
    name: "Default",
    defaults: BUILTIN_DEFAULTS,
    createdAt: 1,
    updatedAt: 1,
  };
}

function accountsStoreWith(accounts: Account[]): AccountsStore {
  return new AccountsStore({
    listAccounts: () => Promise.resolve({ accounts }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
}

function client(project: Project, onSave?: (sent: Project) => void): EditorClient {
  return {
    getProject: () => Promise.resolve({ project: structuredClone(project) }),
    save: (sent) => {
      onSave?.(sent);
      return Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 });
    },
    setStatus: () => Promise.resolve({}),
  };
}

function library(project: Project): LibraryCache {
  const items = project.slides.flatMap((slide) => [
    libraryItem(slide.backgroundItemId),
    ...slide.overlays.map((overlay) => libraryItem(overlay.itemId)),
  ]);
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items, total: items.length }),
  });
}

async function openEditor(
  project: Project,
  options: { accounts?: Account[]; onSave?: (sent: Project) => void } = {},
) {
  await render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/p/project-1"]}>
        <AccountsProvider
          store={accountsStoreWith(options.accounts ?? [defaultAccount()])}
        >
          <Editor
            projectId={project.id}
            client={client(project, options.onSave)}
            library={library(project)}
            subscribe={() => () => undefined}
          />
        </AccountsProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

it("renders the slide's layers inside the editor", async () => {
  const project = fixtureProject({ texts: 1, overlays: 1 });

  await openEditor(project);

  await expect.element(page.getByLabelText(/^Photo overlay/)).toBeInTheDocument();
  await expect.element(page.getByLabelText(/^Text layer/)).toBeInTheDocument();
});

it("selects a layer pressed inside the editor", async () => {
  const project = fixtureProject({ texts: 0, overlays: 1 });
  const id = project.slides[0]?.overlays[0]?.id;
  if (id === undefined) throw new Error("The fixture has no overlay.");

  await openEditor(project);
  const box = await page.getByLabelText(/^Photo overlay/).element();
  const rect = box.getBoundingClientRect();
  box.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );

  // The store is the editor's own, so the selection is only observable through
  // what the layer paints. data-selected is what LayerBox writes for it.
  await expect.poll(() => box.getAttribute("data-selected")).toBe("true");
});

it("styles a double-click-added text layer with its slideshow's own account defaults, not the built-in default", async () => {
  const project = fixtureProject({ texts: 0, overlays: 0, accountId: "a2" });
  // A holder rather than a bare `let`: TS's flow analysis narrows a captured
  // `let` reassigned only inside a callback to `never` at a later read, since
  // it cannot see the reassignment as reachable from this scope.
  const saved: { current: Project | null } = { current: null };
  const account: Account = {
    id: "a2",
    name: "Side project",
    defaults: {
      ratio: { w: 3, h: 4 },
      text: {
        fontFamily: "Bebas Neue",
        size: 40,
        style: "boxed",
        color: "#111111",
        background: "white",
        backgroundShape: "full",
        align: "left",
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  await openEditor(project, {
    accounts: [account],
    onSave: (sent) => {
      saved.current = sent;
    },
  });

  const stage = await page.getByTestId("stage").element();
  const rect = stage.getBoundingClientRect();
  stage.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );

  await vi.waitFor(() => {
    expect(saved.current?.slides[0]?.texts[0]?.fontFamily).toBe("Bebas Neue");
  });
  const text = saved.current?.slides[0]?.texts[0];
  expect(text?.size).toBe(40);
  expect(text?.color).toBe("#111111");
});
