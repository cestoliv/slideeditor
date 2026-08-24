import { useRef } from "react";
import type { LibraryKind, LibrarySort } from "@shared/schema/index.js";
import { Button, Icon, Input, Select } from "../../design/index.js";
import type { SelectOption } from "../../design/index.js";
import { IMAGE_ACCEPT, isImageFile } from "./upload.js";
import styles from "./LibraryAdmin.module.css";

/*
 * The bar above the grid: search, order, and the upload picker. Ported from the
 * toolbar of renderLibraryAdmin (app.js:1329-1333) and the two listeners that
 * drove it (app.js:1397-1429).
 *
 * The picker is a hidden file input a button clicks, which is how a file
 * chooser gets the app's own button rather than the browser's grey one.
 */

/** The three the server orders by (src/server/services/library.ts:22-27). */
const SORTS: readonly SelectOption[] = [
  { value: "recent", label: "Recently updated" },
  { value: "least-used", label: "Least used" },
  { value: "most-used", label: "Most used" },
];

export type LibraryFormProps = {
  kind: LibraryKind;
  query: string;
  onQueryChange: (query: string) => void;
  sort: LibrarySort;
  onSortChange: (sort: LibrarySort) => void;
  /** True while an upload is in flight, so the picker cannot be opened twice. */
  uploading: boolean;
  onUpload: (files: File[]) => void;
};

export function LibraryForm({
  kind,
  query,
  onQueryChange,
  sort,
  onSortChange,
  uploading,
  onUpload,
}: LibraryFormProps) {
  const picker = useRef<HTMLInputElement>(null);
  const plural = kind === "asset" ? "assets" : "backgrounds";

  return (
    <div className={styles.toolbar}>
      <Input
        className={styles.search ?? ""}
        type="search"
        value={query}
        placeholder="Search name, description, usage or tags"
        aria-label="Search the library"
        onChange={(event) => {
          onQueryChange(event.currentTarget.value);
        }}
      />
      <Select
        items={SORTS}
        value={sort}
        aria-label="Order"
        onValueChange={(value) => {
          // The value can only be one of the three above, and librarySortSchema
          // repairs anything else the same way the server does.
          onSortChange(value as LibrarySort);
        }}
      />
      <Button
        variant="solid"
        busy={uploading}
        onClick={() => {
          picker.current?.click();
        }}
      >
        <Icon name="plus" />
        <span>Upload {plural}</span>
      </Button>
      <input
        ref={picker}
        className={styles.picker}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        onChange={(event) => {
          const chosen = [...(event.currentTarget.files ?? [])].filter(isImageFile);
          // app.js:1415 cleared the input first, so choosing the same file
          // twice in a row still fires a change the second time.
          event.currentTarget.value = "";
          if (chosen.length > 0) onUpload(chosen);
        }}
      />
    </div>
  );
}
