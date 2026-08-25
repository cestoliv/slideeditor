import type { ReactNode, SVGProps } from "react";

/*
 * The line art from app.js:1166-1192. Stroke width varies per glyph, so each
 * entry carries its own rather than forcing one weight across the set.
 */
type IconSpec = {
  readonly shape: ReactNode;
  readonly strokeWidth: number;
  /* Glyphs made of straight rules read better with a mitre than a round join. */
  readonly roundJoin: boolean;
};

const icons = {
  back: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: <path d="m15 18-6-6 6-6" />,
  },
  download: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </>
    ),
  },
  trash: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <path d="m7 7 1 14h8l1-14" />
      </>
    ),
  },
  edit: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </>
    ),
  },
  rotate: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M21 12a9 9 0 1 1-2.6-6.3" />
        <path d="M21 4v6h-6" />
      </>
    ),
  },
  "align-left": {
    strokeWidth: 2,
    roundJoin: false,
    shape: <path d="M4 6h16M4 10h11M4 14h16M4 18h9" />,
  },
  "align-center": {
    strokeWidth: 2,
    roundJoin: false,
    shape: <path d="M4 6h16M6.5 10h11M4 14h16M7.5 18h9" />,
  },
  "align-right": {
    strokeWidth: 2,
    roundJoin: false,
    shape: <path d="M4 6h16M9 10h11M4 14h16M11 18h9" />,
  },
  front: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="m17 11-5-5-5 5" />
        <path d="m17 18-5-5-5 5" />
      </>
    ),
  },
  up: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: <path d="m18 15-6-6-6 6" />,
  },
  down: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: <path d="m6 9 6 6 6-6" />,
  },
  "send-back": {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="m7 13 5 5 5-5" />
        <path d="m7 6 5 5 5-5" />
      </>
    ),
  },
  crop: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M6 2v14a2 2 0 0 0 2 2h14" />
        <path d="M18 22V8a2 2 0 0 0-2-2H2" />
      </>
    ),
  },
  text: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M5 5h14" />
        <path d="M12 5v14" />
        <path d="M8 19h8" />
      </>
    ),
  },
  image: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9" r="1.5" />
        <path d="m4 17 4.5-4 3.5 3 3-2.5 5 4.5" />
      </>
    ),
  },
  adjust: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <path d="M4 7h7" />
        <path d="M15 7h5" />
        <circle cx="13" cy="7" r="2" />
        <path d="M4 17h4" />
        <path d="M12 17h8" />
        <circle cx="10" cy="17" r="2" />
      </>
    ),
  },
  preview: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <rect x="7" y="2.5" width="10" height="19" rx="2" />
        <path d="M10 6h4" />
        <path d="M10 17.5h4" />
      </>
    ),
  },
  plus: {
    strokeWidth: 2,
    roundJoin: false,
    shape: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
  },
  check: {
    strokeWidth: 2.2,
    roundJoin: true,
    shape: <path d="m5 12.5 4.5 4.5L19 7" />,
  },
  archive: {
    strokeWidth: 1.8,
    roundJoin: true,
    shape: (
      <>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
        <path d="M10 12h4" />
      </>
    ),
  },
} satisfies Record<string, IconSpec>;

export type IconName = keyof typeof icons;

export const iconNames = Object.keys(icons) as readonly IconName[];

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  /*
   * Pixels, and the one place in the design system where a caller puts a length
   * on screen without touching the scale. Omit it to take --icon-size, which is
   * what every control expects.
   */
  size?: number;
  /* Supplying a title makes the glyph a labelled image instead of decoration. */
  title?: string;
};

export function Icon({ name, size, title, style, ...rest }: IconProps) {
  const spec = icons[name];
  const box = size === undefined ? "var(--icon-size)" : `${size}px`;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={spec.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin={spec.roundJoin ? "round" : "miter"}
      // The caller's style merges over the box rather than replacing it, so a
      // passing style prop cannot silently drop the width and height.
      style={{ width: box, height: box, flex: "0 0 auto", ...style }}
      role={title === undefined ? undefined : "img"}
      aria-hidden={title === undefined ? true : undefined}
      {...rest}
    >
      {title === undefined ? null : <title>{title}</title>}
      {spec.shape}
    </svg>
  );
}
