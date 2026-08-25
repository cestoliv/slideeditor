import type { HTMLAttributes } from "react";
import styles from "./Badge.module.css";

/*
 * warning and success exist so a project status has a tone. The legacy
 * draft / ready / published trio maps to warning / success / neutral.
 */
export type BadgeTone = "neutral" | "accent" | "warning" | "success" | "danger";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

const toneClass: Record<BadgeTone, string> = {
  neutral: styles.neutral ?? "",
  accent: styles.accent ?? "",
  warning: styles.warning ?? "",
  success: styles.success ?? "",
  danger: styles.danger ?? "",
};

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  const classes = [styles.badge, toneClass[tone], className].filter(Boolean).join(" ");
  return <span className={classes} {...rest} />;
}
