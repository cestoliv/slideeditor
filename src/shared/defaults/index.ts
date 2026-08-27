import type { AccountDefaults } from "../schema/account.js";
import type { TextLayer } from "../schema/document.js";

/** app.js:2952-2953. What a freshly added text box measures, before a caller resizes it. */
export const NEW_TEXT_WIDTH = 0.64;
export const NEW_TEXT_HEIGHT = 0.08;

/**
 * Builds a text layer from an account's defaults, writing them into concrete
 * values once at creation. Nothing reads the account afterward, so editing an
 * account never disturbs a slide that already exists.
 *
 * addTextLayer and composeSlide want different boxes: addTextLayer keeps the
 * one this returns, and composeSlide overrides width and height with its own
 * layout geometry. Only position and stacking order are each caller's own, so
 * `at` carries exactly those.
 *
 * `newId` lets composeSlide pass its own injected id generator, so a text
 * layer's id is as deterministic as every other id compose.ts hands out. The
 * editor's own call site (which has no such generator) omits it and falls
 * back to a random id, same as before.
 */
export function newTextLayer(
  defaults: AccountDefaults,
  at: { x: number; y: number; z: number },
  newId: () => string = () => globalThis.crypto.randomUUID(),
): TextLayer {
  return {
    id: newId(),
    text: "",
    x: at.x,
    y: at.y,
    width: NEW_TEXT_WIDTH,
    height: NEW_TEXT_HEIGHT,
    size: defaults.text.size,
    style: defaults.text.style,
    color: defaults.text.color,
    background: defaults.text.background,
    backgroundShape: defaults.text.backgroundShape,
    align: defaults.text.align,
    fontFamily: defaults.text.fontFamily,
    rotation: 0,
    z: at.z,
  };
}
