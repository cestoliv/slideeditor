import { useState } from "react";
import {
  CUSTOM_RATIO_MAX,
  CUSTOM_RATIO_MIN,
  OUTPUT_WIDTH,
  RATIO_PRESETS,
  constrainImagePosition,
  constrainOverlay,
  isInstagramSafeRatio,
  naturalOverlayHeight,
  outputHeight,
  overlayCrop,
  ratioLabel,
  sameRatio,
} from "@shared/geometry/index.js";
import type { Ratio, SlideDocument } from "@shared/schema/index.js";
import type { LibraryIndex } from "../../app/useLibrary.js";
import {
  Button,
  DropdownMenu,
  Field,
  Input,
  MenuRow,
  MenuSeparator,
  Popover,
} from "../../design/index.js";
import { useEditor } from "./store.js";
import type { EditorStore } from "./store.js";
import styles from "./RatioMenu.module.css";

/*
 * The ratio picker under the stage, ported from showRatioMenu and
 * applyProjectRatio (app.js:803-897).
 *
 * app.js built one panel holding radio rows and a form. A Radix menu cannot
 * hold a form: arrow keys, typeahead and select-to-close all fight one, so the
 * panel splits in two. The presets are a DropdownMenu, and Custom hands over to
 * a Popover on the same trigger whose rows are MenuRow, which is the reason
 * that primitive exists.
 */

/** app.js:788. A ratio part shows at most two decimals, and no trailing zeros. */
function formatRatioPart(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** app.js:2884-2886. What the export writes for a ratio. */
function exportSize(ratio: Ratio): string {
  return `${String(OUTPUT_WIDTH)} × ${String(outputHeight(ratio))}`;
}

export type RatioMenuProps = {
  store: EditorStore;
  /** Overlay heights are recomputed from the asset's own pixel size. */
  library: LibraryIndex;
  /** app.js:895 toasts the new size. Task 14 owns the toaster. */
  onApplied?: ((message: string) => void) | undefined;
};

/**
 * Re-lays the whole slideshow for a new ratio (app.js:871-897).
 *
 * Every layer's position is a fraction of the canvas, so nothing has to move.
 * An overlay's height is the exception: it is a fraction of the canvas *height*
 * while its width is a fraction of the canvas *width*, so a new aspect makes
 * the stored height stale and would squash the photo. It is recomputed from the
 * asset and the crop, which is what keeps the README's promise.
 */
export function applyProjectRatio(
  store: EditorStore,
  library: LibraryIndex,
  next: Ratio,
): boolean {
  const current = store.getSnapshot().project.ratio;
  if (sameRatio(current, next)) return false;
  store.mutate((document: SlideDocument) => {
    document.ratio = next;
    for (const slide of document.slides) {
      for (const overlay of slide.overlays) {
        const asset = library.get(overlay.itemId);
        if (asset === undefined) continue;
        overlay.height = naturalOverlayHeight(
          overlay.width,
          asset,
          next,
          overlayCrop(overlay),
        );
        const held = constrainOverlay(overlay, asset, next);
        overlay.width = held.width;
        overlay.height = held.height;
        overlay.rotation = held.rotation;
      }
      const held = constrainImagePosition(slide, OUTPUT_WIDTH, outputHeight(next));
      slide.imageX = held.imageX;
      slide.imageY = held.imageY;
    }
  });
  return true;
}

type Draft = { w: string; h: string };

/** app.js:838-855. What the form says about what has been typed. */
function describe(draft: Draft): { ratio: Ratio | null; note: string } {
  const w = Number(draft.w);
  const h = Number(draft.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ratio: null, note: "Enter two positive numbers." };
  }
  const value = w / h;
  if (value < CUSTOM_RATIO_MIN || value > CUSTOM_RATIO_MAX) {
    return {
      ratio: null,
      note: `Keep the ratio between ${String(CUSTOM_RATIO_MIN)}:1 and ${String(CUSTOM_RATIO_MAX)}:1.`,
    };
  }
  const ratio: Ratio = { w, h };
  return {
    ratio,
    note: isInstagramSafeRatio(ratio)
      ? `Exports at ${exportSize(ratio)}.`
      : "Instagram accepts 3:4 to 1.91:1. TikTok takes this one.",
  };
}

