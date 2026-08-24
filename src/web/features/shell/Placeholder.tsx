import { useEffect } from "react";
import { Header } from "./Header.js";
import styles from "./NotFound.module.css";

/*
 * A screen that has a route but not yet an implementation. The library admin is
 * Task 12's and the editor is Task 14's, so the shell mounts them here and this
 * stands in until they land. Delete it once neither route needs it.
 */

export type PlaceholderProps = {
  title: string;
  detail: string;
};

export function Placeholder({ title, detail }: PlaceholderProps) {
  useEffect(() => {
    document.title = `${title} · Slide Studio`;
  }, [title]);

  return (
    <>
      <Header />
      <main className={styles.notFound}>
        <h1 className={styles.headline}>{title}</h1>
        <p className={styles.lede}>{detail}</p>
      </main>
    </>
  );
}
