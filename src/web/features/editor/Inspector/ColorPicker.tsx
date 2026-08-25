import { useState } from "react";
import {
  TEXT_COLOR_PRESETS,
  formatRgb,
  normalizeHexColor,
  rgbToHex,
} from "@shared/geometry/index.js";
import styles from "./Inspector.module.css";

/*
 * The text colour control, ported from the colour block of renderInspector
 * (app.js:2007-2035) and its handlers (app.js:2371-2429).
 *
 * Every conversion is Task 4's. Nothing here parses a colour by hand.
 */

export type ColorPickerProps = {
  /** The colour as it stands, already normalized to #RRGGBB. */
  value: string;
  /** Writes a normalized colour. */
  onChange: (color: string) => void;
  /**
   * Opens one undo entry for a gesture, and closes it. The wheel fires an input
   * event per pixel of drag, and the hex box one per keystroke, so without this
   * a single colour choice would fill the undo stack (app.js:2402-2412).
   */
  onEditStart: () => void;
  onEditEnd: () => void;
};

/** app.js:272-285, without the execCommand fallback for a browser that has one. */
function copyText(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

export function ColorPicker({
  value,
  onChange,
  onEditStart,
  onEditEnd,
}: ColorPickerProps) {
  /*
   * The two text boxes hold what was typed, not what is stored. "#ff00" is
   * halfway to a colour and must stay on screen; app.js:2413-2415 writes only
   * once six digits are there, and leaves the box alone until then.
   */
  const [hexDraft, setHexDraft] = useState(value);
  const [rgbDraft, setRgbDraft] = useState(() => formatRgb(value));

  /*
   * A colour chosen anywhere else, including by the other box, replaces both
   * drafts. app.js did this by writing the sibling inputs directly and skipping
   * the one the edit came from (app.js:2381-2383).
   *
   * This is React's own "adjusting state when a prop changes" pattern rather
   * than an effect. An effect would paint the stale text first and correct it
   * on the next frame, which is visible on the box the edit did not come from.
   */
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setHexDraft(value);
    setRgbDraft(formatRgb(value));
  }

  const write = (color: string | null): void => {
    if (color === null) return;
    onChange(color);
  };

  return (
    <>
      <div className={styles.presets} role="group" aria-label="Text color presets">
        {TEXT_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.value}
            className={styles.preset}
            type="button"
            style={{ background: preset.value }}
            title={`${preset.name} ${preset.value}`}
            aria-label={`Use ${preset.name} text`}
            aria-pressed={value === preset.value}
            onClick={() => {
              onEditStart();
              write(preset.value);
              onEditEnd();
            }}
          />
        ))}
      </div>
      <div className={styles.custom}>
        <label className={styles.wheel}>
          <input
            type="color"
            value={value}
            aria-label="Choose a custom text color"
            onPointerDown={onEditStart}
            onBlur={onEditEnd}
            onChange={(event) => {
              onEditStart();
              write(normalizeHexColor(event.target.value));
            }}
          />
          <span>Color wheel</span>
        </label>
        <div className={styles.values}>
          <div className={styles.valueRow}>
            <label htmlFor="text-color-hex">Hex</label>
            <input
              id="text-color-hex"
              type="text"
              value={hexDraft}
              maxLength={7}
              spellCheck={false}
              aria-label="Text color hex value"
              onFocus={onEditStart}
              onChange={(event) => {
                setHexDraft(event.target.value);
                const typed = event.target.value.trim().replace(/^#/, "");
                // app.js:2414 waits for all six digits rather than accepting the
                // three-digit form mid-type: "#fff" is also the first half of
                // "#fff000", so expanding it would fight the next keystroke.
                if (/^[0-9a-f]{6}$/i.test(typed)) write(normalizeHexColor(typed));
              }}
              onBlur={() => {
                // app.js:2416-2420. An unreadable box goes back to the colour
                // rather than leaving a value the slide does not have.
                write(normalizeHexColor(hexDraft));
                setHexDraft(value);
                onEditEnd();
              }}
            />
            <button
              className={styles.copy}
              type="button"
              aria-label="Copy hex color"
              onClick={() => {
                copyText(value);
              }}
            >
              Copy
            </button>
          </div>
          <div className={styles.valueRow}>
            <label htmlFor="text-color-rgb">RGB</label>
            <input
              id="text-color-rgb"
              type="text"
              value={rgbDraft}
              spellCheck={false}
              aria-label="Text color RGB value"
              onFocus={onEditStart}
              onChange={(event) => {
                setRgbDraft(event.target.value);
                write(rgbToHex(event.target.value));
              }}
              onBlur={() => {
                write(rgbToHex(rgbDraft));
                setRgbDraft(formatRgb(value));
                onEditEnd();
              }}
            />
            <button
              className={styles.copy}
              type="button"
              aria-label="Copy RGB color"
              onClick={() => {
                copyText(formatRgb(value));
              }}
            >
              Copy
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
