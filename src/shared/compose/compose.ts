import {
  DESIGN_WIDTH,
  ensureBoxedTextContrast,
  getImageLayout,
  outputHeight,
  overlaps,
} from "../geometry/index.js";
import {
  DEFAULT_RATIO,
  RATIO_ASPECT_MAX,
  RATIO_ASPECT_MIN,
  slideLayoutSchema,
  styledTextSchema,
} from "../schema/index.js";
import { newTextLayer } from "../defaults/index.js";
import {
  TEXT_WRAP_INSET,
  advanceRatioFor,
  pillOverhang,
  textContentHeight,
  wrapText,
} from "../text/index.js";
import type { MeasureFont, MeasureText, TextFont } from "../text/index.js";
import type { ImageSlide } from "../geometry/index.js";
import type {
  AccountDefaults,
  LayoutHints,
  LibraryItem,
  LibraryKind,
  Overlay,
  Ratio,
  Slide,
  SlideDocument,
  SlideLayout,
  TextLayer,
} from "../schema/index.js";
import type { Box } from "../geometry/index.js";
import {
  ASSET_GAP,
  ASSET_LEFT,
  ASSET_MAX_WIDTH,
  ASSET_ROW_MAX,
  ASSET_SIZE_WIDTHS,
  ASSET_TEXT_GAP,
  ASSET_TOP,
  ASSET_TOP_MARGIN,
  SAFE_BOTTOM,
  SAFE_RIGHT,
  SAFE_TOP,
  SIDE_MARGIN,
  TEXT_BOTTOM_MARGIN,
  TEXT_CENTER_FIRST,
  TEXT_CENTER_LAST,
  TEXT_CENTER_MIDDLE,
  TEXT_GAP,
  TEXT_LEFT,
  TEXT_TOP_LIMIT,
} from "./constants.js";

/**
 * Stands in for HttpError(400, …) (server/compose.mjs:2). The current server
 * answers a bad composition with a 400, and that status is part of the API
 * contract, so the error carries no status of its own and Task 8's handler
 * maps this class to 400.
 */
export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/** The slice of the library service compose needs (server/library.mjs:99-106). */
export interface LibraryLookup {
  require(id: string, kind?: LibraryKind): LibraryItem;
}

/**
 * The style an agent may set on one line of text. Position and box size stay
 * the server's to place, so nothing here moves a line.
 */
export type TextStyle = Partial<
  Pick<
    TextLayer,
    "size" | "style" | "color" | "background" | "weight" | "italic" | "align"
  >
>;

const TEXT_STYLE_KEYS = [
  "size",
  "style",
  "color",
  "background",
  "weight",
  "italic",
  "align",
] as const satisfies readonly (keyof TextStyle)[];

/** A line of text: a plain string takes the account's defaults. */
export type CompositionText = string | ({ text: string } & TextStyle);

/** The shorthand an agent speaks: a background id, asset ids, and texts. */
export interface Composition {
  name?: string;
  background: string;
  assets?: string[];
  texts?: CompositionText[];
  layout?: SlideLayout;
}

interface StyledText {
  text: string;
  style: TextStyle;
}

export interface ComposeDocumentInput {
  ratio: Ratio | undefined;
  slides: Composition[];
  library: LibraryLookup;
  defaults: AccountDefaults;
  previous?: SlideDocument | null | undefined;
  newId?: (() => string) | undefined;
  /**
   * Measures a line the way the editor and the export draw it. This module
   * reads no font file, so the server passes FontService.measureText, which
   * reads the face itself. Without one, a line is estimated from the shared
   * average glyph advance.
   */
  measureText?: MeasureFont | undefined;
  /**
   * Collects one sentence per slide whose anchors could not all be honoured,
   * for the caller to hand back to the agent.
   */
  notes?: string[] | undefined;
}

/** A project row joined to its document, the shape toComposition reduces. */
export type CompositionSource = SlideDocument & {
  id: string;
  name: string;
  version: number;
};

export interface CompositionSlide {
  name: string;
  background: string | null;
  assets: string[];
  texts: string[];
  layout?: SlideLayout;
}

export interface CompositionProject {
  id: string;
  name: string;
  version: number;
  ratio: Ratio;
  slides: CompositionSlide[];
}

interface MeasuredText {
  text: string;
  style: TextStyle;
  size: number;
  height: number;
  /** How far its pills reach past its padding at each edge (pillOverhang). */
  overhang: number;
}

