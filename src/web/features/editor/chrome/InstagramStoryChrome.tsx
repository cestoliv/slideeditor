import styles from "./chrome.module.css";

/* Ported verbatim from renderInstagramStoryChrome (app.js:1802-1817). */

export function InstagramStoryChrome() {
  return (
    <>
      <div className={styles.igStoryProgress}>
        <i className={styles.igStoryDone} />
        <i className={styles.igStoryCurrent} />
        <i />
        <i />
      </div>
      <div className={styles.igStoryHeader}>
        <span className={styles.igAvatar} />
        <span className={styles.igHandle}>
          <strong>yourname</strong>
          <small>2h</small>
        </span>
        <span className={styles.igMore}>···</span>
        <span className={styles.igClose}>✕</span>
      </div>
      <div className={styles.igStoryReply}>
        <span className={styles.igStoryField}>Send message</span>
        <span className={styles.igHeart}>♥</span>
        <span className={styles.igSend}>↗</span>
      </div>
    </>
  );
}
