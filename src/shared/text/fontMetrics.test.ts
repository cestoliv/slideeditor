import { describe, expect, it } from "vitest";
// Inlined by Vite rather than read off disk, because src/shared type checks
// for the browser too, where node:fs does not exist.
import tiktokSansUri from "../../../assets/TikTokSans.ttf?inline";
import spaceMonoUri from "../../../assets/SpaceMono.ttf?inline";
import { readFontMetrics } from "./fontMetrics.js";
import type { FontMetrics } from "./fontMetrics.js";

function bytesOf(uri: string): Uint8Array {
  const binary = atob(uri.slice(uri.indexOf(",") + 1));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function metricsOf(uri: string): FontMetrics {
  const metrics = readFontMetrics(bytesOf(uri));
  if (metrics === null) throw new Error("The bundled font did not parse.");
  return metrics;
}

const tiktokSans = metricsOf(tiktokSansUri);
const spaceMono = metricsOf(spaceMonoUri);

describe("readFontMetrics", () => {
  // Each width is canvas measureText in Chrome 155 on macOS, kerning on. The
  // reader may run a tenth of a percent wide, never narrow, because a line
  // measured narrow is the one that loses a word off its box.
  it.each([
    ["elle m'a dit que j'avais changé", 64, 500, 818.37],
    // Below 36px TikTok Sans switches to a wider optical size.
    ["elle m'a dit que j'avais changé", 20, 500, 268.09],
    ["un curl sur 6 mois : de 26 à 34 kg", 48, 500, 684.13],
    ["ELLE M'A DIT QUE J'AVAIS CHANGÉ", 48, 800, 786.98],
    // Pairs kerned by both lookups, with deltas that vary with the weight.
    ["Te Vo Wa Yo AV LT", 48, 300, 373.39],
    ["Te Vo Wa Yo AV LT", 120, 900, 1019.52],
    // calt draws a colon between digits as another glyph, which no pair kerns.
    ["5:30/km", 48, 900, 193.87],
    ["1:30", 48, 500, 90.82],
  ])(
    "measures %j at %dpx, weight %d, as Chrome draws it",
    (text, size, weight, width) => {
      const measured = tiktokSans.measure(text, size, weight);
      expect(measured).toBeGreaterThanOrEqual(width - 0.005);
      expect(measured).toBeLessThanOrEqual(width * 1.001);
    },
  );

  it("measures a face with no variation axes", () => {
    expect(spaceMono.measure("un curl sur 6 mois", 48, 400)).toBeCloseTo(528.77, 1);
    expect(spaceMono.measure("un curl sur 6 mois", 48, 700)).toBeCloseTo(528.77, 1);
  });

  it("gives a character the face lacks the width of a system emoji, and a joiner none", () => {
    const strong = tiktokSans.measure("💪", 100, 500);
    expect(strong).toBe(100);
    expect(tiktokSans.measure("💪‍️", 100, 500)).toBe(strong);
  });

  it("kerns no pair across a space or a missing glyph, as Chrome shapes word by word", () => {
    // "AV" kerns tight. Split by a space or an emoji, the two letters do not.
    const apart = tiktokSans.measure("A", 48, 500) + tiktokSans.measure("V", 48, 500);
    expect(tiktokSans.measure("AV", 48, 500)).toBeLessThan(apart);
    const space = tiktokSans.measure(" ", 48, 500);
    expect(tiktokSans.measure("A V", 48, 500)).toBeCloseTo(apart + space, 6);
    expect(tiktokSans.measure("A💪V", 48, 500)).toBeCloseTo(apart + 48, 6);
  });

  it("measures an empty line as nothing", () => {
    expect(tiktokSans.measure("", 48, 500)).toBe(0);
  });

  it("refuses a file that is not a plain TrueType or OpenType font", () => {
    const woff2 = new Uint8Array(64);
    woff2.set([0x77, 0x4f, 0x46, 0x32]);
    expect(readFontMetrics(woff2)).toBeNull();
    expect(readFontMetrics(new Uint8Array(4))).toBeNull();
  });

  it("refuses a variable font whose advances vary without HVAR", () => {
    const bytes = bytesOf(tiktokSansUri);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < view.getUint16(4); index++) {
      const record = 12 + 16 * index;
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) === "HVAR") {
        bytes.set([0x58], record);
      }
    }
    expect(readFontMetrics(bytes)).toBeNull();
  });

  it("refuses a font with no metrics table", () => {
    // An sfnt header that lists no tables at all.
    const empty = new Uint8Array(12);
    empty.set([0x00, 0x01, 0x00, 0x00]);
    expect(readFontMetrics(empty)).toBeNull();
  });
});