interface PlacedAsset {
  item: LibraryItem;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ComposeSlideInput {
  composition: Composition;
  index: number;
  slideCount: number;
  ratio: Ratio;
  library: LibraryLookup;
  defaults: AccountDefaults;
  previousSlide: Slide | null;
  ratioChanged: boolean;
  newId: () => string;
  measureText: MeasureFont;
  notes: string[];
}

/** A line's width from the shared average glyph advance, for a caller with no font to read. */
function estimateText(line: string, font: TextFont): number {
  return line.length * font.size * advanceRatioFor(font.family);
}

// Injected everywhere below so tests get deterministic ids, and so this module
// stays free of node:crypto. globalThis.crypto exists in Node 22 and in the
// browser alike.
function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Turns a composition (a background, asset ids and strings) into a full slide
 * document. Deterministic: the same input always yields the same geometry,
 * apart from generated ids.
 */
export function composeDocument({
  ratio,
  slides,
  library,
  defaults,
  previous = null,
  newId = defaultNewId,
  measureText = estimateText,
  notes = [],
}: ComposeDocumentInput): SlideDocument {
  const safeRatio = normalizeRatio(ratio);
  const previousSlides = previous?.slides || [];
  return {
    ratio: safeRatio,
    slides: slides.map((composition, index) =>
      composeSlide({
        composition,
        index,
        slideCount: slides.length,
        ratio: safeRatio,
        library,
        defaults,
        previousSlide: previousSlides[index] || null,
        ratioChanged: previous ? !sameRatio(previous.ratio, safeRatio) : false,
        newId,
        measureText,
        notes,
      }),
    ),
  };
}

function composeSlide({
  composition,
  index,
  slideCount,
  ratio,
  library,
  defaults,
  previousSlide,
  ratioChanged,
  newId,
  measureText,
  notes,
}: ComposeSlideInput): Slide {
  const background = library.require(composition.background, "background");
  const assetIds = normalizeList(composition.assets);
  const texts = normalizeList(composition.texts).map(toStyledText);
  const assets = assetIds.map((id) => library.require(id, "asset"));
  const layout = toLayout(composition.layout, index);
  // A new anchor asks for a new placement, so hand-made geometry gives way.
  const relayout = ratioChanged || !sameLayout(previousSlide?.layout, layout);

  // An unchanged composition keeps the slide exactly as the user left it.
  if (
    previousSlide &&
    !relayout &&
    sameComposition(previousSlide, background.id, assetIds, texts)
  ) {
    return previousSlide;
  }

  const height = outputHeight(ratio);
  const measured = measureTexts(texts, height, defaults, measureText);
  const total = measured.reduce(
    (sum, box, index) => sum + box.height + stackGap(box, measured[index + 1]),
    0,
  );
  const fitsSafeZone = total <= SAFE_BOTTOM - SAFE_TOP;
  const placement = fitsSafeZone
    ? placeInSafeZone(
        assets,
        height,
        total,
        measured.length > 0,
        index,
        slideCount,
        defaults,
        layout,
      )
    : placeOversized(assets, height, total, layout);
  if (placement.note) notes.push(`Slide ${String(index + 1)}: ${placement.note}`);
  const laidOutAssets = placement.assets;
  const imageScale = previousSlide?.imageScale ?? 1;
  const imageX = previousSlide?.imageX ?? 0;
  const imageY = previousSlide?.imageY ?? 0;
  // A text anchor the agent picked wins over the background's free zone.
  const band =
    fitsSafeZone && !layout?.text
      ? freeBand(laidOutAssets, placement.textTop, total)
      : undefined;
  const textTop = band
    ? hintedTextTop(placement.textTop, {
        total,
        target: roleCenter(index, slideCount),
        ...band,
        left: textLeft(defaults.text.maxWidth),
        width: defaults.text.maxWidth,
        hints: background.layoutHints,
        image: toSlideFractions(
          {
            width: background.width,
            height: background.height,
            imageScale,
            imageX,
            imageY,
          },
          height,
        ),
      })
    : placement.textTop;
  let cursor = textTop;
  const laidOutTexts = measured.map((box, index) => {
    const placed = { ...box, y: cursor };
    cursor += box.height + stackGap(box, measured[index + 1]);
    return placed;
  });

  const slide: Slide = {
    id: previousSlide?.id || newId(),
    name: composition.name
      ? String(composition.name).slice(0, 120)
      : `Slide ${index + 1}`,
    backgroundItemId: background.id,
    width: background.width,
    height: background.height,
    imageScale,
    imageX,
    imageY,
    overlays: [],
    texts: [],
    ...(layout ? { layout } : {}),
  };

  // Geometry the user adjusted by hand survives wherever the same asset or the
  // same string is still on the slide.
  const keptOverlays = new Map<string, Overlay[]>();
  for (const overlay of previousSlide?.overlays || []) {
    if (relayout) break;
    const bucket = keptOverlays.get(overlay.itemId) || [];
    bucket.push(overlay);
    keptOverlays.set(overlay.itemId, bucket);
  }
  const keptTexts = new Map<string, TextLayer[]>();
  for (const text of previousSlide?.texts || []) {
    if (relayout) break;
    const bucket = keptTexts.get(text.text) || [];
    bucket.push(text);
    keptTexts.set(text.text, bucket);
  }

  let z = 1;
  slide.overlays = laidOutAssets.map((placed) => {
    const reused = keptOverlays.get(placed.item.id)?.shift();
    return reused
      ? { ...reused, z: z++ }
      : {
          id: newId(),
          itemId: placed.item.id,
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
          rotation: 0,
          cropX: 0,
          cropY: 0,
          cropW: 1,
          cropH: 1,
          z: z++,
        };
  });
  slide.texts = laidOutTexts.map((placed) => {
    // A kept line has to wear the style asked for, or a restyle would be lost.
    const bucket = keptTexts.get(placed.text) || [];
    const index = bucket.findIndex((layer) => hasStyle(layer, placed.style));
    const reused = index === -1 ? undefined : bucket.splice(index, 1)[0];
    if (reused) return { ...reused, z: z++ };
    const layer: TextLayer = {
      ...newTextLayer(
        defaults,
        { x: textLeft(defaults.text.maxWidth), y: placed.y, z: z++ },
        newId,
      ),
      text: placed.text,
      height: placed.height,
    };
    // Only a styled line can land a box colour on its own text colour, so a
    // plain string keeps exactly the layer it always got.
    return Object.keys(placed.style).length
      ? ensureBoxedTextContrast({ ...layer, ...placed.style })
      : layer;
  });
  return slide;
}

/**
 * The space from one stacked text box to the next, none after the last.
 * Each boxed box holds its own pills, so two of them overlap by both
 * overhangs and their pills overlap as before, rather than meeting edge to
 * edge, where the export shows the background through a hairline seam.
 */
function stackGap(box: MeasuredText, next: MeasuredText | undefined): number {
  return next ? TEXT_GAP - box.overhang - next.overhang : 0;
}

/** Measures each text box at its own size and style, in canvas fractions. */
function measureTexts(
  texts: StyledText[],
  height: number,
  defaults: AccountDefaults,
  measureText: MeasureFont,
): MeasuredText[] {
  return texts.map(({ text, style }) => {
    // Each line measures at its own size and style, because a hook set
    // larger than the rest wraps to more lines and needs a taller box, and
    // a heavier weight draws wider glyphs.
    const size = style.size ?? defaults.text.size;
    const font: TextFont = {
      family: defaults.text.fontFamily,
      size,
      weight: style.weight ?? defaults.text.weight,
      italic: style.italic ?? defaults.text.italic,
    };
    // computeTextLayout draws per-line pills off the same two fields, and the
    // pills reach past the plain padding, so reading them here keeps this
    // height from drifting away from what the renderer lays out.
    const perLineBox =
      (style.style ?? defaults.text.style) === "boxed" &&
      defaults.text.backgroundShape !== "full";
    return {
      text,
      style,
      size,
      height: textHeight(
        text,
        size,
        height,
        (line) => measureText(line, font),
        defaults.text.maxWidth,
        perLineBox,
      ),
      overhang: pillOverhang(size, perLineBox) / height,
    };
  });
}

interface Placement {
  assets: PlacedAsset[];
  textTop: number;
  note?: string | undefined;
}

/**
 * Places a text block that fits the safe zone, and the assets beside it,
 * from the slide's role and whatever anchors the agent picked. The assets
 * leave room for the whole block, so the text always fits on one side of
 * them: when its own anchor would overlap them, it moves to the nearer side.
 */
function placeInSafeZone(
  assets: LibraryItem[],
  height: number,
  total: number,
  hasTexts: boolean,
  index: number,
  slideCount: number,
  defaults: AccountDefaults,
  layout: SlideLayout | undefined,
): Placement {
  const reserve = hasTexts ? total + ASSET_TEXT_GAP : 0;
  const size = layout?.assetSize ? ASSET_SIZE_WIDTHS[layout.assetSize] : undefined;
  // Sized and placed top left first, which is the default, then moved.
  let placed = layoutAssets(assets, height, SAFE_BOTTOM - reserve, size);
  const target = textTarget(layout?.text, total, index, slideCount);
  if (!placed.length) return { assets: placed, textTop: target };

  let group = boundsOf(placed);
  const anchor = layout?.assets ?? "top-left";
  if (anchor === "top-right") placed = shift(placed, SAFE_RIGHT - group.right, 0);
  // Several assets fill centred rows, so a left anchor asked for by name
  // pulls them to the gutter. A lone asset already sits at ASSET_LEFT.
  if (layout?.assets?.endsWith("-left") && placed.length > 1) {
    placed = shift(placed, SIDE_MARGIN - group.x, 0);
  }
  if (anchor === "bottom-left") placed = shift(placed, 0, SAFE_BOTTOM - group.bottom);
  if (anchor === "center") {
    placed = shift(
      placed,
      (SIDE_MARGIN + SAFE_RIGHT - group.x - group.right) / 2,
      (SAFE_TOP + SAFE_BOTTOM - group.y - group.bottom) / 2,
    );
  }
  group = boundsOf(placed);
  const maxWidth = defaults.text.maxWidth;
  const block: Box = {
    x: textLeft(maxWidth),
    y: target - ASSET_TEXT_GAP,
    width: maxWidth,
    height: total + 2 * ASSET_TEXT_GAP,
  };
  const groupBox: Box = {
    x: group.x,
    y: group.y,
    width: group.right - group.x,
    height: group.bottom - group.y,
  };
  // Without a layout, only height counts, as it always has, so a narrow text
  // column still starts below assets that sit beside it. A text anchor with
  // no asset anchor pulls the assets next to the text, as if they collided.
  const collides = layout
    ? (layout.text !== undefined && !layout.assets) || overlaps(block, groupBox)
    : block.y < groupBox.y + groupBox.height && groupBox.y < block.y + block.height;
  if (!hasTexts || !collides) return { assets: placed, textTop: target };

  // Without any anchor, top assets keep the text below them, as they always
  // have, and stay where they are. With one, the assets first move to
  // whichever side of the text keeps it on target, the side its target leans
  // to first. Only when neither side fits does the text sit next to them,
  // on that side. The height reserved for the text keeps both in the safe
  // zone, unless layoutAssets' floor outgrows it.
  let below =
    !layout?.text && anchor.startsWith("top-")
      ? true
      : target + total / 2 >= (group.y + group.bottom) / 2;
  // The move that puts the assets above the text, or below it, with the text on target.
  const clearAbove = target - ASSET_TEXT_GAP - group.bottom;
  const clearBelow = target + total + ASSET_TEXT_GAP - group.y;
  const fitsAbove = group.y + clearAbove >= SAFE_TOP;
  const fitsBelow = group.bottom + clearBelow <= SAFE_BOTTOM;
  let dy: number;
  let textTop: number;
  if (layout && (fitsAbove || fitsBelow)) {
    below = below ? fitsAbove : !fitsBelow;
    dy = below ? clearAbove : clearBelow;
    textTop = target;
  } else if (below) {
    // Without a layout the assets stay put, exactly as before anchors existed.
    dy = layout
      ? Math.max(
          Math.min(0, SAFE_BOTTOM - total - ASSET_TEXT_GAP - group.bottom),
          Math.min(0, SAFE_TOP - group.y),
        )
      : 0;
    textTop = group.bottom + dy + ASSET_TEXT_GAP;
  } else {
    dy = Math.min(
      Math.max(0, SAFE_TOP + total + ASSET_TEXT_GAP - group.y),
      Math.max(0, SAFE_BOTTOM - group.bottom),
    );
    textTop = group.y + dy - ASSET_TEXT_GAP - total;
  }
  placed = shift(placed, 0, dy);
  const epsilon = 1e-9;
  let note: string | undefined;
  if (
    layout &&
    (textTop < SAFE_TOP - epsilon || textTop + total > SAFE_BOTTOM + epsilon)
  ) {
    note =
      "the text and the assets do not both fit the safe zone, so the text leaves it.";
  } else if (layout && Math.abs(textTop - target) > epsilon) {
    const subject = layout.text ? `text "${layout.text}"` : "the text";
    note = `${subject} would overlap the assets, so it sits ${below ? "below" : "above"} them.`;
    if (layout.assets && Math.abs(dy) > epsilon) {
      note += ` The assets leave "${layout.assets}" to make room.`;
    }
  } else if (layout?.assets && Math.abs(dy) > epsilon) {
    note = `assets "${layout.assets}" would overlap the text, so they sit ${below ? "above" : "below"} it.`;
  }
  return { assets: placed, textTop, note };
}

/**
 * Places a text block taller than the safe zone the way it always was, with
 * the assets squeezed above it. No anchor can help such a block.
 */
function placeOversized(
  assets: LibraryItem[],
  height: number,
  total: number,
  layout: SlideLayout | undefined,
): Placement {
  const textTop = fallbackTextTop(total);
  const areaBottom = textTop >= 0 ? textTop - 0.04 : 1 - TEXT_BOTTOM_MARGIN;
  return {
    assets: layoutAssets(assets, height, areaBottom),
    textTop,
    note: layout
      ? "the text is too tall for the safe zone, so its anchors are ignored."
      : undefined,
  };
}

/** The top of a text block on its anchor, or on its role's target without one. */
function textTarget(
  anchor: SlideLayout["text"],
  total: number,
  index: number,
  slideCount: number,
): number {
  if (anchor === "top") return SAFE_TOP;
  if (anchor === "bottom") return SAFE_BOTTOM - total;
  if (anchor === "middle") return (SAFE_TOP + SAFE_BOTTOM - total) / 2;
  return clamp(roleCenter(index, slideCount) - total / 2, SAFE_TOP, SAFE_BOTTOM - total);
}

function boundsOf(placed: PlacedAsset[]) {
  return {
    x: Math.min(...placed.map((asset) => asset.x)),
    y: Math.min(...placed.map((asset) => asset.y)),
    right: Math.max(...placed.map((asset) => asset.x + asset.width)),
    bottom: Math.max(...placed.map((asset) => asset.y + asset.height)),
  };
}

// A zero move returns the same objects, so a default slide keeps its exact
// floating-point geometry.
function shift(placed: PlacedAsset[], dx: number, dy: number): PlacedAsset[] {
  if (!dx && !dy) return placed;
  return placed.map((asset) => ({ ...asset, x: asset.x + dx, y: asset.y + dy }));
}

/** Where a text block's centre goes: the hook sits high, the call to action low. */
function roleCenter(index: number, slideCount: number): number {
  if (index === 0) return TEXT_CENTER_FIRST;
  return index === slideCount - 1 ? TEXT_CENTER_LAST : TEXT_CENTER_MIDDLE;
}

interface HintedPlacement {
  total: number;
  target: number;
  minTop: number;
  maxBottom: number;
  left: number;
  width: number;
  hints: LayoutHints | undefined;
  image: ImageToSlide;
}

/** Maps a fraction of the background image to a fraction of the slide. */
interface ImageToSlide {
  x(value: number): number;
  y(value: number): number;
}

function toSlideFractions(slide: ImageSlide, height: number): ImageToSlide {
  const layout = getImageLayout(slide, DESIGN_WIDTH, height);
  return {
    x: (value) => (layout.left + value * layout.width) / DESIGN_WIDTH,
    y: (value) => (layout.top + value * layout.height) / height,
  };
}

/**
 * Moves a text block that fits the safe zone to where the background leaves
 * room for it. The free zone is a third of the image. The block goes to the
 * spot in it nearest the role target, and stays where it was when the zone is
 * too short. A subject the block would cover pushes it just above or just
 * below, whichever is closer, if either still fits. With no hint, `top` comes
 * back unchanged.
 */
function hintedTextTop(
  top: number,
  { total, target, minTop, maxBottom, left, width, hints, image }: HintedPlacement,
): number {
  const maxTop = maxBottom - total;
  let placed = top;
  let inZone = (_y: number) => false;
  if (hints?.freeZone) {
    const third = FREE_ZONE_THIRD[hints.freeZone];
    const zoneTop = Math.max(minTop, image.y(third / 3));
    const zoneBottom = Math.min(maxBottom, image.y((third + 1) / 3));
    if (zoneBottom - zoneTop >= total) {
      placed = clamp(target - total / 2, zoneTop, zoneBottom - total);
      inZone = (y) => y >= zoneTop - 1e-9 && y + total <= zoneBottom + 1e-9;
    }
  }
  const subject = hints?.subject;
  if (!subject) return placed;
  const subjectTop = image.y(subject.y);
  const subjectBottom = image.y(subject.y + subject.h);
  // The tolerance lets a block placed flush against the subject count as clear.
  const covers = (y: number) => y < subjectBottom - 1e-9 && y + total > subjectTop + 1e-9;
  const besideSubject =
    image.x(subject.x + subject.w) <= left || image.x(subject.x) >= left + width;
  if (besideSubject || !covers(placed)) return placed;
  // A spot that stays in the free zone beats a nearer one outside it.
  const clear = [subjectTop - total, subjectBottom]
    .filter((y) => y >= minTop && y <= maxTop && !covers(y))
    .sort(
      (a, b) =>
        Number(inZone(b)) - Number(inZone(a)) ||
        Math.abs(a - placed) - Math.abs(b - placed),
    );
  return clear[0] ?? placed;
}

/**
 * The span a text block can move in without meeting an asset, or none when
 * an asset sits beside the block rather than above or below it.
 */
function freeBand(
  assets: PlacedAsset[],
  top: number,
  total: number,
): { minTop: number; maxBottom: number } | undefined {
  let minTop = SAFE_TOP;
  let maxBottom = SAFE_BOTTOM;
  for (const asset of assets) {
    if (asset.y + asset.height <= top + 1e-9) {
      minTop = Math.max(minTop, asset.y + asset.height + ASSET_TEXT_GAP);
    } else if (asset.y >= top + total - 1e-9) {
      maxBottom = Math.min(maxBottom, asset.y - ASSET_TEXT_GAP);
    } else {
      return undefined;
    }
  }
  return { minTop, maxBottom };
}

const FREE_ZONE_THIRD: Record<NonNullable<LayoutHints["freeZone"]>, number> = {
  top: 0,
  middle: 1,
  bottom: 2,
};

/** Left edge of a text box: clear of the action buttons while it fits, centred otherwise. */
function textLeft(maxWidth: number): number {
  if (TEXT_LEFT + maxWidth <= SAFE_RIGHT) return TEXT_LEFT;
  return SIDE_MARGIN + maxWidth <= SAFE_RIGHT
    ? SAFE_RIGHT - maxWidth
    : (1 - maxWidth) / 2;
}

/**
 * Where a text block taller than the safe zone starts. Size is fixed at the
 * account's value, so a tall block cannot be shrunk to fit. Bottom-anchored
 * (the block's bottom edge at 1 - TEXT_BOTTOM_MARGIN) whenever flooring the
 * top at TEXT_TOP_LIMIT still leaves the block's bottom at or above y = 1,
 * that is whenever `total <= 1 - TEXT_TOP_LIMIT`. A block that cannot fit
 * even flush against the top is centred on the whole frame, overflowing top
 * and bottom equally: flooring it would run the whole excess off the bottom
 * edge, which on a 9:16 slide is where a platform's caption and action
 * chrome sit, and would clip a total just under 1 while headroom sits unused
 * above it.
 */
function fallbackTextTop(total: number): number {
  return total > 1 - TEXT_TOP_LIMIT
    ? (1 - total) / 2
    : Math.max(TEXT_TOP_LIMIT, 1 - TEXT_BOTTOM_MARGIN - total);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * How tall one text box has to be, in canvas fractions, to show every line it
 * wraps to at the account's `maxWidth`. Nothing caps the result: a box grows
 * downwards for as long as the text needs, because the alternative is losing
 * the lines that do not fit.
 *
 * This wraps through the same wrapText computeTextLayout uses, with the same
 * TEXT_WRAP_INSET, and takes the height from the same textContentHeight,
 * because the renderer clips to `visibleLineCount` and drops whatever a
 * shorter box cannot hold. The old estimate here divided the character count
 * by an average line length, which ignored word boundaries and both insets,
 * and so undercounted the lines of most real captions: an 80-character
 * caption wrapped to five lines, was composed a three-line box, and lost its
 * last two lines.
 *
 * `measure` works at the export's own scale, where a design pixel is an
 * output pixel, so the box holds exactly the lines the export draws.
 */
function textHeight(
  text: string,
  size: number,
  height: number,
  measure: MeasureText,
  maxWidth: number,
  perLineBox: boolean,
): number {
  const wrapWidth = Math.max(1, maxWidth * DESIGN_WIDTH - size * TEXT_WRAP_INSET);
  const lines = wrapText(text, wrapWidth, measure);
  return textContentHeight(lines.length, size, perLineBox) / height;
}

/**
 * Places assets above `areaBottom`. A lone asset sits top left, at most
 * `maxWidth` wide. Several share rows of at most three, centred in the band
 * left of SAFE_RIGHT, each at most `maxWidth` wide.
 */
function layoutAssets(
  assets: LibraryItem[],
  height: number,
  areaBottom: number,
  maxWidth: number = ASSET_MAX_WIDTH,
): PlacedAsset[] {
  if (!assets.length) return [];
  const areaTop = ASSET_TOP_MARGIN;
  // A tall text block leaves almost no room above it. The floor keeps every
  // asset visible, even if the text below it then leaves the safe zone or,
  // for a block taller than the zone, overlaps it.
  const bottom = Math.max(areaTop + 0.08, areaBottom);
  const aspectOf = (item: LibraryItem) => (item.height || 1) / (item.width || 1);

  const [lone] = assets;
  if (lone && assets.length === 1) {
    const aspect = aspectOf(lone);
    let width = maxWidth;
    let boxHeight = (width * DESIGN_WIDTH * aspect) / height;
    if (ASSET_TOP + boxHeight > bottom) {
      boxHeight = bottom - ASSET_TOP;
      width = (boxHeight * height) / (DESIGN_WIDTH * aspect);
    }
    return [{ item: lone, x: ASSET_LEFT, y: ASSET_TOP, width, height: boxHeight }];
  }

  const areaHeight = bottom - areaTop;
  const rows = chunk(assets, ASSET_ROW_MAX);
  const rowHeight = (areaHeight - ASSET_GAP * (rows.length - 1)) / rows.length;
  const placed: PlacedAsset[] = [];
  // Every row uses the same column count, so a partial last row keeps the same
  // item size and simply sits centered instead of stretching.
  const columns = Math.min(assets.length, ASSET_ROW_MAX);
  const bandWidth = SAFE_RIGHT - SIDE_MARGIN;
  const slotWidth = Math.min(maxWidth, (bandWidth - ASSET_GAP * (columns - 1)) / columns);

  rows.forEach((row, rowIndex) => {
    const sized = row.map((item) => {
      const aspect = aspectOf(item);
      let width = slotWidth;
      let boxHeight = (width * DESIGN_WIDTH * aspect) / height;
      if (boxHeight > rowHeight) {
        boxHeight = rowHeight;
        width = (boxHeight * height) / (DESIGN_WIDTH * aspect);
      }
      return { item, width, height: boxHeight };
    });
    const rowWidth =
      sized.reduce((sum, box) => sum + box.width, 0) + ASSET_GAP * (row.length - 1);
    const tallest = Math.max(...sized.map((box) => box.height));
    const rowTop = areaTop + rowIndex * (rowHeight + ASSET_GAP);
    let cursor = SIDE_MARGIN + (bandWidth - rowWidth) / 2;
    for (const box of sized) {
      placed.push({
        item: box.item,
        x: cursor,
        y: rowTop + (tallest - box.height) / 2,
        width: box.width,
        height: box.height,
      });
      cursor += box.width + ASSET_GAP;
    }
  });
  return placed;
}

/** Reduces a full document back to the composition shorthand the agent speaks. */
export function toComposition(project: CompositionSource): CompositionProject {
  return {
    id: project.id,
    name: project.name,
    version: project.version,
    ratio: project.ratio,
    slides: (project.slides || []).map((slide) => ({
      name: slide.name,
      background: slide.backgroundItemId || null,
      assets: (slide.overlays || [])
        .slice()
        .sort((a, b) => (a.z || 0) - (b.z || 0))
        .map((overlay) => overlay.itemId),
      texts: (slide.texts || [])
        .slice()
        .sort((a, b) => (a.z || 0) - (b.z || 0))
        .map((text) => text.text),
      ...(slide.layout ? { layout: slide.layout } : {}),
    })),
  };
}

/** An item looked up for account-scope checking; `name` makes the rejection
 * actionable when the caller's lookup provides one. */
interface ScopedItem {
  accountId: string;
  name?: string;
}

export interface AccountScopeContext {
  accountId: string;
  lookupItem: (id: string) => ScopedItem | null;
}

/**
 * The one cross-account rule, shared by every write path that can plant a
 * foreign library item into a slideshow: validateComposition (the agent's
 * Composition shorthand) and validateDocumentAccountScope (the raw document
 * ProjectService stores). This is the error a user actually hits on a
 * slideshow they cannot otherwise fix, so it names the slide and, when the
 * lookup can supply one, the item's name — not just an internal id.
 */
function assertOwnedByAccount(
  id: string,
  context: AccountScopeContext,
  describeSlide: () => string,
): void {
  const item = context.lookupItem(id);
  if (item && item.accountId !== context.accountId) {
    const label = item.name ? `"${item.name}" (${id})` : `library item ${id}`;
    throw new ComposeError(
      `${describeSlide()} references ${label} from a different account.`,
    );
  }
}

export function validateComposition(
  compositions: Composition[],
  context: AccountScopeContext,
): void {
  if (!Array.isArray(compositions) || !compositions.length) {
    throw new ComposeError("A slideshow needs at least one slide.");
  }
  // Array.isArray narrows unknown to any[], which this module bans, so the
  // checked value carries on under an explicit element type instead.
  const list: unknown[] = compositions;
  if (list.length > 100)
    throw new ComposeError("A slideshow can hold at most 100 slides.");
  list.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") {
      throw new ComposeError(`Slide ${index + 1} is not an object.`);
    }
    const composition = slide as Composition;
    if (!composition.background) {
      throw new ComposeError(`Slide ${index + 1} needs a background library item id.`);
    }
    const describeSlide = (): string =>
      `Slide ${index + 1}${composition.name ? ` ("${composition.name}")` : ""}`;
    const ids = [composition.background, ...(composition.assets ?? [])].filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    for (const id of ids) {
      assertOwnedByAccount(id, context, describeSlide);
    }
  });
}

