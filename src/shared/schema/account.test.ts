import { describe, expect, it } from "vitest";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "../text/constants.js";
import {
  BUILTIN_DEFAULTS,
  DEFAULT_ACCOUNT_ID,
  accountDefaultsSchema,
  accountSchema,
} from "./account.js";

function defaultsWithSize(size: number) {
  return {
    ratio: { w: 9, h: 16 },
    text: { ...BUILTIN_DEFAULTS.text, size },
  };
}

function defaultsWithColor(color: string) {
  return {
    ratio: { w: 9, h: 16 },
    text: { ...BUILTIN_DEFAULTS.text, color },
  };
}

it("BUILTIN_DEFAULTS reproduces today's rendering values exactly, matching migration 6's seed row", () => {
  expect(BUILTIN_DEFAULTS).toEqual({
    ratio: { w: 9, h: 16 },
    text: {
      fontFamily: "TikTok Sans",
      size: 64,
      style: "plain",
      color: "#FFFFFF",
      background: "white",
      backgroundShape: "lines",
      align: "center",
    },
  });
});

describe("accountDefaultsSchema", () => {
  it("parses a full defaults object", () => {
    const defaults = accountDefaultsSchema.parse({
      ratio: { w: 3, h: 4 },
      text: {
        fontFamily: "Inter",
        size: 48,
        style: "outline",
        color: "#000000",
        background: "black",
        backgroundShape: "full",
        align: "left",
      },
    });
    expect(defaults.ratio).toEqual({ w: 3, h: 4 });
    expect(defaults.text.fontFamily).toBe("Inter");
    expect(defaults.text.style).toBe("outline");
  });

  /*
   * Finding 1: text.size used to be a bare z.number().catch(64), so 0,
   * negative, and absurdly large sizes were all silently accepted and
   * stored — never a 400, just invisible or upside-down text forever
   * (textHeight() divides by size; a negative size composes a layer with
   * negative height). Unlike ratio, there is no downstream throw to catch
   * this, so the schema itself has to reject rather than coerce.
   */
  it("rejects a text size of 0 rather than silently coercing it", () => {
    const result = accountDefaultsSchema.safeParse(defaultsWithSize(0));
    expect(result.success).toBe(false);
  });

  it("rejects a negative text size rather than silently coercing it", () => {
    const result = accountDefaultsSchema.safeParse(defaultsWithSize(-400));
    expect(result.success).toBe(false);
  });

  it("rejects an absurdly large text size rather than silently coercing it", () => {
    const result = accountDefaultsSchema.safeParse(defaultsWithSize(1_000_000));
    expect(result.success).toBe(false);
  });

  it("accepts a text size at each bound of the editor's own slider range", () => {
    expect(accountDefaultsSchema.safeParse(defaultsWithSize(FONT_SIZE_MIN)).success).toBe(
      true,
    );
    expect(accountDefaultsSchema.safeParse(defaultsWithSize(FONT_SIZE_MAX)).success).toBe(
      true,
    );
  });

  /*
   * Finding 13: text.color used to be a bare z.string(), so "not-a-color"
   * was stored verbatim. Neither CSS nor the canvas paint path errors on
   * that — every slide from the account just paints with no colour set and
   * nothing reports it. Rejected here, the same way boundedSizeSchema
   * rejects an out-of-range size, rather than silently coerced.
   */
  it("rejects a text color that is not valid hex syntax", () => {
    const result = accountDefaultsSchema.safeParse(defaultsWithColor("not-a-color"));
    expect(result.success).toBe(false);
  });

  it("normalizes a 3-digit hex color to its uppercased 6-digit form", () => {
    const defaults = accountDefaultsSchema.parse(defaultsWithColor("#abc"));
    expect(defaults.text.color).toBe("#AABBCC");
  });

  it("normalizes a hex color missing its leading #", () => {
    const defaults = accountDefaultsSchema.parse(defaultsWithColor("ffffff"));
    expect(defaults.text.color).toBe("#FFFFFF");
  });

  it("repairs a malformed text style rather than rejecting the whole object", () => {
    const defaults = accountDefaultsSchema.parse({
      ratio: { w: 9, h: 16 },
      text: {
        fontFamily: "TikTok Sans",
        size: 64,
        style: "not-a-style",
        color: "#FFFFFF",
        background: "white",
        backgroundShape: "lines",
        align: "center",
      },
    });
    expect(defaults.text.style).toBe("plain");
  });
});

it("parses migration 6's exact seeded defaults blob and matches BUILTIN_DEFAULTS", () => {
  // Verbatim JSON from migration 6's `account` seed row (src/server/db/migrations,
  // Task 1, commit c6c5c6f), so this test fails if either side ever drifts.
  const seeded = {
    ratio: { w: 9, h: 16 },
    text: {
      fontFamily: "TikTok Sans",
      size: 64,
      style: "plain",
      color: "#FFFFFF",
      background: "white",
      backgroundShape: "lines",
      align: "center",
    },
  };
  const parsed = accountDefaultsSchema.parse(seeded);
  expect(parsed).toEqual(seeded);
  expect(parsed).toEqual(BUILTIN_DEFAULTS);
});

it("accountSchema parses a full account", () => {
  const account = accountSchema.parse({
    id: DEFAULT_ACCOUNT_ID,
    name: "Default",
    defaults: BUILTIN_DEFAULTS,
    createdAt: 0,
    updatedAt: 0,
  });
  expect(account.id).toBe("default");
  expect(account.defaults.text.size).toBe(64);
});
