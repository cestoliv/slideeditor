import { describe, expect, it } from "vitest";
import { BUILTIN_DEFAULTS } from "../schema/index.js";
import type { AccountDefaults } from "../schema/index.js";
import { newTextLayer } from "./index.js";

describe("newTextLayer", () => {
  it("writes the account's text defaults into a new layer", () => {
    const layer = newTextLayer(BUILTIN_DEFAULTS, { x: 0.1, y: 0.2, z: 3 });
    expect(layer).toMatchObject({
      x: 0.1,
      y: 0.2,
      z: 3,
      width: 0.64,
      height: 0.08,
      size: BUILTIN_DEFAULTS.text.size,
      style: BUILTIN_DEFAULTS.text.style,
      color: BUILTIN_DEFAULTS.text.color,
      background: BUILTIN_DEFAULTS.text.background,
      backgroundShape: BUILTIN_DEFAULTS.text.backgroundShape,
      align: BUILTIN_DEFAULTS.text.align,
      fontFamily: BUILTIN_DEFAULTS.text.fontFamily,
      rotation: 0,
      text: "",
    });
    expect(layer.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives two layers different ids", () => {
    const a = newTextLayer(BUILTIN_DEFAULTS, { x: 0, y: 0, z: 1 });
    const b = newTextLayer(BUILTIN_DEFAULTS, { x: 0, y: 0, z: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it("follows a custom account's defaults, not the builtin ones", () => {
    const custom: AccountDefaults = {
      ...BUILTIN_DEFAULTS,
      text: { ...BUILTIN_DEFAULTS.text, size: 40, color: "#000000", align: "left" },
    };
    const layer = newTextLayer(custom, { x: 0, y: 0, z: 1 });
    expect(layer.size).toBe(40);
    expect(layer.color).toBe("#000000");
    expect(layer.align).toBe("left");
  });
});
