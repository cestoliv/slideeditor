import type { ProjectSummary, SlideshowStatus } from "@shared/schema/index.js";
import { Badge, Card, DropdownMenu, IconButton } from "../../design/index.js";
import type { BadgeTone } from "../../design/index.js";
import styles from "./Dashboard.module.css";

/*
 * One slideshow on the home screen. Ported from the card renderDashboard built
 * inline (app.js:1274-1290) plus showProjectMenu (app.js:758-790), whose
 * hand-rolled right-click menu becomes a DropdownMenu on a real trigger: the
 * old one could not be reached from a keyboard at all.
 */

const STATUS_LABEL: Record<SlideshowStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  published: "Published",
};

/* Badge.tsx names this mapping itself: draft / ready / published. */
const STATUS_TONE: Record<SlideshowStatus, BadgeTone> = {
  draft: "warning",
  ready: "success",
  published: "neutral",
};

/** app.js:1157-1165. Today reads as a clock, anything older as a date. */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function slideCountLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "slide" : "slides"}`;
}

export type DashboardCardProps = {
  project: ProjectSummary;
  onOpen: (project: ProjectSummary) => void;
  onRemove: (project: ProjectSummary) => void;
};

export function DashboardCard({ project, onOpen, onRemove }: DashboardCardProps) {
  return (
    <Card className={styles.card} padding="none" interactive>
      <button
        type="button"
        className={styles.open}
        aria-label={`Open ${project.name}`}
        onClick={() => {
          onOpen(project);
        }}
      >
        <span className={styles.preview}>
          {project.coverUrl === null ? (
            <span className={styles.previewEmpty}>No photos yet</span>
          ) : (
            <img src={project.coverUrl} alt={`${project.name} cover`} />
          )}
        </span>
        <span className={styles.meta}>
          <span className={styles.title}>
            <strong className={styles.name}>{project.name}</strong>
            <Badge tone={STATUS_TONE[project.status]}>
              {STATUS_LABEL[project.status]}
            </Badge>
          </span>
          <span className={styles.detail}>
            {slideCountLabel(project.slideCount)} · {formatDate(project.updatedAt)}
          </span>
        </span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton
            className={styles.menu}
            icon="down"
            size="sm"
            label={`Actions for ${project.name}`}
          />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content compact align="end">
          <DropdownMenu.Item
            danger
            icon="trash"
            onSelect={() => {
              onRemove(project);
            }}
          >
            Remove
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Card>
  );
}
