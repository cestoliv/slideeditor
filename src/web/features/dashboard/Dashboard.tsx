import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectSummary } from "@shared/schema/index.js";
import {
  Button,
  Dialog,
  Field,
  Icon,
  Select,
  Switch,
  useToast,
} from "../../design/index.js";
import type { SelectOption } from "../../design/index.js";
import { isUnauthorized } from "../../app/api.js";
import { useAccounts } from "../../app/accounts.js";
import { useProjects } from "../../app/projects.js";
import { Header } from "../shell/Header.js";
import { DashboardCard } from "./DashboardCard.js";
import { NewSlideshowDialog } from "./NewSlideshowDialog.js";
import styles from "./Dashboard.module.css";

/*
 * The home screen. Ported from renderDashboard (app.js:1238-1295) and
 * bindDashboardEvents (app.js:2130-2141). The delete confirmation
 * (app.js:971-1027) becomes a Dialog, so Escape, the focus trap and the return
 * of focus to the card are Radix's rather than absent.
 */

export function Dashboard() {
  const {
    projects,
    loading,
    error,
    streamDown,
    showPublished,
    setShowPublished,
    accountFilter,
    setAccountFilter,
    create,
    remove,
  } = useProjects();
  const { accounts } = useAccounts();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [pending, setPending] = useState<ProjectSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [creatingSlideshow, setCreatingSlideshow] = useState(false);

  const accountOptions: SelectOption[] = [
    { value: "all", label: "All accounts" },
    ...accounts.map((account) => ({ value: account.id, label: account.name })),
  ];

  useEffect(() => {
    document.title = "Slide Studio";
  }, []);

  /*
   * An account the filter is narrowed to can vanish out from under it — the
   * reader deletes it in another tab, or an agent does. Left alone, the
   * Select's value would match nothing in accountOptions and Radix would fall
   * back to its own placeholder rather than "All accounts", so the control
   * would lie about its state even though the dropdown still offers a way
   * back. This is the store's own accountFilter, which drives every refresh,
   * not just what the trigger displays, so it has to be corrected at the
   * source rather than papered over in the render.
   */
  useEffect(() => {
    if (
      accountFilter !== undefined &&
      !accounts.some((account) => account.id === accountFilter)
    ) {
      setAccountFilter(undefined);
    }
  }, [accountFilter, accounts, setAccountFilter]);

  // The server already orders by updated_at, but the list also arrives from a
  // stream refresh, so the screen sorts rather than trusting arrival order.
  const ordered = useMemo(
    () => [...projects].sort((first, second) => second.updatedAt - first.updatedAt),
    [projects],
  );

  const openProject = useCallback(
    (project: ProjectSummary) => {
      void navigate(`/projects/${encodeURIComponent(project.id)}`);
    },
    [navigate],
  );

  // Reports whether a project actually got created, rather than swallowing
  // that into a bare toast: NewSlideshowDialog's own onCreate contract needs
  // it, so it does not remember an account whose create failed as the one
  // the reader used (see there).
  const startProject = useCallback(
    async (accountId: string): Promise<boolean> => {
      try {
        const project = await create(accountId);
        await navigate(`/projects/${encodeURIComponent(project.id)}`);
        return true;
      } catch {
        toast("Couldn’t create the slideshow.", { tone: "danger" });
        return false;
      }
    },
    [create, navigate, toast],
  );

  const confirmRemove = useCallback(async () => {
    if (pending === null) return;
    setRemoving(true);
    try {
      await remove(pending.id);
      setPending(null);
      toast("Slideshow removed");
    } catch {
      toast("Couldn’t remove this slideshow.", { tone: "danger" });
    } finally {
      setRemoving(false);
    }
  }, [pending, remove, toast]);

  return (
    <>
      <Header>
        <Button asChild variant="ghost">
          <Link to="/library/backgrounds">
            <Icon name="image" />
            <span>Library</span>
          </Link>
        </Button>
        <Button
          variant="solid"
          onClick={() => {
            setCreatingSlideshow(true);
          }}
        >
          New slideshow
        </Button>
      </Header>

      <main className={styles.dashboard}>
        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Made for your camera roll</p>
            <h1 className={styles.headline}>
              Turn photos into
              <br />
              <em>scroll-stoppers.</em>
            </h1>
          </div>
          <p className={styles.intro}>
            Upload your photos, place TikTok-style text, and export crisp slideshow
            images. Nothing else in the way.
          </p>
        </section>

        <section>
          <div className={styles.sectionHeading}>
            <h2 className={styles.sectionTitle}>Your slideshows</h2>
            <div className={styles.sectionActions}>
              <Field className={styles.toggle ?? ""} label="Account">
                <Select
                  items={accountOptions}
                  value={accountFilter ?? "all"}
                  onValueChange={(value) => {
                    setAccountFilter(value === "all" ? undefined : value);
                  }}
                />
              </Field>
              <Field className={styles.toggle ?? ""} label="Show published">
                <Switch checked={showPublished} onCheckedChange={setShowPublished} />
              </Field>
              <span className={styles.count}>{countLabel(ordered.length)}</span>
            </div>
          </div>

          {error === null ? null : (
            <p className={styles.problem} role="alert">
              {isUnauthorized(error)
                ? "This browser is not signed in."
                : "Can’t reach the Slide Studio server. Start it with npm start."}
            </p>
          )}
          {streamDown ? (
            <p className={styles.notice} role="status">
              Live updates stopped. Reload the page to see what an agent changes.
            </p>
          ) : null}
          {error === null && !loading && ordered.length === 0 ? (
            <p className={styles.empty}>
              No slideshows yet. Start one and add photos when you’re ready.
            </p>
          ) : null}

          <div className={styles.grid}>
            <button
              type="button"
              className={styles.startCard}
              onClick={() => {
                setCreatingSlideshow(true);
              }}
            >
              <span className={styles.startMark} aria-hidden="true">
                +
              </span>
              <span>
                <strong>Start a slideshow</strong>
                <small>Add photos when you’re ready</small>
              </span>
            </button>
            {ordered.map((project) => (
              <DashboardCard
                key={project.id}
                project={project}
                onOpen={openProject}
                onRemove={setPending}
              />
            ))}
          </div>
        </section>
      </main>

      <NewSlideshowDialog
        open={creatingSlideshow}
        accounts={accounts}
        onOpenChange={setCreatingSlideshow}
        onCreate={async (accountId) => {
          setCreatingSlideshow(false);
          return startProject(accountId);
        }}
      />

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <Dialog.Content compact role="alertdialog">
          <Dialog.Title>Remove slideshow?</Dialog.Title>
          <Dialog.Description>
            <strong>{pending?.name}</strong> and all of its slides will be permanently
            deleted. This can’t be undone.
          </Dialog.Description>
          <Dialog.Actions>
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="danger"
              busy={removing}
              onClick={() => {
                void confirmRemove();
              }}
            >
              Remove slideshow
            </Button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

function countLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "slideshow" : "slideshows"}`;
}
