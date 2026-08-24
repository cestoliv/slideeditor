import type { ReactNode } from "react";
import { Link } from "react-router";
import styles from "./Header.module.css";

/*
 * The bar every screen wears. Ported from renderHeader (app.js:1193-1237),
 * split so the dashboard and the editor pass their own actions rather than the
 * header branching on a flag it cannot see the consequences of.
 */

/** package.json's repository. app.js:1231 still pointed at the upstream fork. */
const REPOSITORY_URL = "https://github.com/cestoliv/slideeditor";

export type HeaderProps = {
  /** The editor bar carries a title, so it lays out as three columns. */
  editor?: boolean;
  /** The middle column. The editor puts the slideshow's name here. */
  center?: ReactNode;
  /** The trailing actions, which differ on every screen. */
  children?: ReactNode;
};

export function Header({ editor = false, center, children }: HeaderProps) {
  const classes = [styles.header, editor ? styles.editor : ""].filter(Boolean).join(" ");

  return (
    <header className={classes}>
      <Link className={styles.brand} to="/" aria-label="Go to slideshows">
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.copy}>
          <strong>Slide Studio</strong>
          <small>TikTok image maker</small>
        </span>
      </Link>
      {center === undefined ? null : <div className={styles.center}>{center}</div>}
      <div className={styles.actions}>
        {children}
        <a
          className={styles.github}
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open Slide Studio on GitHub"
          title="Open GitHub repository"
        >
          <span className={styles.githubMark} aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}