export function RatioMenu({ store, library, onApplied }: RatioMenuProps) {
  const ratio = useEditor(store, (state) => state.project.ratio);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({
    w: formatRatioPart(ratio.w),
    h: formatRatioPart(ratio.h),
  }));

  /*
   * The form opens on whatever the slideshow currently is, however it got
   * there. React's "adjusting state when a prop changes" pattern rather than an
   * effect, so the fields never paint the old ratio for a frame.
   */
  const [shownRatio, setShownRatio] = useState(ratio);
  if (shownRatio.w !== ratio.w || shownRatio.h !== ratio.h) {
    setShownRatio(ratio);
    setDraft({ w: formatRatioPart(ratio.w), h: formatRatioPart(ratio.h) });
  }

  const apply = (next: Ratio): void => {
    if (!applyProjectRatio(store, library, next)) return;
    onApplied?.(`Slides are now ${ratioLabel(next)} · ${exportSize(next)}`);
  };

  const { ratio: typed, note } = describe(draft);

  return (
    <Popover.Root open={customOpen} onOpenChange={setCustomOpen}>
      <Popover.Anchor asChild>
        <span className={styles.anchor}>
          {/*
           * Not modal. A modal Radix menu takes pointer events off the body
           * while it closes, and Custom opens the popover on the same gesture,
           * so the form would arrive unclickable for as long as that lasted.
           */}
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                className={styles.trigger}
                type="button"
                aria-label="Change the slide ratio"
              >
                {`${exportSize(ratio)} · ${ratioLabel(ratio)}`}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              side="top"
              align="start"
              /*
               * Stage's marquee sees this press.
               *
               * Radix portals the panel to the body, but in the React tree it is
               * still a descendant of the actions column inside Stage's surface,
               * and React propagates events along the React tree rather than the
               * DOM. beginMarquee (Stage.tsx) therefore runs on a press here,
               * calls preventDefault and captures the pointer onto the surface,
               * and the row never sees its own pointerup.
               *
               * isInteractiveTarget (Stage.tsx:78) already excludes anything
               * inside [data-canvas-actions], and it lists no Radix row because a
               * menu item is a div rather than a button. Wearing the attribute is
               * how this panel says what it already is: part of the controls, not
               * of the canvas behind them.
               */
              data-canvas-actions=""
            >
              <DropdownMenu.RadioGroup
                value={ratioLabel(ratio)}
                onValueChange={(label) => {
                  const preset = RATIO_PRESETS.find((item) => item.label === label);
                  if (preset === undefined) return;
                  apply({ w: preset.w, h: preset.h });
                }}
              >
                {RATIO_PRESETS.map((preset) => (
                  <DropdownMenu.RadioItem
                    key={preset.label}
                    value={preset.label}
                    tag={preset.note}
                    /*
                     * MenuItemBody puts the tag straight after the label, so the
                     * accessible name computes as "1:1Square". The separator
                     * lives here rather than in the design system, which is
                     * closed to this task.
                     */
                    aria-label={`${preset.label}, ${preset.note}`}
                  >
                    {preset.label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onSelect={() => {
                  // The menu closes itself on select, so the popover opens on
                  // the frame after rather than fighting it for focus.
                  setCustomOpen(true);
                }}
              >
                Custom ratio…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </span>
      </Popover.Anchor>
      <Popover.Content
        side="top"
        align="start"
        className={styles.custom ?? ""}
        aria-label="Custom ratio"
        /* The same reason as the menu above: see the comment there. */
        data-canvas-actions=""
      >
        <MenuRow tag={exportSize(ratio)}>{`Now ${ratioLabel(ratio)}`}</MenuRow>
        <MenuSeparator />
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (typed === null) return;
            setCustomOpen(false);
            apply(typed);
          }}
        >
          <div className={styles.fields}>
            <Field label="Width">
              <Input
                inputSize="sm"
                type="number"
                min={1}
                step={0.01}
                value={draft.w}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, w: event.target.value }));
                }}
              />
            </Field>
            <span aria-hidden="true">:</span>
            <Field label="Height">
              <Input
                inputSize="sm"
                type="number"
                min={1}
                step={0.01}
                value={draft.h}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, h: event.target.value }));
                }}
              />
            </Field>
          </div>
          {/*
           * A live region rather than a plain note. The message is the only
           * thing that says why Apply refused, and a reader who never sees the
           * panel would otherwise press it into silence (app.js:856 wrote the
           * same text into a <small> nobody announced).
           */}
          <p className={styles.note} role="status">
            {note}
          </p>
          <Button type="submit" variant="solid" size="sm" disabled={typed === null}>
            Apply
          </Button>
        </form>
      </Popover.Content>
    </Popover.Root>
  );
}
