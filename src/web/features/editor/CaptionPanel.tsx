import { useCallback } from "react";
import { DESCRIPTION_LIMIT, normalizeHashtags } from "@shared/schema/index.js";
import {
  Button,
  Field,
  Icon,
  Input,
  Popover,
  Textarea,
  useToast,
} from "../../design/index.js";
import { useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import styles from "./CaptionPanel.module.css";

/*
 * The caption: what the slideshow is posted with, and the tags under it.
 *
 * It sits in the editor header rather than in the inspector, next to the name
 * and the status. The inspector describes the slide on screen and repaints on
 * every selection; the caption belongs to the slideshow as a whole, which is
 * what the header holds. A popover rather than a permanent column because the
 * caption is written once and read at posting time, so it earns its space only
 * when it is asked for.
 *
 * Both fields write through EditorStore, so a caption is an edit like any
 * other: it counts as unsaved, it defers an agent's reload, and it raises the
 * unload prompt.
 */

export type CaptionPanelProps = {
  store: EditorStore;
};

/** The reason both fields exist: a caption is written here and pasted elsewhere. */
async function writeToClipboard(value: string): Promise<void> {
  // Absent on an insecure origin, which the LAN mode of the README is.
  if (!navigator.clipboard) throw new Error("This browser exposes no clipboard.");
  await navigator.clipboard.writeText(value);
}

export function CaptionPanel({ store }: CaptionPanelProps) {
  const { toast } = useToast();
  const description = useEditor(store, (state) => state.project.description);
  const hashtags = useEditor(store, (state) => state.project.hashtags);

  const copy = useCallback(
    (what: string, value: string) => {
      void (async () => {
        try {
          await writeToClipboard(value);
          toast(`${what} copied`);
        } catch (error) {
          console.error(error);
          toast(`Couldn’t copy the ${what.toLowerCase()}.`, { tone: "danger" });
        }
      })();
    },
    [toast],
  );

  /*
   * Tidied when the reader leaves the field, never while they are still in it.
   * Normalising on every keystroke would rewrite a tag halfway through its
   * first letter. Leaving it untidied would let the field, the stored caption
   * and the copied text disagree, and the copy is the whole point.
   */
  const tidyHashtags = useCallback(() => {
    store.setHashtags(normalizeHashtags(hashtags));
  }, [hashtags, store]);

  return (
    <Popover.Root
      onOpenChange={(open) => {
        // A click outside closes the popover, and the field it closes may never
        // see a blur of its own.
        if (!open) tidyHashtags();
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="ghost">
          <Icon name="text" />
          <span>Caption</span>
        </Button>
      </Popover.Trigger>
      <Popover.Content className={styles.panel ?? ""} align="end" aria-label="Caption">
        <Field
          label="Description"
          hint="What you will post with these slides. An agent can write a first draft."
        >
          <Textarea
            className={styles.description ?? ""}
            rows={6}
            maxLength={DESCRIPTION_LIMIT}
            value={description}
            onChange={(event) => {
              store.setDescription(event.target.value);
            }}
          />
        </Field>
        <Button
          className={styles.copy ?? ""}
          variant="outline"
          size="sm"
          disabled={description === ""}
          onClick={() => {
            copy("Description", description);
          }}
        >
          Copy description
        </Button>
        <Field label="Hashtags" hint="Separated by spaces. The # is added for you.">
          <Input
            value={hashtags}
            placeholder="#travel #summer"
            onChange={(event) => {
              store.setHashtags(event.target.value);
            }}
            onBlur={tidyHashtags}
          />
        </Field>
        <Button
          className={styles.copy ?? ""}
          variant="outline"
          size="sm"
          disabled={hashtags === ""}
          onClick={() => {
            // The tidied form, so what lands on the clipboard is what the field
            // is about to settle on rather than a half typed line.
            copy("Hashtags", normalizeHashtags(hashtags));
          }}
        >
          Copy hashtags
        </Button>
      </Popover.Content>
    </Popover.Root>
  );
}
