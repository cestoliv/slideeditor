import { useEffect } from "react";
import { Link } from "react-router";
import { Button } from "../../design/index.js";
import { Header } from "./Header.js";
import styles from "./NotFound.module.css";

/** Ported from the .not-found block at styles.css:325-350. */
export function NotFound() {
  useEffect(() => {
    document.title = "Not found · Slide Studio";
  }, []);

  return (
    <>
      <Header />
      <main className={styles.notFound}>
        <p className={styles.eyebrow}>404</p>
        <h1 className={styles.headline}>Nothing lives here.</h1>
        <p className={styles.lede}>
          The page you asked for is gone, or it never existed. Your slideshows are still
          where you left them.
        </p>
        <Button asChild variant="solid">
          <Link to="/">Back to slideshows</Link>
        </Button>
      </main>
    </>
  );
}
