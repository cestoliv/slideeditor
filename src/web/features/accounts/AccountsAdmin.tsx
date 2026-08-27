import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { newTextLayer } from "@shared/defaults/index.js";
import {
  OUTPUT_WIDTH,
  RATIO_PRESETS,
  outputHeight,
  ratioLabel,
} from "@shared/geometry/index.js";
import { BUILTIN_DEFAULTS } from "@shared/schema/index.js";
import type { Account, AccountDefaults, FontEntry } from "@shared/schema/index.js";
import {
  Button,
  Field,
  IconButton,
  Input,
  Select,
  useToast,
} from "../../design/index.js";
import type { SelectOption } from "../../design/index.js";
import { accountsStore } from "../../app/accounts.js";
import type { AccountsStore } from "../../app/accounts.js";
import { ApiError } from "../../app/api.js";
import { injectFontFaces } from "../../app/fontFaces.js";
import { ColorPicker } from "../editor/Inspector/ColorPicker.js";
import { FontSizeSlider } from "../editor/Inspector/FontSizeSlider.js";
import { renderTextDom } from "../editor/text/renderTextDom.js";
import { useTextLayout } from "../editor/text/useTextLayout.js";
import { Header } from "../shell/Header.js";
import styles from "./AccountsAdmin.module.css";

/*
 * Where a person defines a brand: its name, its default ratio, and the look
 * every new text layer starts with. Reached at /accounts.
 *
 * One form serves both creating and editing: editingId === null means
 * creating, any other value names the account on screen. The preview panel
 * runs the real text pipeline (newTextLayer, useTextLayout, renderTextDom) so
 * the page shows the typeface rather than merely naming it.
 */

const PREVIEW_WIDTH = 240;
const PREVIEW_TEXT = "Preview text";

const RATIO_OPTIONS: SelectOption[] = RATIO_PRESETS.map((preset) => ({
  value: preset.label,
  label: `${preset.label} · ${preset.note}`,
}));

const STYLE_OPTIONS: SelectOption[] = [
  { value: "plain", label: "Clean" },
  { value: "outline", label: "Outline" },
  { value: "boxed", label: "Box" },
];

const BACKGROUND_OPTIONS: SelectOption[] = [
  { value: "white", label: "White" },
  { value: "black", label: "Black" },
];

const SHAPE_OPTIONS: SelectOption[] = [
  { value: "lines", label: "Per line" },
  { value: "full", label: "Full box" },
];

