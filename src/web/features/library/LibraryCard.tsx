import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { LibraryItem } from "@shared/schema/index.js";
import type { LibraryPatch } from "../../app/api.js";
import { Button, Card, Field, Icon, Input, Textarea } from "../../design/index.js";
import { describeUsage } from "./usage.js";
import styles from "./LibraryAdmin.module.css";

/*
 * One image in the library, with the four fields an agent reads. Ported from
 * renderLibraryCard (app.js:1346-1377) and the per card half of bindLibraryAdmin
 * (app.js:1431-1452).
 *
 * The fields stay uncontrolled and save on the DOM's own change, exactly as the
 * old page did: a save per keystroke would be a request per keystroke, and the
 * server answers with the whole item.
 */

/** app.js:1440. How long "Saved" stays up before the footer goes quiet again. */
export const SAVED_NOTICE_MS = 1600;

export type LibraryField = "name" | "description" | "usage" | "tags";

/** The controls the four fields render as. Both carry a `value`. */
type LibraryControl = HTMLInputElement | HTMLTextAreaElement;

type SaveState = "idle" | "saving" | "saved" | "failed";

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  failed: "Not saved",
};

/*
 * A computed key would widen the patch to a string index, which is the one
 * shape LibraryPatch cannot check. Naming each field keeps a typo a type error.
 */
function patchFor(field: LibraryField, value: string): LibraryPatch {
  switch (field) {
    case "name":
      return { name: value };
    case "description":
      return { description: value };
    case "usage":
      return { usage: value };
    case "tags":
      return { tags: value };
  }
}

/** What the field holds now, so an untouched field never costs a request. */
function currentValue(item: LibraryItem, field: LibraryField): string {
  switch (field) {
    case "name":
      return item.name;
    case "description":
      return item.description;
    case "usage":
      return item.usage;
    case "tags":
      return item.tags.join(", ");
  }
}

export type LibraryCardProps = {
  item: LibraryItem;
  /**
   * Resolves with the item the server kept, and rejects if it refused. The
   * saved item comes back rather than nothing, because the server normalises
   * what it stores and the field has to show that rather than what was typed.
   */
  onSave: (item: LibraryItem, patch: LibraryPatch) => Promise<LibraryItem>;
  onDelete: (item: LibraryItem) => void;
};

export function LibraryCard({ item, onSave, onDelete }: LibraryCardProps) {
  const [state, setState] = useState<SaveState>("idle");
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (clearTimer.current !== null) clearTimeout(clearTimer.current);
    },
    [],
  );

  const save = useCallback(
    async (field: LibraryField, control: LibraryControl) => {
      const value = control.value;
      if (value === currentValue(item, field)) return;
      if (clearTimer.current !== null) clearTimeout(clearTimer.current);
      setState("saving");
      try {
        const saved = await onSave(item, patchFor(field, value));
        // The server trims a name and splits a tag string into a list
        // (src/server/services/library.ts), so "travel,,  warm " comes back as
        // "travel, warm". Showing what was typed would tell the reader their
        // library holds something it does not.
        const kept = currentValue(saved, field);
        // Only if nothing has been typed since the request went out. Otherwise
        // this would overwrite a person mid sentence.
        if (control.value === value && kept !== value) control.value = kept;
        setState("saved");
        clearTimer.current = setTimeout(() => {
          setState("idle");
        }, SAVED_NOTICE_MS);
      } catch {
        // The field keeps what was typed, so the fix is another blur rather
        // than typing the whole description again.
        setState("failed");
      }
    },
    [item, onSave],
  );

  /*
   * Enter commits, on the two single line fields only. app.js bound the DOM's
   * own `change` event (app.js:1435), which an input fires on Enter as well as
   * on blur. A textarea is left alone: Enter there is a new line.
   */
  const commitOnEnter = useCallback(
    (field: LibraryField) => (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      void save(field, event.currentTarget);
    },
    [save],
  );

  return (
    <Card className={styles.card ?? ""} padding="sm">
      <div className={styles.thumb}>
        <img src={item.url} alt={item.name} loading="lazy" />
      </div>
      <div className={styles.fields}>
        <Field label="Name">
          <Input
            inputSize="sm"
            defaultValue={item.name}
            maxLength={120}
            onKeyDown={commitOnEnter("name")}
            onBlur={(event) => {
              void save("name", event.currentTarget);
            }}
          />
        </Field>
        <Field label="Description · what it shows">
          <Textarea
            rows={2}
            defaultValue={item.description}
            placeholder="A wide sunset over an empty beach"
            onBlur={(event) => {
              void save("description", event.currentTarget);
            }}
          />
        </Field>
        <Field label="Usage · when to use it">
          <Textarea
            rows={2}
            defaultValue={item.usage}
            placeholder="Use as an opening slide for travel posts"
            onBlur={(event) => {
              void save("usage", event.currentTarget);
            }}
          />
        </Field>
        <Field label="Tags">
          <Input
            inputSize="sm"
            defaultValue={item.tags.join(", ")}
            placeholder="travel, warm"
            onKeyDown={commitOnEnter("tags")}
            onBlur={(event) => {
              void save("tags", event.currentTarget);
            }}
          />
        </Field>
        <div className={styles.cardFooter}>
          <span className={styles.meta}>
            {String(item.width)} × {String(item.height)} · {describeUsage(item.stats)}
          </span>
          <span className={styles.saveState} role="status">
            {SAVE_LABEL[state]}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className={styles.delete ?? ""}
            aria-label={`Delete ${item.name}`}
            onClick={() => {
              onDelete(item);
            }}
          >
            <Icon name="trash" />
            <span>Delete</span>
          </Button>
        </div>
      </div>
    </Card>
  );
}
