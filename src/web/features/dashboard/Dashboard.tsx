import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectSummary } from "@shared/schema/index.js";
import { Button, Dialog, Field, Icon, Switch, useToast } from "../../design/index.js";
import { isUnauthorized } from "../../app/api.js";
import { useProjects } from "../../app/projects.js";
import { Header } from "../shell/Header.js";
import { DashboardCard } from "./DashboardCard.js";
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
    create,
    remove,
  } = useProjects();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [pending, setPending] = useState<ProjectSummary | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    document.title = "Slide Studio";
  }, []);

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

  const startProject = useCallback(async () => {
    try {
      const project = await create();
      await navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch {
      toast("Couldn’t create the slideshow.", { tone: "danger" });
    }
  }, [create, navigate, toast]);

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
            void startProject();
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
                void startProject();
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
