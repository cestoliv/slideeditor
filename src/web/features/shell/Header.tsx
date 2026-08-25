import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../app/api.js";
import { useSession } from "../../app/session.js";
import { Button } from "../../design/index.js";
import styles from "./Header.module.css";

/*
 * The bar every screen wears. Ported from renderHeader (app.js:1193-1237),
 * split so the dashboard and the editor pass their own actions rather than the
 * header branching on a flag it cannot see the consequences of.
 */

/** package.json's repository. app.js:1231 still pointed at the upstream fork. */
const REPOSITORY_URL = "https://github.com/cestoliv/slideeditor";

/**
 * Reloads rather than calling the session hook's refresh: a stray in-memory
 * store (ProjectsProvider's cache, an open editor's undo stack) belongs to
 * the session that just ended, and a reload is the one way to be sure none of
 * it survives into the next one.
 */
function signOut(): void {
  void api.logout().finally(() => window.location.reload());
}

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
  // Token authentication has nothing to gate in "open" mode, so a link to
  // manage tokens (and a control to sign out of a session that mode never
  // asks for) would offer actions that do nothing.
  const { state } = useSession();
  const showAccount = state.status === "ready" && state.session.mode === "required";

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
        {showAccount ? (
          <>
            <Button asChild variant="ghost">
              <Link to="/settings">Settings</Link>
            </Button>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </>
        ) : null}
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
