import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type {
  LibraryItem,
  LibraryKind,
  LibrarySort,
  LibraryUse,
} from "@shared/schema/index.js";
import { ApiError, api, isUnauthorized } from "../../app/api.js";
import type { LibraryPatch } from "../../app/api.js";
import { LibraryCache, libraryCache, useLibrary } from "../../app/useLibrary.js";
import { useProjects } from "../../app/projects.js";
import { Button, useToast } from "../../design/index.js";
import { Header } from "../shell/Header.js";
import { browseLibrary } from "./browse.js";
import { LibraryCard } from "./LibraryCard.js";
import { LibraryDeleteDialog } from "./LibraryDeleteDialog.js";
import { LibraryForm } from "./LibraryForm.js";
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from "./useDebouncedValue.js";
import { uploadLibraryFile } from "./upload.js";
import styles from "./LibraryAdmin.module.css";

/*
 * The screen a person curates the library on. Ported from renderLibraryAdmin
 * (app.js:1296-1345) and bindLibraryAdmin (app.js:1395-1455).
 *
 * Both kinds share this page, as they did: the kind comes from the route, and
 * the two tabs are links rather than buttons, so a library tab is a place a
 * person can bookmark and go back to.
 */

/** Everything this page writes. The reads go through the cache's own client. */
export type LibraryAdminClient = Pick<
  typeof api,
  "createLibraryItem" | "updateLibraryItem" | "deleteLibraryItem"
>;

export type LibraryAdminProps = {
  kind: LibraryKind;
  /** The app's one cache by default. A test builds its own over a fake server. */
  cache?: LibraryCache;
  client?: LibraryAdminClient;
};

type Pending = { item: LibraryItem; usedBy: readonly LibraryUse[] };

/** Shared, so a list that is holding nothing in place is one identity. */
const NOTHING_HELD: ReadonlyMap<string, number> = new Map();

const COPY = {
  background: {
    title: "Backgrounds",
    plural: "backgrounds",
    intro: "Full-bleed photos an agent can use as the base of a slide.",
  },
  asset: {
    title: "Assets",
    plural: "assets",
    intro: "Logos, stickers and cut-outs an agent can place on a slide.",
  },
} as const satisfies Record<
  LibraryKind,
  { title: string; plural: string; intro: string }
>;

