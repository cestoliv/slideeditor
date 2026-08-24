import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "@shared/text/index.js";
import { Input, Slider } from "../../../design/index.js";
import {
  FONT_SIZE_SLIDER_MAX,
  FONT_SIZE_SLIDER_STEP,
  clampFontSize,
  fontSizeFromSliderPosition,
  formatFontSize,
  sliderPositionFromFontSize,
} from "./fontSize.js";
import styles from "./Inspector.module.css";

/*
 * The size control, ported from app.js:1994-2001 and app.js:2352-2372.
 *
 * The slider carries a position rather than a size, because the four stops in
 * fontSize.ts give the small sizes most of the travel. The number beside it
 * carries the size itself, so an exact value is still reachable.
 */

export type FontSizeSliderProps = {
  size: number;
  onChange: (size: number) => void;
  /** One undo entry per drag, rather than one per input event. */
  onEditStart: () => void;
  onEditEnd: () => void;
};

export function FontSizeSlider({
  size,
  onChange,
  onEditStart,
  onEditEnd,
}: FontSizeSliderProps) {
  const shown = formatFontSize(size);

  return (
    <div className={styles.group}>
      <div className={styles.label}>
        <span>Size</span>
        <output htmlFor="font-size">{`${shown} px`}</output>
      </div>
      <div className={styles.rangeRow}>
        <Slider
          id="font-size"
          min={0}
          max={FONT_SIZE_SLIDER_MAX}
          step={FONT_SIZE_SLIDER_STEP}
          value={sliderPositionFromFontSize(size)}
          aria-label="Font size"
          // The thumb reports a slider position, which means nothing to a
          // listener. app.js:2364 overrode the same announcement for the same
          // reason.
          aria-valuetext={`${shown} pixels`}
          onValueChange={(position) => {
            onEditStart();
            onChange(fontSizeFromSliderPosition(position));
          }}
          onValueCommit={onEditEnd}
        />
        <Input
          inputSize="sm"
          type="number"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={0.5}
          value={shown}
          aria-label="Font size in pixels"
          onFocus={onEditStart}
          onBlur={onEditEnd}
          onChange={(event) => {
            onEditStart();
            onChange(clampFontSize(event.target.value));
          }}
        />
      </div>
    </div>
  );
}
