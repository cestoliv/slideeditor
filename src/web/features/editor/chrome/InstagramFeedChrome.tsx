import styles from "./chrome.module.css";

/*
 * Ported from renderInstagramFeedChrome (app.js:1778-1800).
 *
 * Instagram draws its feed chrome above and below the photo rather than on it.
 * The bands here overlap the edges to show how close that chrome sits, so key
 * content stays clear of the extreme top and bottom.
 */

/** app.js:1795. The carousel never shows more than ten dots, however long it is. */
const MAX_DOTS = 10;

export type InstagramFeedChromeProps = {
  slideCount: number;
  /** One-based, the way the counter reads (app.js:1780). */
  slideIndex: number;
};

export function InstagramFeedChrome({
  slideCount,
  slideIndex,
}: InstagramFeedChromeProps) {
  const carousel = slideCount > 1;
  return (
    <>
      <div className={styles.igHeader}>
        <span className={styles.igAvatar} />
        <span className={styles.igHandle}>
          <strong>yourname</strong>
        </span>
        <span className={styles.igMore}>···</span>
      </div>
      {!carousel ? null : (
        <div
          className={styles.igCounter}
        >{`${String(slideIndex)}/${String(slideCount)}`}</div>
      )}
      <div className={styles.igFooter}>
        <div className={styles.igActions}>
          <span className={styles.igHeart}>♥</span>
          <span className={styles.igBubble}>●</span>
          <span className={styles.igSend}>↗</span>
          {!carousel ? null : (
            <span className={styles.igDots}>
              {Array.from({ length: Math.min(slideCount, MAX_DOTS) }, (_dot, index) => (
                <i
                  key={index}
                  className={index + 1 === slideIndex ? (styles.igDotCurrent ?? "") : ""}
                />
              ))}
            </span>
          )}
          <span className={styles.igSave}>▯</span>
        </div>
        <div className={styles.igCaption}>
          <strong>yourname</strong> Your caption appears here <b>more</b>
        </div>
      </div>
    </>
  );
}
