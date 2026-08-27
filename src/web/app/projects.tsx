import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Project, ProjectSummary } from "@shared/schema/index.js";
import type { ServerEvent } from "@shared/schema/index.js";
import { api } from "./api.js";
import { subscribeToServerEvents } from "./events.js";
import type { StreamStatus } from "./events.js";

/*
 * The slideshow list, and the live stream that keeps it honest. An agent can
 * change a slideshow while the browser is looking at it, so the list is one
 * store above the router rather than state inside the dashboard.
 *
 * It is an external store rather than component state for the same reason the
 * library cache is: the stream writes to it from outside React, and a refresh
 * has to survive a navigation.
 */

/** The three frames that make the list stale (src/server/services/events.ts:6-9). */
const REFRESHING_EVENTS: ReadonlySet<ServerEvent["type"]> = new Set([
  "project.changed",
  "project.status",
  "project.removed",
]);

export type ProjectsClient = Pick<
  typeof api,
  "listProjects" | "createProject" | "deleteProject"
>;

export type Subscribe = (
  onEvent: (event: ServerEvent) => void,
  options?: { onStatus?: (status: StreamStatus) => void },
) => () => void;

export type ProjectsState = {
  projects: readonly ProjectSummary[];
  loading: boolean;
  error: unknown;
  /** Published work is finished, so it stays out of the way until asked for. */
  showPublished: boolean;
  /** `undefined` means every account. Lives beside showPublished: both narrow the list the same way. */
  accountFilter: string | undefined;
  /** The live stream has given up, so nothing on screen updates itself. */
  streamDown: boolean;
};

export class ProjectsStore {
  private state: ProjectsState = {
    projects: [],
    loading: true,
    error: null,
    showPublished: false,
    accountFilter: undefined,
    streamDown: false,
  };
  private readonly listeners = new Set<() => void>();
  /** Every read is numbered, so a slow answer cannot overwrite a newer one. */
  private latest = 0;

  constructor(private readonly client: ProjectsClient = api) {}

  /* Bound as fields, because useSyncExternalStore resubscribes on a new identity. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ProjectsState => this.state;

  setShowPublished = (next: boolean): void => {
    if (this.state.showPublished === next) return;
    this.publish({ ...this.state, showPublished: next });
    void this.refresh();
  };

  setAccountFilter = (next: string | undefined): void => {
    if (this.state.accountFilter === next) return;
    this.publish({ ...this.state, accountFilter: next });
    void this.refresh();
  };

  refresh = async (): Promise<void> => {
    const request = this.latest + 1;
    this.latest = request;
    try {
      const { projects } = await this.client.listProjects(
        this.state.showPublished ? "all" : undefined,
        this.state.accountFilter,
      );
      if (this.latest !== request) return;
      this.publish({ ...this.state, projects, loading: false, error: null });
    } catch (error) {
      if (this.latest !== request) return;
      // The last good list stays on screen. Refreshes fire on every stream
      // frame, so one dropped request during a server restart would otherwise
      // blank a populated dashboard. LibraryCache takes the same line.
      this.publish({ ...this.state, loading: false, error });
    }
  };

  setStreamStatus = (status: StreamStatus): void => {
    const down = status === "closed";
    if (this.state.streamDown === down) return;
    this.publish({ ...this.state, streamDown: down });
  };

  create = async (accountId: string): Promise<Project> => {
    // app.js:2121 named it and handed over an empty document of the (then
    // account-less) default ratio. A document is still not sent: leaving it
    // out is what lets the server seed the ratio from this account's own
    // default (ProjectService.create, src/server/services/projects.ts) rather
    // than DEFAULT_RATIO overriding it — the same bare-document path
    // POST /api/slideshows and MCP's create_slideshow already take.
    const { project } = await this.client.createProject({
      name: "New Project",
      accountId,
    });
    await this.refresh();
    return project;
  };

  remove = async (id: string): Promise<void> => {
    await this.client.deleteProject(id);
    await this.refresh();
  };

  private publish(next: ProjectsState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** One store for the app. A test builds its own rather than sharing this. */
export const projectsStore = new ProjectsStore();

const ProjectsContext = createContext<ProjectsStore | null>(null);

export type ProjectsProviderProps = {
  children: ReactNode;
  /* Both default to module bindings, whose identity is stable across renders. */
  store?: ProjectsStore;
  subscribe?: Subscribe;
};

export function ProjectsProvider({
  children,
  store = projectsStore,
  subscribe = subscribeToServerEvents,
}: ProjectsProviderProps) {
  useEffect(() => {
    void store.refresh();
  }, [store]);

  useEffect(
    () =>
      subscribe(
        (event) => {
          if (REFRESHING_EVENTS.has(event.type)) void store.refresh();
        },
        { onStatus: store.setStreamStatus },
      ),
    [store, subscribe],
  );

  return <ProjectsContext.Provider value={store}>{children}</ProjectsContext.Provider>;
}

export type ProjectsValue = ProjectsState & {
  setShowPublished: (next: boolean) => void;
  setAccountFilter: (next: string | undefined) => void;
  refresh: () => Promise<void>;
  create: (accountId: string) => Promise<Project>;
  remove: (id: string) => Promise<void>;
};

export function useProjects(): ProjectsValue {
  const store = useContext(ProjectsContext);
  if (store === null) {
    throw new Error("useProjects needs a <ProjectsProvider> above it.");
  }
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    ...state,
    setShowPublished: store.setShowPublished,
    setAccountFilter: store.setAccountFilter,
    refresh: store.refresh,
    create: store.create,
    remove: store.remove,
  };
}
