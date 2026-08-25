import { useCallback, useEffect, useRef } from "react";
import {
  OUTPUT_WIDTH,
  ensureBoxedTextContrast,
  outputHeight,
} from "@shared/geometry/index.js";
import type { Ratio, SlideDocument, TextLayer } from "@shared/schema/index.js";
import { Icon, Textarea } from "../../../design/index.js";
import { useTextLayout } from "../text/useTextLayout.js";
import type { EditorStore } from "../store.js";
import { ColorPicker } from "./ColorPicker.js";
import { FontSizeSlider } from "./FontSizeSlider.js";
import { useHistoryEntry } from "./history.js";
import styles from "./Inspector.module.css";

/*
 * Every control that shapes one text layer. Ported from the text arm of
 * renderInspector (app.js:1974-2062) and its handlers (app.js:2313-2456).
 */

const TEXT_STYLES = [
  { id: "plain", label: "Clean", modifier: "" },
  { id: "outline", label: "Outline", modifier: styles.stylePreviewOutline ?? "" },
  { id: "boxed", label: "Box", modifier: styles.stylePreviewBoxed ?? "" },
] as const;

const ALIGNMENTS = ["left", "center", "right"] as const;

/** app.js:510-512. Anything the schema did not repair reads as centred. */
function alignmentOf(text: TextLayer): TextLayer["align"] {
  return ALIGNMENTS.includes(text.align) ? text.align : "center";
}

export type TextInspectorProps = {
  store: EditorStore;
  /** The primary text of the selection, which is the one the panel edits. */
  text: TextLayer;
  ratio: Ratio;
};