/**
 * Same cross-account rule as validateComposition, over the raw document shape
 * ProjectService stores (a StoredDocument's `slides`, still `unknown[]` at
 * this point) instead of the agent's Composition shorthand. Extracts item ids
 * the same way ProjectService.reindex() does: a slide's backgroundItemId plus
 * each of its overlays' itemId. `/api/projects` accepts a raw document, so
 * this is what runs on that write path.
 */
export function validateDocumentAccountScope(
  slides: unknown[],
  context: AccountScopeContext,
): void {
  slides.forEach((entry, index) => {
    const slide = asRecord(entry);
    if (!slide) return;
    const slideName = typeof slide["name"] === "string" ? slide["name"] : undefined;
    const describeSlide = (): string =>
      `Slide ${index + 1}${slideName ? ` ("${slideName}")` : ""}`;
    const backgroundId = slide["backgroundItemId"];
    if (typeof backgroundId === "string" && backgroundId) {
      assertOwnedByAccount(backgroundId, context, describeSlide);
    }
    const overlays = slide["overlays"];
    if (!Array.isArray(overlays)) return;
    for (const candidate of overlays) {
      const overlay = asRecord(candidate);
      const itemId = overlay?.["itemId"];
      if (typeof itemId === "string" && itemId) {
        assertOwnedByAccount(itemId, context, describeSlide);
      }
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parses a slide's anchors, refusing an unknown one. An empty object means none. */
function toLayout(value: unknown, index: number): SlideLayout | undefined {
  if (value == null) return undefined;
  const parsed = slideLayoutSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ComposeError(
      `Slide ${String(index + 1)} has an invalid layout at ${issue?.path.join(".") || "layout"}: ${issue?.message ?? "bad value"}`,
    );
  }
  return Object.keys(parsed.data).length ? parsed.data : undefined;
}

function sameLayout(a: SlideLayout | undefined, b: SlideLayout | undefined): boolean {
  return a?.text === b?.text && a?.assets === b?.assets && a?.assetSize === b?.assetSize;
}

function toStyledText(value: CompositionText): StyledText {
  if (typeof value !== "object") return { text: String(value), style: {} };
  // The raw HTTP route hands its body over unparsed, so this is where a bad
  // size or colour is refused. The schema strips every other key, so nothing
  // can set geometry through here.
  const parsed = styledTextSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ComposeError(
      `Text line ${JSON.stringify(value)} is invalid at ${issue?.path.join(".") || "text"}: ${issue?.message ?? "bad value"}`,
    );
  }
  // Zod leaves an absent key absent, so no field holds `undefined` here.
  const { text, ...style } = parsed.data;
  return { text, style: style as TextStyle };
}

/**
 * Whether a layer already wears the style asked for. An omitted field matches
 * anything, so a plain string sent back never wipes a line's style. The
 * request goes through the same contrast flip composeSlide applies, or a boxed
 * line asked for in its own box colour would never match and lose its
 * geometry on every update.
 */
function hasStyle(layer: TextLayer, style: TextStyle): boolean {
  const wanted = ensureBoxedTextContrast({ ...layer, ...style });
  return TEXT_STYLE_KEYS.every(
    (key) => style[key] === undefined || wanted[key] === layer[key],
  );
}

function sameComposition(
  slide: Slide,
  backgroundId: string,
  assetIds: string[],
  texts: StyledText[],
): boolean {
  if (slide.backgroundItemId !== backgroundId) return false;
  const currentAssets = (slide.overlays || [])
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .map((overlay) => overlay.itemId);
  const currentTexts = (slide.texts || [])
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0));
  return (
    sameList(currentAssets, assetIds) &&
    currentTexts.length === texts.length &&
    currentTexts.every(
      (layer, index) =>
        layer.text === texts[index]?.text && hasStyle(layer, texts[index].style),
    )
  );
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRatio(a: Ratio, b: Ratio): boolean {
  return Boolean(a) && Math.abs(a.w / a.h - b.w / b.h) < 0.0005;
}

function normalizeRatio(ratio: Ratio | undefined): Ratio {
  const w = Number(ratio?.w);
  const h = Number(ratio?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return { ...DEFAULT_RATIO };
  if (w / h < RATIO_ASPECT_MIN || w / h > RATIO_ASPECT_MAX)
    throw new ComposeError(
      `Keep the ratio between ${String(RATIO_ASPECT_MIN)}:1 and ${String(RATIO_ASPECT_MAX)}:1.`,
    );
  return { w, h };
}

function normalizeList<T>(value: T[] | T | null | undefined): T[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (entry) => entry != null && entry !== "",
  );
}

function chunk<T>(list: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < list.length; index += size)
    rows.push(list.slice(index, index + size));
  return rows;
}