const ALIGN_OPTIONS: SelectOption[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

/** ColorPicker's edit-batching hooks exist to group undo entries in the
 * editor. This form has no undo stack, so both are no-ops. */
function noEdit(): void {
  return undefined;
}

/** The slot a draft is kept under: an account's id, or null for "New account". */
type DraftKey = string | null;

export type AccountsAdminProps = {
  /** The app's one store by default. A test builds its own over a fake client. */
  store?: AccountsStore;
};

/*
 * newTextLayer's own default id generator is crypto.randomUUID(), which is
 * secure-context-gated and undefined on a plain-HTTP non-localhost origin
 * (the README's own --host 0.0.0.0, and the Docker image's bind). This
 * preview needs an id that is merely present, not cryptographically random -
 * it never leaves the browser or gets persisted - so it supplies its own
 * rather than inheriting a default this page cannot rely on.
 */
const PREVIEW_LAYER_ID = "account-preview-text";

function AccountPreview({ defaults }: { defaults: AccountDefaults }) {
  const layer = useMemo(() => {
    const base = newTextLayer(defaults, { x: 0, y: 0, z: 1 }, () => PREVIEW_LAYER_ID);
    return { ...base, text: PREVIEW_TEXT };
  }, [defaults]);
  const canvasHeight = outputHeight(defaults.ratio);
  const layout = useTextLayout(layer, { width: OUTPUT_WIDTH, height: canvasHeight });
  const scale = PREVIEW_WIDTH / OUTPUT_WIDTH;
  const previewHeight = (canvasHeight * PREVIEW_WIDTH) / OUTPUT_WIDTH;

  return (
    <div
      className={styles.preview}
      style={{
        width: `${String(PREVIEW_WIDTH)}px`,
        height: `${String(previewHeight)}px`,
      }}
    >
      <div
        className={styles.previewCanvas}
        style={{
          width: `${String(OUTPUT_WIDTH)}px`,
          height: `${String(canvasHeight)}px`,
          transform: `scale(${String(scale)})`,
        }}
      >
        {renderTextDom(layer, layout)}
      </div>
    </div>
  );
}

export function AccountsAdmin({ store = accountsStore }: AccountsAdminProps) {
  /*
   * Read straight off the `store` prop rather than through context's
   * useAccounts() — the two used to be able to disagree. Every mutation
   * below (create, update, remove, addGoogleFont, removeFont) already goes
   * through this same `store`, so useAccounts() only agreed with it because
   * both defaulted to the same module singleton; mounting this under an
   * <AccountsProvider> holding a different store — exactly what the `store`
   * prop's own doc comment invites a test to do — made every mutation land
   * on this store while the list on screen kept reading the context's,
   * silently dead no matter how many times a form here submitted. Reading
   * and writing through the one store this component was actually handed
   * closes that gap by construction.
   */
  const { accounts, fonts, fontWarnings } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  const { toast } = useToast();
  /*
   * Every refresh() hands back a fresh `fontWarnings` array, even when the
   * same malformed row is still sitting in the database — an account edit,
   * say, refreshes for an unrelated reason and would otherwise re-toast a
   * problem nobody has fixed. Comparing against the last labels actually
   * toasted, rather than the array's identity, toasts once per genuinely new
   * set of warnings instead of once per refresh.
   */
  const toastedFontWarnings = useRef<string>("");
  useEffect(() => {
    if (fontWarnings.length === 0) return;
    const signature = fontWarnings.map((warning) => warning.label).join("|");
    if (signature === toastedFontWarnings.current) return;
    toastedFontWarnings.current = signature;
    const names = fontWarnings.map((warning) => warning.label).join(", ");
    toast(
      `Couldn’t load ${fontWarnings.length === 1 ? "a font" : `${String(fontWarnings.length)} fonts`} (${names}). It won’t appear in the picker until this is fixed on the server.`,
      { tone: "danger" },
    );
  }, [fontWarnings, toast]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<AccountDefaults>(BUILTIN_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [fontDraft, setFontDraft] = useState("");
  const [addingFont, setAddingFont] = useState(false);
  const [removingFontId, setRemovingFontId] = useState<string | null>(null);
  /*
   * Edits in progress on a slot that is not on screen right now, keyed by
   * account id (or null for "New account"). This page previews typography
   * live, which invites flipping between accounts to compare looks rather
   * than committing to one before seeing another — a confirm-before-switch
   * would interrupt exactly that. Keeping each slot's draft instead means
   * nothing is ever silently discarded: switching away and back resumes
   * right where it was left, with no dialog in the way.
   */
  const [drafts, setDrafts] = useState<
    Map<DraftKey, { name: string; defaults: AccountDefaults }>
  >(() => new Map());

  const switchTo = (
    key: DraftKey,
    fallbackName: string,
    fallbackDefaults: AccountDefaults,
  ) => {
    if (key === editingId) return;
    const pending = drafts.get(key);
    setDrafts((current) => {
      const next = new Map(current);
      next.set(editingId, { name, defaults: draft });
      return next;
    });
    setEditingId(key);
    setName(pending?.name ?? fallbackName);
    setDraft(pending?.defaults ?? fallbackDefaults);
  };

  const startNew = () => {
    switchTo(null, "", BUILTIN_DEFAULTS);
  };

  const select = (account: Account) => {
    switchTo(account.id, account.name, account.defaults);
  };

  const remove = async (account: Account) => {
    if (removingId !== null) return;
    setRemovingId(account.id);
    try {
      await store.remove(account.id);
      toast(`${account.name} deleted`);
      // The account this form was showing no longer exists, so there is
      // nothing to keep a draft slot for — reset straight to "New account"
      // rather than routing through switchTo, which would stash a draft
      // under an id that just stopped existing.
      if (editingId === account.id) {
        setEditingId(null);
        setName("");
        setDraft(BUILTIN_DEFAULTS);
      }
    } catch (error) {
      // The server's own message already names what remains (Task 8's
      // AccountNotEmptyError: "This account still owns N slideshows and M
      // library items"), so it is shown as-is rather than folded into a
      // generic failure a person cannot act on.
      const message =
        error instanceof ApiError ? error.message : `Couldn’t delete ${account.name}.`;
      toast(message, { tone: "danger" });
    } finally {
      setRemovingId(null);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editingId === null) {
        const account = await store.create({ name, defaults: draft });
        // Moves the form onto the account just created. Account has no
        // UNIQUE constraint on name, so without this the button kept
        // reading "Create account" and a second press (or a stray double
        // click) made a second, identically named account rather than
        // saving an edit to the one just made. It also unsticks "New
        // account": switchTo(null, ...) early-returns when its key already
        // matches editingId, which — while this stayed null — made that
        // button a no-op on exactly the screen it was needed to escape.
        setEditingId(account.id);
        toast(`${name} created`);
      } else {
        await store.update(editingId, { name, defaults: draft });
        toast(`${name} saved`);
      }
    } catch {
      toast("Couldn’t save this account.", { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  /*
   * Nothing else re-runs injectFontFaces() after the sign-in that first calls
   * it (useSession's refresh, fire and forget) — so without this, a newly
   * added family would show up in the picker with no @font-face rule behind
   * it, and weightFor() would keep answering the TEXT_WEIGHT fallback until a
   * full reload. Re-injecting here right after the add resolves is what makes
   * the family genuinely usable the moment it appears.
   */
  const addFont = async () => {
    const family = fontDraft.trim();
    if (!family) return;
    setAddingFont(true);
    try {
      await store.addGoogleFont(family);
      // addGoogleFont() above already ran its own refresh() — a GET
      // /api/fonts that landed a moment ago — so the store's snapshot is
      // already the freshest list there is. Passing it through rather than
      // letting injectFontFaces() fetch its own copy turns what used to be
      // two identical GETs into one.
      await injectFontFaces(store.getSnapshot().fonts);
      setFontDraft("");
      toast(`${family} added`);
    } catch (error) {
      // The server names the exact reason a family failed — no such family
      // on Google Fonts, no Latin subset available, or a font URL Google
      // Fonts' own CSS did not actually point at their CDN (see fonts.ts) —
      // and a typo is not the same failure as a network error. Shown as-is,
      // the same way removeFont() below and remove() (accounts) already
      // surface their own server messages, rather than one generic toast
      // that reads identically for every distinct cause.
      const message =
        error instanceof ApiError ? error.message : `Couldn’t add ${family}.`;
      toast(message, { tone: "danger" });
    } finally {
      setAddingFont(false);
    }
  };

  const removeFont = async (font: FontEntry) => {
    if (removingFontId !== null) return;
    setRemovingFontId(font.id);
    try {
      await store.removeFont(font.id);
      // Mirrors addFont() above: without this, the injected <style> kept its
      // rule for the deleted family pointing at a /media/<id>.woff2 the
      // server just unlinked, and weightFor(font.family) kept answering its
      // old weight, until a full reload. store.removeFont() already ran its
      // own refresh(), so the snapshot's fonts list is already the deletion's
      // own aftermath — nothing more to fetch.
      await injectFontFaces(store.getSnapshot().fonts);
      // The deleted family was this draft's own choice: fall back to the
      // builtin rather than leaving the form (and the Select's value) naming
      // a font that no longer exists anywhere.
      if (draft.text.fontFamily === font.family) {
        setDraft((current) => ({
          ...current,
          text: { ...current.text, fontFamily: BUILTIN_DEFAULTS.text.fontFamily },
        }));
      }
      toast(`${font.family} deleted`);
    } catch (error) {
      // FontInUseError's own message already names what still uses the
      // family (fonts.ts: "used by N accounts or slideshows"), so it is
      // shown as-is — mirrors remove() above for accounts, the same shape of
      // 409.
      const message =
        error instanceof ApiError ? error.message : `Couldn’t delete ${font.family}.`;
      toast(message, { tone: "danger" });
    } finally {
      setRemovingFontId(null);
    }
  };

  return (
    <>
      <Header>
        <Button variant="solid" onClick={startNew}>
          New account
        </Button>
      </Header>
      <main className={styles.admin}>
        <ul className={styles.list} aria-label="Accounts">
          {accounts.map((account) => {
            // Deleting the one remaining account would leave nothing to hold
            // a slide's defaults, or a new slideshow's account. The server
            // has no opinion on this — it only refuses a non-empty account —
            // so the guard lives here.
            const isOnlyAccount = accounts.length <= 1;
            return (
              <li key={account.id} className={styles.item}>
                <button
                  type="button"
                  className={styles.row}
                  aria-pressed={editingId === account.id}
                  onClick={() => {
                    select(account);
                  }}
                >
                  {account.name}
                </button>
                <IconButton
                  icon="trash"
                  variant="danger"
                  size="sm"
                  label={
                    isOnlyAccount
                      ? `${account.name} is the only account and can’t be deleted`
                      : `Delete ${account.name}`
                  }
                  disabled={isOnlyAccount || removingId !== null}
                  onClick={() => {
                    void remove(account);
                  }}
                />
              </li>
            );
          })}
        </ul>

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Name">
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <Field label="Aspect ratio">
            <Select
              items={RATIO_OPTIONS}
              value={ratioLabel(draft.ratio)}
              onValueChange={(label) => {
                const preset = RATIO_PRESETS.find((item) => item.label === label);
                if (preset === undefined) return;
                setDraft((current) => ({
                  ...current,
                  ratio: { w: preset.w, h: preset.h },
                }));
              }}
            />
          </Field>

          <Field label="Font">
            <Select
              items={fonts.map((entry) => ({ value: entry.family, label: entry.family }))}
              value={draft.text.fontFamily}
              onValueChange={(family) => {
                setDraft((current) => ({
                  ...current,
                  text: { ...current.text, fontFamily: family },
                }));
              }}
            />
          </Field>

          <div className={styles.addFont}>
            <Field label="Add a Google font">
              <Input
                value={fontDraft}
                placeholder="e.g. Bebas Neue"
                onChange={(event) => {
                  setFontDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  // This input sits inside the account <form>, whose own
                  // submit button ("Create account"/"Save account") is what
                  // Enter here would otherwise implicitly invoke — the
                  // browser's default behaviour for a text input with no
                  // submit button of its own nearby. Enter is what a reader
                  // reaches for after typing a font name, so it does what
                  // clicking "Add font" does instead of creating or saving
                  // the account by accident.
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void addFont();
                }}
              />
            </Field>
            <Button
              busy={addingFont}
              onClick={() => {
                void addFont();
              }}
            >
              Add font
            </Button>
          </div>

          {
            // A builtin (TikTok Sans, Space Mono) has nothing to offer here —
            // FontService.remove() refuses to delete one server-side, so
            // only the Google fonts an account has actually added get a
            // control. Without this list, a family added by typo (or no
            // longer wanted) had no way to be removed at all: AccountsStore
            // already exposed removeFont() and the server its 409 for a
            // still-used family, but nothing on screen ever called either.
          }
          {fonts.some((font) => font.source === "google") && (
            <Field label="Added Google fonts">
              <ul className={styles.fontList} aria-label="Added Google fonts">
                {fonts
                  .filter((font) => font.source === "google")
                  .map((font) => (
                    <li key={font.id} className={styles.fontItem}>
                      <span className={styles.fontLabel}>{font.family}</span>
                      <IconButton
                        icon="trash"
                        variant="danger"
                        size="sm"
                        label={`Delete ${font.family}`}
                        disabled={removingFontId !== null}
                        onClick={() => {
                          void removeFont(font);
                        }}
                      />
                    </li>
                  ))}
              </ul>
            </Field>
          )}

          <Field label="Style">
            <Select
              items={STYLE_OPTIONS}
              value={draft.text.style}
              onValueChange={(value) => {
                setDraft((current) => ({
                  ...current,
                  text: {
                    ...current.text,
                    style: value as AccountDefaults["text"]["style"],
                  },
                }));
              }}
            />
          </Field>

          {
            // Text no longer shrinks to fit (compose.ts's size ladder is
            // gone), so this is the main lever an account has for keeping a
            // long slide's text on screen. FontSizeSlider is the same control
            // TextInspector.tsx offers for one text layer, reused here for
            // the account's default rather than reimplemented.
          }
          <FontSizeSlider
            size={draft.text.size}
            onEditStart={noEdit}
            onEditEnd={noEdit}
            onChange={(size) => {
              setDraft((current) => ({ ...current, text: { ...current.text, size } }));
            }}
          />

          <Field label="Text color">
            <ColorPicker
              value={draft.text.color}
              onEditStart={noEdit}
              onEditEnd={noEdit}
              onChange={(color) => {
                setDraft((current) => ({ ...current, text: { ...current.text, color } }));
              }}
            />
          </Field>

          <Field label="Background">
            <Select
              items={BACKGROUND_OPTIONS}
              value={draft.text.background}
              onValueChange={(value) => {
                setDraft((current) => ({
                  ...current,
                  text: {
                    ...current.text,
                    background: value as AccountDefaults["text"]["background"],
                  },
                }));
              }}
            />
          </Field>

          <Field label="Background shape">
            <Select
              items={SHAPE_OPTIONS}
              value={draft.text.backgroundShape}
              onValueChange={(value) => {
                setDraft((current) => ({
                  ...current,
                  text: {
                    ...current.text,
                    backgroundShape: value as AccountDefaults["text"]["backgroundShape"],
                  },
                }));
              }}
            />
          </Field>

          <Field label="Alignment">
            <Select
              items={ALIGN_OPTIONS}
              value={draft.text.align}
              onValueChange={(value) => {
                setDraft((current) => ({
                  ...current,
                  text: {
                    ...current.text,
                    align: value as AccountDefaults["text"]["align"],
                  },
                }));
              }}
            />
          </Field>

          <AccountPreview defaults={draft} />

          <Button type="submit" variant="solid" busy={saving}>
            {editingId === null ? "Create account" : "Save account"}
          </Button>
        </form>
      </main>
    </>
  );
}
