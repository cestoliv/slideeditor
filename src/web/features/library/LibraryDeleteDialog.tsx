import type { LibraryItem, LibraryUse } from "@shared/schema/index.js";
import { Button, Dialog } from "../../design/index.js";

/*
 * The warning shown when the server refuses a delete with a 409. Ported from
 * showLibraryDeleteConfirmation (app.js:1477-1515), whose hand rolled backdrop
 * becomes a Dialog, so Escape, the focus trap and the return of focus to the
 * card are Radix's rather than half written.
 *
 * The names matter more than the warning does. "It is used somewhere" leaves a
 * person guessing which of their slideshows they are about to break.
 */

export type LibraryDeleteDialogProps = {
  /** The item awaiting a decision, or null when nothing is. */
  item: LibraryItem | null;
  usedBy: readonly LibraryUse[];
  /** True while the forced delete is in flight, so a second press is dropped. */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function LibraryDeleteDialog({
  item,
  usedBy,
  busy,
  onConfirm,
  onCancel,
}: LibraryDeleteDialogProps) {
  const many = usedBy.length !== 1;
  const named = usedBy.map((use) => use.name).join(", ");
  return (
    <Dialog.Root
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Content compact role="alertdialog">
        <Dialog.Title>Delete {item?.name}?</Dialog.Title>
        <Dialog.Description>
          {named === "" ? (
            // The server refuses a delete without naming a slideshow only if a
            // future version stops sending the list. Saying "it is used by ."
            // would be worse than saying plainly that the names are missing.
            <>
              A slideshow uses it, and the server did not say which one. Deleting it
              removes the image from every slideshow that uses it. This can’t be undone.
            </>
          ) : (
            <>
              It is used by <strong>{named}</strong>. Deleting it removes the image from{" "}
              {many ? "those slideshows" : "that slideshow"} as well. This can’t be
              undone.
            </>
          )}
        </Dialog.Description>
        <Dialog.Actions>
          <Dialog.Close asChild>
            <Button>Cancel</Button>
          </Dialog.Close>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            Delete anyway
          </Button>
        </Dialog.Actions>
      </Dialog.Content>
    </Dialog.Root>
  );
}
