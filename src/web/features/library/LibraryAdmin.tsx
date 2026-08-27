import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type {
  LibraryItem,
  LibraryKind,
  LibrarySort,
  LibraryUse,
} from "@shared/schema/index.js";
import { ApiError, api, isUnauthorized } from "../../app/api.js";
import type { LibraryPatch } from "../../app/api.js";
import { useAccounts } from "../../app/accounts.js";
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
  const [selectedAccount, setAccount] = useState<string | undefined>(undefined);
  const { accounts, loading: accountsLoading, error: accountsError } = useAccounts();
  /*
   * An account the filter is narrowed to can vanish out from under it — the
   * reader deletes it in another tab, or an agent does. Left alone, the
   * Select's value would match nothing in accountOptions and Radix would
   * fall back to its own placeholder rather than "All accounts", while
   * `scoped` below kept deriving from the stale id: the grid would stay on
   * the dead account's last-fetched cards forever (no fetch effect ever
   * reruns for an id no longer in `accounts`), uploads and "New slideshow"
   * would stay scoped to an account the reader cannot see is gone, and this
   * screen would report "No backgrounds yet" for it rather than falling
   * back to "All accounts".
   *
   * Derived here rather than reset from an effect (Dashboard.tsx's own
   * account filter uses an effect for the same guard, but its setter comes
   * from useProjects(), not a local useState — this one does, which is
   * exactly the shape react-hooks/set-state-in-effect exists to flag: a
   * value computable during render has no business being corrected a
   * render later instead). `selectedAccount` still holds whatever the
   * reader last explicitly chose — including a since-deleted id — so a
   * recreated account with the same id (impossible today, but nothing here
   * assumes otherwise) would resume the filter rather than requiring a
   * fresh pick.
   */
  const account =
    selectedAccount !== undefined &&
    accounts.some((entry) => entry.id === selectedAccount)
      ? selectedAccount
      : undefined;
  /*
   * The account-scoped view, read through the same LibraryCache the editor
   * already scopes to one account — see LibraryCache's own class doc
   * comment. This used to run its own hand-rolled `cache.client.listLibrary`
   * fetch into local component state, re-implementing (without) the
   * request de-duplication and stale-answer guards `load`/`refresh`
   * already have: every account switch, every backgrounds↔assets switch and
   * every "Try again" was a fresh 200-item, stats-joined query, discarded on
   * unmount, even when the editor (or an earlier visit here) had already
   * fetched this exact account's page.
   *
   * `ready: account !== undefined` is what keeps "All accounts" from firing
   * a scoped fetch at all — the unscoped `items`/`error` above already
   * cover that case, the same way `scoped` used to read `null` for it.
   */
  const { items: scopedItems, error: scopedError } = useLibrary(
    cache,
    account,
    account !== undefined,
  );
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

  /*
   * The account filter reads the same cache rather than filtering it apart
   * from a second request: that cache is the app-wide index the editor
   * resolves every background and overlay through, scoped per account (see
   * LibraryCache's own class doc comment), which is exactly the scope this
   * filter wants. "All accounts" falls back to the unscoped `items` above,
   * so `shown` below never reads `scopedItems` in that case.
   *
   * No `q` sent to the server here, deliberately, same as the unscoped path:
   * the server's `q` (LibraryService.list) is an FTS5 prefix match per word,
   * while browseLibrary's matchesQuery (below) is a substring match over the
   * whole haystack, and the two do not agree — a mid-word query like "eep"
   * substring-matches "Deep cut background" but is not a prefix of any of
   * its tokens. `cache.load`/`refresh` fetch unfiltered by kind too (an
   * account's whole library, not just this kind), so browseLibrary is what
   * narrows by both kind and query for this scope, same as it already does
   * for the unscoped one.
   */
  const shown = useMemo(
    () =>
      browseLibrary(account === undefined ? items.values() : scopedItems.values(), {
        kind,
        query: settled,
        sort,
        orderedAt: heldAt,
      }),
    [account, scopedItems, items, kind, settled, sort, heldAt],
  );

  /*
   * Reads whichever source `shown` itself reads — the unscoped cache with no
   * account chosen, the scoped one with one — rather than always the
   * unscoped cache. That used to make the empty-state message lie: an
   * account with none of this kind, viewed while some OTHER account (or
   * "All accounts") genuinely had some, still read `ofThisKind` true and
   * said "Nothing matches that search" for a filter that was never applied,
   * instead of "No backgrounds yet."
   */
  const ofThisKind = useMemo(
    () =>
      [...(account === undefined ? items.values() : scopedItems.values())].some(
        (item) => item.kind === kind,
      ),
    [account, scopedItems, items, kind],
  );

  /*
   * app.js:1230 put this on every screen but the editor, this page included.
   * A slideshow may only reference library items from its own account
   * (validateComposition, server side), so a slideshow started from here
   * belongs in whichever account the filter names.
   *
   * With no filter chosen and more than one account to pick from, guessing
   * used to fall back to accounts[0] — AccountService.list() orders by name,
   * so "Acme" and "Default" both existing silently landed a new slideshow in
   * Acme for a person who had been browsing Default's images the whole time,
   * with nothing on screen to say so and no way to add what they were
   * looking at. newSlideshowDisabled below blocks the button outright in
   * that case instead: the account filter is the only place this can come
   * from now, not a guess. With exactly one account there is nothing to
   * guess wrong, so that account is used without making a person pick it out
   * of a list of one.
   */
  const newSlideshowTarget =
    account ?? (accounts.length === 1 ? accounts[0]?.id : undefined);
  const newSlideshowDisabled = newSlideshowTarget === undefined;
  const newSlideshowReasonId = useId();
  /*
   * `accounts` reads `[]` for three different reasons — still loading, the
   * fetch failed, or the account list is genuinely empty — and only the
   * last of those means "Create an account first." `useAccounts()`'s own
   * `loading`/`error` are what tell them apart: this used to read
   * `accounts.length === 0` alone, so every user saw "Create an account
   * first." on first render (before the fetch had answered at all), and
   * permanently if the fetch failed — both false claims about an account
   * list nobody had actually seen empty.
   *
   * `accountsError` is checked only once `accounts.length === 0` is already
   * known, not before it: AccountsStore.refresh() runs after every account
   * and font mutation and deliberately keeps the previous accounts on a
   * failed refresh (accounts.tsx's catch spreads `...this.state` rather than
   * clearing `accounts`), so a refresh that fails after a successful initial
   * load still has a real, non-empty list to show. Checking the error first
   * used to override that: the button read "Couldn’t load accounts." with a
   * good list sitting right there on screen. A refresh failure only matters
   * here when it leaves nothing to choose from.
   */
  const newSlideshowReason = accountsLoading
    ? "Loading accounts…"
    : accounts.length === 0
      ? accountsError
        ? "Couldn’t load accounts."
        : "Create an account first."
      : "Choose an account before starting a slideshow.";

  const startProject = useCallback(async () => {
    if (newSlideshowTarget === undefined) return;
    try {
      const project = await create(newSlideshowTarget);
      await navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch {
      toast("Couldn’t create the slideshow.", { tone: "danger" });
    }
  }, [newSlideshowTarget, create, navigate, toast]);

  const save = useCallback(
    async (item: LibraryItem, patch: LibraryPatch) => {
      const { item: saved } = await client.updateLibraryItem(item.id, patch);
      // Before the cache hears about it, so the card never renders at its new
      // updatedAt. The first hold wins, which is what keeps a card still while
      // every one of its fields is filled in rather than only for one of them.
      setHeldAt((current) =>
        current.has(item.id) ? current : new Map(current).set(item.id, item.updatedAt),
      );
      // Folds into every scope that could hold it — the unscoped page and
      // the item's own account's scope (LibraryCache.remember's own doc
      // comment) — so the account-scoped view above stays live with no
      // parallel bookkeeping of its own.
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
      // An upload lands in exactly one account, and "All accounts" is not a
      // destination, so the trigger stays disabled until one is chosen
      // (LibraryForm) and this is the second guard against a stray call.
      if (account === undefined) return;
      const run = async () => {
        setUploading(true);
        let added = 0;
        for (const file of files) {
          try {
            // One at a time, as app.js:1418-1426 did. The server rewrites the
            // whole media directory listing per upload, so these do not race.
            const uploaded = await uploadLibraryFile(kind, file, account, client);
            cache.remember(uploaded);
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
    [account, cache, client, kind, toast],
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
          disabled={newSlideshowDisabled}
          title={newSlideshowDisabled ? newSlideshowReason : undefined}
          aria-describedby={newSlideshowDisabled ? newSlideshowReasonId : undefined}
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
            {newSlideshowDisabled ? (
              <p className={styles.hint} id={newSlideshowReasonId}>
                {newSlideshowReason}
              </p>
            ) : null}
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
          accounts={accounts}
          account={account}
          onAccountChange={setAccount}
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

        {account === undefined || scopedError === null ? null : (
          <div className={styles.problem} role="alert">
            <p className={styles.problemText}>
              {isUnauthorized(scopedError)
                ? "This browser is not signed in."
                : "Can’t reach the Slide Studio server. Start it with npm start."}
            </p>
            <Button
              onClick={() => {
                void cache.refresh(account);
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

        {/*
         * A scoped fetch that failed says so above instead: showing "No
         * backgrounds yet" underneath it would claim the account is empty
         * when the real story is that nothing could be asked.
         */}
        {shown.length > 0 || (account !== undefined && scopedError !== null) ? null : (
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
