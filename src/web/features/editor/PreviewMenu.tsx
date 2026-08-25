import type { Ratio } from "@shared/schema/index.js";
import { Button, DropdownMenu, Icon } from "../../design/index.js";
import { PREVIEW_CHROMES, suggestedChrome } from "./chrome/chrome.js";
import type { ChromeId } from "./chrome/chrome.js";

/*
 * The overlay picker in the canvas actions, ported from showPreviewMenu
 * (app.js:897-931) and the trigger at app.js:1729.
 *
 * app.js held two pieces of state, previewVisible and previewChromeChoice, and
 * "Off" cleared only the first (app.js:954-956). Keeping the last choice while
 * nothing is drawn changes nothing anyone can see, so one ChromeId carries both:
 * "none" is off, and every other value is both on and which.
 */

const CHROME_IDS: readonly ChromeId[] = [
  "none",
  ...PREVIEW_CHROMES.map((option) => option.id),
];

/* Radix hands back a plain string, so the union is checked rather than asserted. */
function asChromeId(value: string): ChromeId | null {
  return CHROME_IDS.find((id) => id === value) ?? null;
}

export type PreviewMenuProps = {
  chrome: ChromeId;
  /** Decides which row is tagged "Suggested" (app.js:902). */
  ratio: Ratio;
  onChange: (chrome: ChromeId) => void;
};

export function PreviewMenu({ chrome, ratio, onChange }: PreviewMenuProps) {
  const suggested = suggestedChrome(ratio);

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant={chrome === "none" ? "outline" : "solid"}
          aria-label="Choose the UI preview overlay"
          title="Choose the UI preview overlay"
        >
          <Icon name="preview" />
          <span>Overlay</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="right"
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
          value={chrome}
          onValueChange={(value) => {
            const next = asChromeId(value);
            if (next !== null) onChange(next);
          }}
        >
          <DropdownMenu.RadioItem value="none">Off</DropdownMenu.RadioItem>
          {PREVIEW_CHROMES.map((option) => (
            <DropdownMenu.RadioItem
              key={option.id}
              value={option.id}
              {...(option.id === suggested
                ? { tag: "Suggested", "aria-label": `${option.label}, suggested` }
                : {})}
            >
              {option.label}
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
