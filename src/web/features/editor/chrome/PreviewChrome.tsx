import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { OUTPUT_WIDTH, outputHeight } from "@shared/geometry/index.js";
import type { Ratio } from "@shared/schema/index.js";
import { InstagramFeedChrome } from "./InstagramFeedChrome.js";
import { InstagramStoryChrome } from "./InstagramStoryChrome.js";
import { TikTokChrome } from "./TikTokChrome.js";
import type { ChromeId } from "./chrome.js";
import styles from "./chrome.module.css";

/*
 * The platform mock-up over the stage, ported from renderPreviewChrome
 * (app.js:1734-1750).
 *
 * It is decoration and nothing else. renderSlideCanvas (app.js:4228-4238) draws
 * the export from the document onto a fresh canvas and never reads the page, so
 * nothing here can reach a PNG. That is asserted rather than assumed, in
 * chrome.browser.test.tsx.
 *
 * The mock is authored at OUTPUT_WIDTH and scaled onto the stage. app.js read
 * --stage-scale off the stage element, which sizeStage published there
 * (app.js:2612) and which the chrome inherited by sitting inside it. This
 * overlay is a sibling of that element rather than a descendant, and a custom
 * property does not reach a sibling, so Stage no longer publishes either
 * property and nothing here reads one. Measuring the overlay's own width needs
 * nothing from Stage and cannot go stale: the overlay covers the stage exactly,
 * so its width over OUTPUT_WIDTH is the same number, which
 * `scales the mock onto the stage` asserts against the stage itself.
 */

export type PreviewChromeProps = {
  chrome: ChromeId;
  ratio: Ratio;
  /** The carousel dots and the counter, which only Instagram's feed draws. */
  slideCount: number;
  /** One-based (app.js:1780). */
  slideIndex: number;
};

export function PreviewChrome({
  chrome,
  ratio,
  slideCount,
  slideIndex,
}: PreviewChromeProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      const measured = element.getBoundingClientRect().width;
      setWidth((current) => (current === measured ? current : measured));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [chrome]);

  if (chrome === "none") return null;

  const variant =
    chrome === "instagram-feed"
      ? styles.instagramFeed
      : chrome === "instagram-story"
        ? styles.instagramStory
        : // TikTok is the shape the canvas already has, so it needs no variant.
          undefined;

  return (
    <div
      className={`${styles.overlay ?? ""} ${variant ?? ""}`}
      ref={root}
      data-testid="preview-chrome"
      data-chrome={chrome}
      // app.js:1743. The mock is not content, so nothing here is announced.
      aria-hidden="true"
    >
      <div
        className={styles.canvas}
        style={
          {
            "--chrome-width": `${String(OUTPUT_WIDTH)}px`,
            "--chrome-height": `${String(outputHeight(ratio))}px`,
            "--chrome-scale": width / OUTPUT_WIDTH,
          } as CSSProperties
        }
      >
        <div className={styles.label}>PREVIEW ONLY · NOT EXPORTED</div>
        {chrome === "instagram-feed" ? (
          <InstagramFeedChrome slideCount={slideCount} slideIndex={slideIndex} />
        ) : chrome === "instagram-story" ? (
          <InstagramStoryChrome />
        ) : (
          <TikTokChrome />
        )}
      </div>
    </div>
  );
}