export function LibraryAdmin({
  kind,
  cache = libraryCache,
  client = api,
}: LibraryAdminProps) {
  const { items, error } = useLibrary(cache);
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [uploading, setUploading] = useState(false);
  /*
   * Where an edited card sits, which is not where its updatedAt says.
   *
   * Every sort keys on updatedAt and the server stamps it on every PATCH
   * (src/server/services/library.ts:236), so a saved card would jump to the top
   * of "Recently updated" and push the card the reader meant to edit next out
   * from under their cursor. A tester filling a library that way gave one card
   * another card's tags. app.js:1435-1445 saved the field and stopped: it never
   * re-rendered this list, so the order held. This is that, with the reason
   * written down and the hold released deliberately rather than never.
   *
   * Only edited cards are held. An upload, a delete and a fresh read all order
   * by the live value and land where they belong.
   */
  const [heldAt, setHeldAt] = useState<ReadonlyMap<string, number>>(NOTHING_HELD);
  const [pending, setPending] = useState<Pending | null>(null);
  const [deleting, setDeleting] = useState(false);
  const settled = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const copy = COPY[kind];
  const { create } = useProjects();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = `${copy.title} · Slide Studio`;
  }, [copy.title]);

  // app.js:1303 re-read the library every time this page was drawn. The cache
  // loads once for the whole app, so arriving here is what refreshes it.
  useEffect(() => {
    void cache.refresh();
  }, [cache]);

  const shown = useMemo(
    () =>
      browseLibrary(items.values(), { kind, query: settled, sort, orderedAt: heldAt }),
    [items, kind, settled, sort, heldAt],
  );

  const ofThisKind = useMemo(
    () => [...items.values()].some((item) => item.kind === kind),
    [items, kind],
  );

  /* app.js:1230 put this on every screen but the editor, this page included. */
  const startProject = useCallback(async () => {
    try {
      const project = await create();
      await navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch {
      toast("Couldn’t create the slideshow.", { tone: "danger" });
    }
  }, [create, navigate, toast]);

  const save = useCallback(
    async (item: LibraryItem, patch: LibraryPatch) => {
      const { item: saved } = await client.updateLibraryItem(item.id, patch);
      // Before the cache hears about it, so the card never renders at its new
      // updatedAt. The first hold wins, which is what keeps a card still while
      // every one of its fields is filled in rather than only for one of them.
      setHeldAt((current) =>
        current.has(item.id) ? current : new Map(current).set(item.id, item.updatedAt),
      );
      cache.remember(saved);
      return saved;
    },
    [cache, client],
  );

  /*
   * The two deliberate acts that settle the order. Both are the reader asking to
   * see the list arranged, which an edit is not. Opening the other tab is the
   * third and needs nothing: it is a different route and a fresh page.
   */
  const chooseSort = useCallback((next: LibrarySort) => {
    setSort(next);
    setHeldAt(NOTHING_HELD);
  }, []);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setHeldAt(NOTHING_HELD);
  }, []);

  const upload = useCallback(
    (files: File[]) => {
      const run = async () => {
        setUploading(true);
        let added = 0;
        for (const file of files) {
          try {
            // One at a time, as app.js:1418-1426 did. The server rewrites the
            // whole media directory listing per upload, so these do not race.
            cache.remember(await uploadLibraryFile(kind, file, client));
            added += 1;
          } catch (problem) {
            toast(
              problem instanceof Error
                ? problem.message
                : "That image couldn’t be uploaded.",
              {
                tone: "danger",
              },
            );
          }
        }
        setUploading(false);
        if (added > 0)
          toast(`${String(added)} ${added === 1 ? "image" : "images"} uploaded`);
      };
      void run();
    },
    [cache, client, kind, toast],
  );

  const remove = useCallback(
    (item: LibraryItem) => {
      const run = async () => {
        try {
          await client.deleteLibraryItem(item.id);
          cache.forget(item.id);
          toast(`${item.name} deleted`);
        } catch (problem) {
          // A 409 is not a failure. It is the server naming the slideshows this
          // would break, which is the one thing a person has to see first.
          if (problem instanceof ApiError && problem.status === 409) {
            setPending({ item, usedBy: problem.usedBy });
            return;
          }
          toast("That image couldn’t be deleted.", { tone: "danger" });
        }
      };
      void run();
    },
    [cache, client, toast],
  );

  const confirmRemove = useCallback(() => {
    if (pending === null) return;
    const { item } = pending;
    const run = async () => {
      setDeleting(true);
      try {
        await client.deleteLibraryItem(item.id, { force: true });
        cache.forget(item.id);
        toast(`${item.name} deleted`);
      } catch {
        toast("That image couldn’t be deleted.", { tone: "danger" });
      } finally {
        setDeleting(false);
        setPending(null);
      }
    };
    void run();
  }, [cache, client, pending, toast]);

  return (
    <>
      <Header>
        <Button
          variant="solid"
          onClick={() => {
            void startProject();
          }}
        >
          New slideshow
        </Button>
      </Header>

      <main className={styles.admin}>
        <section className={styles.head}>
          <div>
            <p className={styles.eyebrow}>Image library</p>
            <h1 className={styles.title}>{copy.title}</h1>
            <p className={styles.intro}>{copy.intro}</p>
          </div>
          <nav className={styles.tabs} aria-label="Library">
            <LibraryTab to="/library/backgrounds" current={kind === "background"}>
              Backgrounds
            </LibraryTab>
            <LibraryTab to="/library/assets" current={kind === "asset"}>
              Assets
            </LibraryTab>
          </nav>
        </section>

        <LibraryForm
          kind={kind}
          query={query}
          onQueryChange={changeQuery}
          sort={sort}
          onSortChange={chooseSort}
          uploading={uploading}
          onUpload={upload}
        />

        <p className={styles.hint}>
          An agent reads <strong>description</strong> and <strong>usage</strong> to choose
          images. Vague entries produce vague slideshows.
        </p>

        {error === null ? null : (
          <div className={styles.problem} role="alert">
            <p className={styles.problemText}>
              {isUnauthorized(error)
                ? "This browser is not signed in."
                : "Can’t reach the Slide Studio server. Start it with npm start."}
            </p>
            {/*
             * Nothing else re-reads the library once this page has mounted, so
             * without this the alert outlives the outage and goes on saying the
             * server is down after it has come back.
             */}
            <Button
              onClick={() => {
                void cache.refresh();
              }}
            >
              Try again
            </Button>
          </div>
        )}

        <div className={styles.grid}>
          {shown.map((item) => (
            <LibraryCard key={item.id} item={item} onSave={save} onDelete={remove} />
          ))}
        </div>

        {shown.length > 0 ? null : (
          <p className={styles.empty}>
            {ofThisKind
              ? "Nothing matches that search."
              : `No ${copy.plural} yet. Upload a few to get started.`}
          </p>
        )}
      </main>

      <LibraryDeleteDialog
        item={pending?.item ?? null}
        usedBy={pending?.usedBy ?? []}
        busy={deleting}
        onConfirm={confirmRemove}
        onCancel={() => {
          setPending(null);
        }}
      />
    </>
  );
}

type LibraryTabProps = {
  to: string;
  current: boolean;
  children: string;
};

/** A tab that is a link, so it carries a URL, a middle click and a back button. */
function LibraryTab({ to, current, children }: LibraryTabProps) {
  return (
    <Link
      className={styles.tab}
      to={to}
      data-current={current ? "" : undefined}
      aria-current={current ? "page" : undefined}
    >
      {children}
    </Link>
  );
}
