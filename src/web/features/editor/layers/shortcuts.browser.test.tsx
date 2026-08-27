import { expect, it } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import "../../../design/tokens.css";
import "../../../design/reset.css";
import type { LibraryItem, Project } from "@shared/schema/index.js";
import { ToastProvider } from "../../../design/index.js";
import { AccountsProvider, AccountsStore } from "../../../app/accounts.js";
import { LibraryCache } from "../../../app/useLibrary.js";
import { Editor } from "../Editor.js";
import type { EditorClient } from "../Editor.js";
import { fixtureProject } from "../testing.js";
import { libraryItem } from "./testing.js";

/*
 * Undo and redo, reached the way a person reaches them: a keystroke on the
 * running editor.
 *
 * `store.undo()` had no caller in the product at all, and every test missed it
 * because the store's own tests call the method directly. A test that reaches
 * for the function cannot see that nothing else does, so nothing here calls it.
 */

function client(project: Project): EditorClient {
  return {
    getProject: () => Promise.resolve({ project: structuredClone(project) }),
    save: (sent) =>
      Promise.resolve({ ...structuredClone(sent), version: sent.version + 1 }),
    setStatus: () => Promise.resolve({}),
  };
}

function library(project: Project): LibraryCache {
  const items: LibraryItem[] = project.slides.map((slide) =>
    libraryItem(slide.backgroundItemId),
  );
  return new LibraryCache({
    listLibrary: () => Promise.resolve({ items, total: items.length }),
  });
}

function emptyAccountsStore(): AccountsStore {
  return new AccountsStore({
    listAccounts: () => Promise.resolve({ accounts: [] }),
    listFonts: () => Promise.resolve({ fonts: [], dropped: [] }),
    createAccount: () => Promise.reject(new Error("not used")),
    updateAccount: () => Promise.reject(new Error("not used")),
    deleteAccount: () => Promise.reject(new Error("not used")),
    addGoogleFont: () => Promise.reject(new Error("not used")),
    deleteFont: () => Promise.reject(new Error("not used")),
  });
}

async function openEditor(project: Project) {
  await render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/p/project-1"]}>
        <AccountsProvider store={emptyAccountsStore()}>
          <Editor
            projectId={project.id}
            client={client(project)}
            library={library(project)}
            subscribe={() => () => undefined}
          />
        </AccountsProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
  await expect.element(page.getByLabelText("Text layer: Keep this line")).toBeVisible();
}

/** A text layer with a name a locator can find it by. */
function projectWithTexts(...lines: string[]): Project {
  const project = fixtureProject({ texts: lines.length, overlays: 0 });
  const slide = project.slides[0];
  if (slide === undefined) throw new Error("The fixture has no slide.");
  slide.texts.forEach((text, index) => {
    text.text = lines[index] ?? text.text;
    text.y = 0.2 + index * 0.2;
  });
  return project;
}

async function deleteTheLayer(name: string) {
  const layer = page.getByLabelText(`Text layer: ${name}`);
  await expect.element(layer).toBeVisible();
  // A click to select it, exactly as the end-to-end flow does.
  await userEvent.click(layer);
  await userEvent.keyboard("{Delete}");
  await expect.poll(() => page.getByLabelText(`Text layer: ${name}`).query()).toBe(null);
}

it("undoes a delete from the keyboard", async () => {
  await openEditor(projectWithTexts("Keep this line", "Delete this line"));
  await deleteTheLayer("Delete this line");

  await userEvent.keyboard("{Control>}z{/Control}");

  await expect.element(page.getByLabelText("Text layer: Delete this line")).toBeVisible();
});

it("takes the command key as well as control", async () => {
  await openEditor(projectWithTexts("Keep this line", "Delete this line"));
  await deleteTheLayer("Delete this line");

  // app.js:4861 reads either, so the shortcut works on both platforms.
  await userEvent.keyboard("{Meta>}z{/Meta}");

  await expect.element(page.getByLabelText("Text layer: Delete this line")).toBeVisible();
});

it("redoes with shift and with Y", async () => {
  await openEditor(projectWithTexts("Keep this line", "Delete this line"));
  const gone = () => page.getByLabelText("Text layer: Delete this line").query();
  await deleteTheLayer("Delete this line");

  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(gone).not.toBe(null);
  await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  await expect.poll(gone).toBe(null);

  // app.js:4872. Y is the other redo, for the readers who reach for it.
  await userEvent.keyboard("{Control>}z{/Control}");
  await expect.poll(gone).not.toBe(null);
  await userEvent.keyboard("{Control>}y{/Control}");
  await expect.poll(gone).toBe(null);
});

it("leaves the shortcut to the field when a text layer is being edited", async () => {
  await openEditor(projectWithTexts("Keep this line", "Delete this line"));
  await deleteTheLayer("Delete this line");

  // Into the inline editor, which is a contenteditable and owns its own undo.
  // The two-step: a click selects the layer, and a press on its glyphs edits.
  const survivor = page.getByLabelText("Text layer: Keep this line");
  await userEvent.click(survivor);
  const box = await survivor.element();
  await expect.poll(() => box.querySelector('[data-testid="text-hit"]')).not.toBe(null);
  const glyphs = box.querySelector<HTMLElement>('[data-testid="text-hit"]');
  if (glyphs === null) throw new Error("No editable glyphs.");
  const rect = glyphs.getBoundingClientRect();
  glyphs.dispatchEvent(
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
  const editor = page.getByRole("textbox", { name: "Edit text layer" });
  await expect.element(editor).toBeVisible();

  /*
   * app.js:4863. Pressed inside a field, the shortcut belongs to the field, so
   * the layer history must not move at all. Three presses rather than one:
   * the click that selected the layer opened its own (empty) entry, so a single
   * press could walk that one and show nothing either way.
   *
   * Whether Chromium's own contenteditable undo takes the typing back is not
   * asserted. It did not, when measured, and a claim about the browser is worth
   * nothing here unless it is the thing under test.
   */
  await userEvent.keyboard("{Control>}z{/Control}");
  await userEvent.keyboard("{Control>}z{/Control}");
  await userEvent.keyboard("{Control>}z{/Control}");

  expect(page.getByLabelText("Text layer: Delete this line").query()).toBe(null);
  await expect.element(editor).toBeVisible();
});
