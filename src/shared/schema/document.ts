import { z } from "zod";
import { textColorOf } from "../geometry/color.js";

// New projects are created with an explicit ratio (app.js:2121), so this
// fallback exists for legacy or corrupt documents: projectRatio (app.js:444-449)
// and normalizeDocument (server/projects.mjs:160-167) both guard the same way.
export const DEFAULT_RATIO = { w: 9, h: 16 } as const;

// z.coerce so a stored "4" round-trips the way normalizeDocument's Number()
// call does (server/projects.mjs:162-163), and .positive() alone already
// rejects NaN/Infinity/-Infinity, so no separate .finite() is needed.
export const ratioSchema = z
  .object({ w: z.coerce.number().positive(), h: z.coerce.number().positive() })
  .catch({ ...DEFAULT_RATIO });

export const overlaySchema = z.object({
  id: z.string(),
  itemId: z.string(),
  x: z.number().catch(0),
  y: z.number().catch(0),
  // app.js:541, Number(overlay.width) || 0.34.
  width: z.number().catch(0.34),
  // app.js:119-123 computes a missing height from the asset's own aspect and
  // crop, arithmetic this schema cannot do without the library. Leaving it
  // unset (rather than inventing a flat value that stretches or squashes the
  // asset) means a consumer with library access must fill it in before
  // render. Tasks 4/5 take note.
  height: z.number().optional(),
  rotation: z.number().catch(0),
  cropX: z.number().catch(0),
  cropY: z.number().catch(0),
  cropW: z.number().catch(1),
  cropH: z.number().catch(1),
  z: z.number().optional(),
});

const textStyleSchema = z.enum(["plain", "outline", "boxed"]).catch("plain");
const textBackgroundSchema = z.enum(["white", "black"]).catch("white");

// backgroundShape defaults to "full" here, matching normalizeProject in
// app.js:131. composeSlide (server/compose.mjs:127) writes "lines" for a text
// it creates. That split is deliberate, not a bug to unify.
const rawTextLayerSchema = z.object({
  id: z.string(),
  text: z.string().catch(""),
  // app.js compose.mjs:6-7, SIDE_MARGIN and CONTENT_WIDTH.
  x: z.number().catch(0.06),
  y: z.number().catch(0.5),
  width: z.number().catch(0.88),
  height: z.number().catch(0.1),
  size: z.number().catch(48),
  style: textStyleSchema,
  // outlineWidth used to sit here, defaulted to 12 (app.js:128). Nothing ever
  // read it: both render paths derive the stroke from fontSize * OUTLINE_RATIO
  // (app.js:2872, app.js:4493, and computeTextLayout in ../text/layout.ts), so
  // the stored number never reached a pixel. It is gone rather than wired,
  // because wiring it would have thickened every outline text already saved,
  // and an absolute pixel width carries no scale to cross from the stage to the
  // 1080-pixel export. A document still carrying the key parses fine: this is a
  // plain z.object, so it strips what it does not model.
  // Left unvalidated here: textColorOf, in this file's transform below,
  // repairs it against the sibling style/background fields, the way app.js:128
  // and textColor (app.js:232-235) do. A regex on this field alone cannot see
  // those siblings.
  color: z.string().catch(""),
  background: textBackgroundSchema,
  backgroundShape: z.enum(["lines", "full"]).catch("full"),
  align: z.enum(["left", "center", "right"]).catch("center"),
  rotation: z.number().catch(0),
  z: z.number().optional(),
});

// textColorOf ports app.js:232-235: a boxed text on anything but a black box
// defaults to dark text, everything else defaults to white. Without this, a
// legacy boxed text with no stored color renders white text on a white box.
export const textLayerSchema = rawTextLayerSchema.transform((text) => ({
  ...text,
  color: textColorOf(text),
}));

export type Ratio = z.infer<typeof ratioSchema>;
export type Overlay = z.infer<typeof overlaySchema>;
export type TextLayer = z.infer<typeof textLayerSchema>;

// One bad overlay or text should not wipe out its siblings, so each element
// is validated on its own and dropped on failure rather than the whole array
// falling back at once. This is more destructive than normalizeProject, which
// never removes a layer: a malformed id here disappears from the document
// instead of merely failing to render. The alternative, wiping every sibling
// over one bad element, is worse, so this is a deliberate behavior change on
// saved data.
const overlayListSchema = z
  .array(overlaySchema.nullable().catch(null))
  .catch([])
  .transform((list) => list.filter((overlay): overlay is Overlay => overlay !== null));

const textListSchema = z
  .array(textLayerSchema.nullable().catch(null))
  .catch([])
  .transform((list) => list.filter((text): text is TextLayer => text !== null));

// id and backgroundItemId are required: a slide missing either cannot be
// rendered, so documentSchema drops it rather than rendering it wrong.
export const slideSchema = z.object({
  id: z.string(),
  backgroundItemId: z.string(),
  name: z.string().catch(""),
  // app.js:312-313, hydrateProject's fallback when neither the background
  // asset nor the stored slide has a dimension.
  width: z.number().catch(1080),
  height: z.number().catch(1920),
  imageScale: z.number().catch(1),
  imageX: z.number().catch(0),
  imageY: z.number().catch(0),
  overlays: overlayListSchema,
  texts: textListSchema,
});

export type Slide = z.infer<typeof slideSchema>;

// zod strips keys this schema does not model. documentFor (app.js:321-329)
// only strips imageData and keeps everything else, so a field written by a
// version of the app this schema does not know about would be dropped on the
// next parse/save round-trip. Intentional for the fields this schema does
// model; worth revisiting if an older document turns out to carry more.
export const documentSchema = z.object({
  ratio: ratioSchema,
  slides: z
    .array(slideSchema.nullable().catch(null))
    .catch([])
    .transform((list) => list.filter((slide): slide is Slide => slide !== null)),
});

export type SlideDocument = z.infer<typeof documentSchema>;

/**
 * Assigns z on any overlay or text still missing it, overlays before texts,
 * matching normalizeProject (app.js:118-134). Mutates and returns the same
 * document so callers other than parseDocument (api.ts's parseProject) can
 * apply the same back-fill without duplicating it.
 */
export function assignLayerOrder(document: SlideDocument): SlideDocument {
  for (const slide of document.slides) {
    slide.overlays.forEach((overlay, index) => {
      if (overlay.z === undefined) overlay.z = index + 1;
    });
    slide.texts.forEach((text, index) => {
      if (text.z === undefined) text.z = slide.overlays.length + index + 1;
    });
  }
  return document;
}

/**
 * Parses a stored document, repairing rather than rejecting. Never throws:
 * non-object input (including arrays) is treated as an empty document, the
 * same guard normalizeDocument applies at server/projects.mjs:160-161, a
 * malformed field falls back to its default, and a slide that cannot be
 * rendered is dropped, but the rest of the slideshow survives.
 */
export function parseDocument(value: unknown): SlideDocument {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return assignLayerOrder(documentSchema.parse(source));
}