export function TextInspector({ store, text, ratio }: TextInspectorProps) {
  const entry = useHistoryEntry(store);
  const textId = text.id;

  const write = useCallback(
    (change: (live: TextLayer) => void, options?: { history?: boolean }) => {
      const activeSlideId = store.getSnapshot().activeSlideId;
      store.mutate(
        (document: SlideDocument) => {
          const live = document.slides
            .find((slide) => slide.id === activeSlideId)
            ?.texts.find((item) => item.id === textId);
          if (live === undefined) return;
          change(live);
        },
        { history: options?.history ?? false },
      );
    },
    [store, textId],
  );

  /*
   * One write that opens its own undo entry, for the controls that act once.
   * app.js:2325 and its siblings call recordHistory immediately before the
   * change for exactly these.
   */
  const writeOnce = useCallback(
    (change: (live: TextLayer) => void) => {
      write(change, { history: true });
    },
    [write],
  );

  /*
   * ensureTextFits (app.js:2931-2947), for the changes the inspector makes.
   *
   * Task 15's layer refits on a text change alone, so a bigger font or a switch
   * to per-line pills would otherwise clip. The layout is measured against the
   * export canvas rather than the stage: every length computeTextLayout returns
   * is linear in the render width, so contentHeight over the canvas height is
   * the same fraction at any zoom, and the inspector needs no stage rectangle
   * to ask the question.
   */
  const canvasHeight = outputHeight(ratio);
  const layout = useTextLayout(text, { width: OUTPUT_WIDTH, height: canvasHeight });
  const lastShape = useRef({
    size: text.size,
    style: text.style,
    backgroundShape: text.backgroundShape,
  });
  useEffect(() => {
    const previous = lastShape.current;
    if (
      previous.size === text.size &&
      previous.style === text.style &&
      previous.backgroundShape === text.backgroundShape
    ) {
      return;
    }
    lastShape.current = {
      size: text.size,
      style: text.style,
      backgroundShape: text.backgroundShape,
    };
    const needed = Math.min(1, layout.contentHeight / canvasHeight);
    // app.js:2941 only ever grows the box, so shrinking the font never
    // collapses a box the author sized by hand.
    if (needed <= text.height) return;
    write((live) => {
      live.height = needed;
    });
  }, [
    canvasHeight,
    layout.contentHeight,
    text.backgroundShape,
    text.height,
    text.size,
    text.style,
    write,
  ]);

  const align = alignmentOf(text);

  return (
    <>
      <div className={styles.group}>
        <label className={styles.label} htmlFor="text-value">
          Words
        </label>
        <Textarea
          id="text-value"
          value={text.text}
          maxLength={500}
          placeholder="Type something…"
          onFocus={entry.begin}
          onBlur={entry.end}
          onChange={(event) => {
            const next = event.target.value;
            entry.begin();
            write((live) => {
              live.text = next;
            });
          }}
        />
      </div>

      <div className={styles.group}>
        <div className={styles.label}>Style</div>
        <div className={`${styles.options ?? ""} ${styles.options3 ?? ""}`}>
          {TEXT_STYLES.map((option) => (
            <button
              key={option.id}
              className={`${styles.option ?? ""} ${styles.styleOption ?? ""}`}
              type="button"
              aria-pressed={text.style === option.id}
              onClick={() => {
                writeOnce((live) => {
                  live.style = option.id;
                  // app.js:2328. A boxed text whose colour matches its own pill
                  // would be invisible, so the colour flips rather than the box.
                  live.color = ensureBoxedTextContrast(live).color;
                });
              }}
            >
              <span
                className={`${styles.stylePreview ?? ""} ${option.modifier}`}
                aria-hidden="true"
              >
                Aa
              </span>
              <small>{option.label}</small>
            </button>
          ))}
        </div>
      </div>

      <FontSizeSlider
        size={text.size}
        onEditStart={entry.begin}
        onEditEnd={entry.end}
        onChange={(size) => {
          write((live) => {
            live.size = size;
          });
        }}
      />

      <div className={styles.group}>
        <div className={styles.label}>Text color</div>
        <ColorPicker
          value={text.color}
          onEditStart={entry.begin}
          onEditEnd={entry.end}
          onChange={(color) => {
            write((live) => {
              live.color = color;
            });
          }}
        />
      </div>

      <div className={styles.group}>
        <div className={styles.label}>Alignment</div>
        <div
          className={`${styles.options ?? ""} ${styles.options3 ?? ""}`}
          role="group"
          aria-label="Text alignment"
        >
          {ALIGNMENTS.map((value) => (
            <button
              key={value}
              className={`${styles.option ?? ""} ${styles.alignOption ?? ""}`}
              type="button"
              aria-label={`Align text ${value}`}
              aria-pressed={align === value}
              onClick={() => {
                writeOnce((live) => {
                  live.align = value;
                });
              }}
            >
              <Icon name={`align-${value}`} />
            </button>
          ))}
        </div>
      </div>

      {text.style !== "boxed" ? null : (
        <>
          <div className={styles.group}>
            <div className={styles.label}>Background</div>
            <div
              className={`${styles.options ?? ""} ${styles.options2 ?? ""}`}
              role="group"
              aria-label="Box background"
            >
              {(["white", "black"] as const).map((tone) => (
                <button
                  key={tone}
                  className={`${styles.option ?? ""} ${styles.toneOption ?? ""}`}
                  type="button"
                  aria-label={tone === "black" ? "Black background" : "White background"}
                  aria-pressed={
                    tone === "black"
                      ? text.background === "black"
                      : text.background !== "black"
                  }
                  onClick={() => {
                    writeOnce((live) => {
                      live.background = tone;
                      live.color = ensureBoxedTextContrast(live).color;
                    });
                  }}
                >
                  <span
                    className={`${styles.toneSwatch ?? ""} ${
                      (tone === "black"
                        ? styles.toneSwatchBlack
                        : styles.toneSwatchWhite) ?? ""
                    }`}
                    aria-hidden="true"
                  >
                    Aa
                  </span>
                  {tone === "black" ? "Black" : "White"}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.group}>
            <div className={styles.label}>Shape</div>
            <div
              className={`${styles.options ?? ""} ${styles.options2 ?? ""}`}
              role="group"
              aria-label="Box shape"
            >
              <button
                className={`${styles.option ?? ""} ${styles.shapeOption ?? ""}`}
                type="button"
                aria-label="Per line"
                aria-pressed={text.backgroundShape !== "full"}
                onClick={() => {
                  writeOnce((live) => {
                    live.backgroundShape = "lines";
                  });
                }}
              >
                <span
                  className={`${styles.shapePreview ?? ""} ${styles.shapePreviewLines ?? ""}`}
                >
                  <i>Text line</i>
                  <i>Shorter</i>
                </span>
                <small>Per line</small>
              </button>
              <button
                className={`${styles.option ?? ""} ${styles.shapeOption ?? ""}`}
                type="button"
                aria-label="Full box"
                aria-pressed={text.backgroundShape === "full"}
                onClick={() => {
                  writeOnce((live) => {
                    live.backgroundShape = "full";
                  });
                }}
              >
                <span
                  className={`${styles.shapePreview ?? ""} ${styles.shapePreviewFull ?? ""}`}
                />
                <small>Full box</small>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
