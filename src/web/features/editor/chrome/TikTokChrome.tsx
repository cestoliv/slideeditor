import styles from "./chrome.module.css";

/* Ported verbatim from renderTikTokChrome (app.js:1752-1771). */

export function TikTokChrome() {
  return (
    <>
      <div className={styles.ttTopbar}>
        <span>Following</span>
        <strong>For You</strong>
        <span className={styles.ttSearch}>⌕</span>
      </div>
      <div className={styles.ttSideActions}>
        <div className={styles.ttAvatar}>
          <span />
          <b>+</b>
        </div>
        <div className={styles.ttAction}>
          <span className={styles.ttHeart}>♥</span>
          <small>128K</small>
        </div>
        <div className={styles.ttAction}>
          <span className={styles.ttBubble}>●</span>
          <small>842</small>
        </div>
        <div className={styles.ttAction}>
          <span className={styles.ttBookmark}>▮</span>
          <small>12K</small>
        </div>
        <div className={styles.ttAction}>
          <span className={styles.ttShare}>↗</span>
          <small>Share</small>
        </div>
        <div className={styles.ttDisc}>♪</div>
      </div>
      <div className={styles.ttCaption}>
        <strong>@yourname</strong>
        <p>
          Your caption appears here <b>more</b>
        </p>
        <span>♫ Original sound · yourname</span>
      </div>
      <div className={styles.ttBottomNav}>
        <span>
          <b>⌂</b>Home
        </span>
        <span>
          <b>♙</b>Friends
        </span>
        <span className={styles.ttCreate}>+</span>
        <span>
          <b>▣</b>Inbox
        </span>
        <span>
          <b>◉</b>Profile
        </span>
      </div>
    </>
  );
}
