/**
 * The four fields a text layer picks its face by, for measuring one line.
 * `size` is in pixels at the scale the line is measured at.
 */
export type TextFont = {
  family: string;
  size: number;
  /** The layer's own weight, or null for the family's catalogued one. */
  weight: number | null;
  italic: boolean;
};

/** Measures one line in one face, returning its advance width in pixels. */
export type MeasureFont = (line: string, font: TextFont) => number;

/** Line widths read out of one font file, in the browser's own terms. */
export interface FontMetrics {
  /**
   * The advance width of `text` at `size` pixels and weight `weight`, kerned,
   * at the optical size a browser picks for that pixel size.
   */
  measure(text: string, size: number, weight: number): number;
}

/**
 * The width of a character the face lacks, which the browser draws from a
 * system emoji or CJK face this module cannot read. Apple Color Emoji draws
 * one em from 30px up, the sizes a caption is measured at, and up to a
 * quarter em wider below, where useFitTextBoxes grows a box it cuts.
 */
const MISSING_GLYPH_EMS = 1;

/** Zero-width joiners and variation selectors draw nothing in any fallback face. */
function isInvisible(codePoint: number): boolean {
  return codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f);
}

const IGNORE_BASE_GLYPHS = 0x2;
const IGNORE_LIGATURES = 0x4;
const IGNORE_MARKS = 0x8;

/** Bit 0x4 of a ValueFormat is XAdvance, bit 0x40 its variation device. */
const X_ADVANCE = 0x4;
const X_ADVANCE_DEVICE = 0x40;

function bitCount(value: number): number {
  let count = 0;
  for (let rest = value; rest; rest >>= 1) count += rest & 1;
  return count;
}

/**
 * Reads the metrics a browser lays a line out with: the cmap, the advance
 * widths, the variation deltas a weight and an optical size apply to them
 * (fvar, avar, HVAR), and the pair kerning in GPOS.
 *
 * A browser measures with HarfBuzz, which reads these same tables and also
 * swaps glyphs in context through GSUB. TikTok Sans, for one, draws another
 * colon between two digits, which no pair kerns. This module runs no
 * substitution, so each glyph counts as the widest of itself and the
 * alternates a default feature can swap in, kerned as loosely as any of
 * them, and a ligature counts as its letters. A line is then never measured
 * narrower than it is drawn, missing glyphs aside. Plain Latin text in the
 * bundled faces stays within a tenth of a percent of canvas measureText, and
 * a face with many ligatures or alternates runs up to about 1% wide.
 *
 * Returns null for a file that is not a plain TrueType or OpenType font, such
 * as WOFF2, and for a variable font without an HVAR table. A font cut short
 * or corrupt past its header throws a RangeError.
 */
export function readFontMetrics(bytes: Uint8Array): FontMetrics | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (at: number) => view.getUint8(at);
  const u16 = (at: number) => view.getUint16(at);
  const i16 = (at: number) => view.getInt16(at);
  const u32 = (at: number) => view.getUint32(at);
  const f2dot14 = (at: number) => view.getInt16(at) / 16384;
  const fixed = (at: number) => view.getInt32(at) / 65536;
  const tag = (at: number) =>
    String.fromCharCode(u8(at), u8(at + 1), u8(at + 2), u8(at + 3));

  const flavour = u32(0);
  if (flavour !== 0x00010000 && tag(0) !== "OTTO" && tag(0) !== "true") return null;
  const tables = new Map<string, number>();
  for (let index = 0; index < u16(4); index++) {
    tables.set(tag(12 + 16 * index), u32(12 + 16 * index + 8));
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (head === undefined || hhea === undefined || cmap === undefined) return null;
  if (hmtx === undefined) return null;
  const metrics = hmtx;

  const unitsPerEm = u16(head + 18);
  const numberOfHMetrics = u16(hhea + 34);
  const glyphOf = readCmap(view, cmap);
  if (glyphOf === null) return null;

  // Variation axes, and the avar remapping of their normalized values.
  const axes: { tag: string; min: number; fallback: number; max: number }[] = [];
  const fvar = tables.get("fvar");
  if (fvar !== undefined) {
    const first = fvar + u16(fvar + 4);
    for (let index = 0; index < u16(fvar + 8); index++) {
      const at = first + index * u16(fvar + 10);
      axes.push({
        tag: tag(at),
        min: fixed(at + 4),
        fallback: fixed(at + 8),
        max: fixed(at + 12),
      });
    }
  }
  const segmentMaps: [number, number][][] = [];
  const avar = tables.get("avar");
  if (avar !== undefined && u16(avar) === 1) {
    let at = avar + 8;
    for (let index = 0; index < axes.length; index++) {
      const pairs: [number, number][] = [];
      for (let pair = 0; pair < u16(at); pair++) {
        pairs.push([f2dot14(at + 2 + 4 * pair), f2dot14(at + 4 + 4 * pair)]);
      }
      segmentMaps.push(pairs);
      at += 2 + 4 * pairs.length;
    }
  }

  /** The OpenType normalization of a weight and an optical size, avar applied, in F2Dot14 steps. */
  function coordinates(values: Record<string, number>): number[] {
    return axes.map((axis, index) => {
      const value = Math.min(
        Math.max(values[axis.tag] ?? axis.fallback, axis.min),
        axis.max,
      );
      let normal =
        value < axis.fallback
          ? (value - axis.fallback) / (axis.fallback - axis.min)
          : value > axis.fallback
            ? (value - axis.fallback) / (axis.max - axis.fallback)
            : 0;
      const pairs = segmentMaps[index] ?? [];
      for (let pair = 1; pair < pairs.length; pair++) {
        const [fromStart, toStart] = pairs[pair - 1] ?? [0, 0];
        const [fromEnd, toEnd] = pairs[pair] ?? [0, 0];
        if (normal > fromEnd) continue;
        normal =
          fromEnd === fromStart
            ? toEnd
            : toStart +
              ((normal - fromStart) * (toEnd - toStart)) / (fromEnd - fromStart);
        break;
      }
      return Math.round(normal * 16384) / 16384;
    });
  }

  /** The delta one item of an ItemVariationStore applies at `coords`. */
  function variationDelta(store: number, outer: number, inner: number, coords: number[]) {
    if (outer >= u16(store + 6)) return 0;
    const regions = store + u32(store + 2);
    const axisCount = u16(regions);
    const data = store + u32(store + 8 + 4 * outer);
    const wordField = u16(data + 2);
    const regionCount = u16(data + 4);
    if (inner >= u16(data)) return 0;
    const long = (wordField & 0x8000) !== 0;
    const words = wordField & 0x7fff;
    const [wide, narrow] = long ? [4, 2] : [2, 1];
    let at =
      data +
      6 +
      2 * regionCount +
      inner * (words * wide + (regionCount - words) * narrow);
    let delta = 0;
    for (let index = 0; index < regionCount; index++) {
      const size = index < words ? wide : narrow;
      const value =
        size === 4
          ? view.getInt32(at)
          : size === 2
            ? view.getInt16(at)
            : view.getInt8(at);
      at += size;
      const region = regions + 4 + u16(data + 6 + 2 * index) * axisCount * 6;
      let scalar = 1;
      for (let axis = 0; axis < axisCount && scalar !== 0; axis++) {
        const start = f2dot14(region + axis * 6);
        const peak = f2dot14(region + axis * 6 + 2);
        const end = f2dot14(region + axis * 6 + 4);
        const coord = coords[axis] ?? 0;
        if (start > peak || peak > end || (start < 0 && end > 0) || peak === 0) continue;
        if (coord < start || coord > end) scalar = 0;
        else if (coord < peak) scalar *= (coord - start) / (peak - start);
        else if (coord > peak) scalar *= (end - coord) / (end - peak);
      }
      delta += value * scalar;
    }
    return delta;
  }

  const hvar = tables.get("HVAR");
  // Without HVAR a variable face moves its advances through gvar outlines,
  // which this module does not read, so a heavier weight would measure narrow.
  if (fvar !== undefined && hvar === undefined) return null;
  function advanceOf(glyph: number, coords: number[]): number {
    const base = u16(metrics + 4 * Math.min(glyph, numberOfHMetrics - 1));
    if (hvar === undefined) return base;
    let outer = 0;
    let inner = glyph;
    const mapping = u32(hvar + 8);
    if (mapping !== 0) {
      const map = hvar + mapping;
      const count = u8(map) === 0 ? u16(map + 2) : u32(map + 2);
      const entries = map + (u8(map) === 0 ? 4 : 6);
      const entrySize = ((u8(map + 1) & 0x30) >> 4) + 1;
      const innerBits = (u8(map + 1) & 0x0f) + 1;
      let entry = 0;
      const at = entries + Math.min(glyph, count - 1) * entrySize;
      for (let byte = 0; byte < entrySize; byte++) entry = entry * 256 + u8(at + byte);
      outer = entry >>> innerBits;
      inner = entry & ((1 << innerBits) - 1);
    }
    return base + variationDelta(hvar + u32(hvar + 4), outer, inner, coords);
  }

  const gdef = tables.get("GDEF");
  const glyphClassDef = gdef !== undefined && u16(gdef + 4) ? gdef + u16(gdef + 4) : 0;
  const gdefStore =
    gdef !== undefined && u16(gdef + 2) >= 3 && u32(gdef + 14)
      ? gdef + u32(gdef + 14)
      : 0;
  const kernLookups = readKernLookups(view, tables.get("GPOS"));
  const alternates = readAlternates(view, tables.get("GSUB"));

  /**
   * The XAdvance of one ValueRecord, with its variation delta. `base` is the
   * table its device offsets count from: the PairSet in a format 1 subtable,
   * the subtable itself in format 2, as HarfBuzz reads them.
   */
  function xAdvance(record: number, format: number, base: number, coords: number[]) {
    if (!(format & X_ADVANCE)) return 0;
    let value = i16(record + 2 * bitCount(format & (X_ADVANCE - 1)));
    if (format & X_ADVANCE_DEVICE && gdefStore) {
      const device = u16(record + 2 * bitCount(format & (X_ADVANCE_DEVICE - 1)));
      if (device && u16(base + device + 4) === 0x8000) {
        value += variationDelta(
          gdefStore,
          u16(base + device),
          u16(base + device + 2),
          coords,
        );
      }
    }
    return value;
  }

  /** The kerning a pair subtable applies to `first` then `second`, or null when it does not apply. */
  function pairAdjustment(
    subtable: number,
    first: number,
    second: number,
    coords: number[],
  ): number | null {
    const coverageIndex = coverageOf(view, subtable + u16(subtable + 2), first);
    if (coverageIndex < 0) return null;
    const format1 = u16(subtable + 4);
    const format2 = u16(subtable + 6);
    const size1 = 2 * bitCount(format1);
    const size2 = 2 * bitCount(format2);
    if (u16(subtable) === 1) {
      const set = subtable + u16(subtable + 10 + 2 * coverageIndex);
      const stride = 2 + size1 + size2;
      let low = 0;
      let high = u16(set) - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const record = set + 2 + middle * stride;
        const glyph = u16(record);
        if (glyph === second) {
          return (
            xAdvance(record + 2, format1, set, coords) +
            xAdvance(record + 2 + size1, format2, set, coords)
          );
        }
        if (glyph < second) low = middle + 1;
        else high = middle - 1;
      }
      return null;
    }
    if (u16(subtable) !== 2) return null;
    const class1 = classOf(view, subtable + u16(subtable + 8), first);
    const class2 = classOf(view, subtable + u16(subtable + 10), second);
    const class2Count = u16(subtable + 14);
    if (class1 >= u16(subtable + 12) || class2 >= class2Count) return null;
    const record = subtable + 16 + (class1 * class2Count + class2) * (size1 + size2);
    return (
      xAdvance(record, format1, subtable, coords) +
      xAdvance(record + size1, format2, subtable, coords)
    );
  }

  /** The adjustment the first subtable of `lookup` that applies gives a pair, or null. */
  function pairIn(
    lookup: { subtables: number[] },
    first: number,
    second: number,
    coords: number[],
  ): { adjustment: number; consumes: boolean } | null {
    for (const subtable of lookup.subtables) {
      const adjustment = pairAdjustment(subtable, first, second, coords);
      if (adjustment !== null) return { adjustment, consumes: u16(subtable + 6) !== 0 };
    }
    return null;
  }

  /** Total pair kerning across a run of glyphs, lookup by lookup, the way HarfBuzz walks them. */
  function kerning(glyphs: number[], coords: number[]): number {
    const options = (glyph: number) => [glyph, ...(alternates.get(glyph) ?? [])];
    let total = 0;
    for (const lookup of kernLookups) {
      const skip = (glyph: number) => {
        if (!glyphClassDef) return false;
        const kind = classOf(view, glyphClassDef, glyph);
        return Boolean(
          (lookup.flag & IGNORE_BASE_GLYPHS && kind === 1) ||
          (lookup.flag & IGNORE_LIGATURES && kind === 2) ||
          (lookup.flag & IGNORE_MARKS && kind === 3),
        );
      };
      let index = 0;
      while (index < glyphs.length) {
        const first = glyphs[index] ?? 0;
        if (skip(first)) {
          index++;
          continue;
        }
        let next = index + 1;
        while (next < glyphs.length && skip(glyphs[next] ?? 0)) next++;
        if (next >= glyphs.length) break;
        const second = glyphs[next] ?? 0;
        const pair = pairIn(lookup, first, second, coords);
        // Either glyph may be drawn as an alternate the pair does not kern,
        // such as TikTok Sans's colon between digits, so the loosest counts.
        total += Math.max(
          ...options(first).flatMap((a) =>
            options(second).map((b) => pairIn(lookup, a, b, coords)?.adjustment ?? 0),
          ),
        );
        // A pair that also moves its second glyph consumes it, as HarfBuzz does.
        index = pair === null ? index + 1 : pair.consumes ? next + 1 : next;
      }
    }
    return total;
  }

  const advances = new Map<string, Map<number, number>>();
  return {
    measure(text, size, weight) {
      // A browser sets the optical size to the pixel size whenever the face
      // has that axis (font-optical-sizing: auto), so a small line is drawn in
      // a wider design than a large one.
      const coords = coordinates({ wght: weight, opsz: size });
      const key = coords.join(",");
      const cache = advances.get(key) ?? new Map<number, number>();
      advances.set(key, cache);
      // Chrome shapes each word on its own and a fallback face breaks the
      // run, so no pair is kerned across a space or a missing glyph.
      let word: number[] = [];
      let units = 0;
      for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;
        const glyph = glyphOf(codePoint);
        if (glyph === 0 || codePoint === 0x20) {
          units += kerning(word, coords);
          word = [];
        }
        if (glyph === 0) {
          if (!isInvisible(codePoint)) units += MISSING_GLYPH_EMS * unitsPerEm;
          continue;
        }
        if (codePoint !== 0x20) word.push(glyph);
        let advance = cache.get(glyph);
        if (advance === undefined) {
          advance = Math.max(
            advanceOf(glyph, coords),
            ...(alternates.get(glyph) ?? []).map((other) => advanceOf(other, coords)),
          );
          cache.set(glyph, advance);
        }
        units += advance;
      }
      return ((units + kerning(word, coords)) * size) / unitsPerEm;
    },
  };
}

/** The best Unicode subtable of a cmap, as a code point to glyph lookup. */
function readCmap(view: DataView, cmap: number): ((codePoint: number) => number) | null {
  const u16 = (at: number) => view.getUint16(at);
  const u32 = (at: number) => view.getUint32(at);
  let format4 = -1;
  for (let index = 0; index < u16(cmap + 2); index++) {
    const record = cmap + 4 + 8 * index;
    const platform = u16(record);
    const encoding = u16(record + 2);
    const subtable = cmap + u32(record + 4);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (u16(subtable) === 12) {
      const groups = u32(subtable + 12);
      return (codePoint) => {
        let low = 0;
        let high = groups - 1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const group = subtable + 16 + 12 * middle;
          if (codePoint < u32(group)) high = middle - 1;
          else if (codePoint > u32(group + 4)) low = middle + 1;
          else return u32(group + 8) + codePoint - u32(group);
        }
        return 0;
      };
    }
    if (u16(subtable) === 4 && format4 < 0) format4 = subtable;
  }
  if (format4 < 0) return null;
  const subtable = format4;
  const segments = u16(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const ranges = deltas + 2 * segments;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let index = 0; index < segments; index++) {
      if (codePoint > u16(ends + 2 * index)) continue;
      const start = u16(starts + 2 * index);
      if (codePoint < start) return 0;
      const delta = view.getInt16(deltas + 2 * index);
      const range = u16(ranges + 2 * index);
      if (range === 0) return (codePoint + delta) & 0xffff;
      const glyph = u16(ranges + 2 * index + range + 2 * (codePoint - start));
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/** The index of `glyph` in a Coverage table, or -1. */
function coverageOf(view: DataView, coverage: number, glyph: number): number {
  const u16 = (at: number) => view.getUint16(at);
  const count = u16(coverage + 2);
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (u16(coverage) === 1) {
      const value = u16(coverage + 4 + 2 * middle);
      if (value === glyph) return middle;
      if (value < glyph) low = middle + 1;
      else high = middle - 1;
    } else {
      const range = coverage + 4 + 6 * middle;
      if (glyph < u16(range)) high = middle - 1;
      else if (glyph > u16(range + 2)) low = middle + 1;
      else return u16(range + 4) + glyph - u16(range);
    }
  }
  return -1;
}

/** The class of `glyph` in a ClassDef table, 0 when it has none. */
function classOf(view: DataView, classDef: number, glyph: number): number {
  const u16 = (at: number) => view.getUint16(at);
  if (u16(classDef) === 1) {
    const offset = glyph - u16(classDef + 2);
    return offset >= 0 && offset < u16(classDef + 4) ? u16(classDef + 6 + 2 * offset) : 0;
  }
  let low = 0;
  let high = u16(classDef + 2) - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = classDef + 4 + 6 * middle;
    if (glyph < u16(range)) high = middle - 1;
    else if (glyph > u16(range + 2)) low = middle + 1;
    else return u16(range + 4);
  }
  return 0;
}

/** The GSUB features a browser applies to a Latin line unasked. */
const DEFAULT_SUBSTITUTIONS = new Set(["ccmp", "rlig", "rclt", "calt", "clig", "liga"]);

/** The lookup indexes of every GSUB or GPOS feature, by feature tag. */
function featureLookups(view: DataView, table: number): Map<string, Set<number>> {
  const u16 = (at: number) => view.getUint16(at);
  const features = table + u16(table + 6);
  const byTag = new Map<string, Set<number>>();
  for (let index = 0; index < u16(features); index++) {
    const record = features + 2 + 6 * index;
    const name = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    const feature = features + u16(record + 4);
    const lookups = byTag.get(name) ?? new Set<number>();
    for (let lookup = 0; lookup < u16(feature + 2); lookup++) {
      lookups.add(u16(feature + 4 + 2 * lookup));
    }
    byTag.set(name, lookups);
  }
  return byTag;
}

/** Every glyph a Coverage table lists, in coverage order. */
function coveredGlyphs(view: DataView, coverage: number): number[] {
  const u16 = (at: number) => view.getUint16(at);
  const glyphs: number[] = [];
  for (let index = 0; index < u16(coverage + 2); index++) {
    if (u16(coverage) === 1) {
      glyphs.push(u16(coverage + 4 + 2 * index));
      continue;
    }
    const range = coverage + 4 + 6 * index;
    for (let glyph = u16(range); glyph <= u16(range + 2); glyph++) glyphs.push(glyph);
  }
  return glyphs;
}

/**
 * The lookups a contextual subtable (GSUB type 5 or 6, any format) runs,
 * read off its SubstLookupRecords.
 */
function nestedLookups(view: DataView, subtable: number, chained: boolean): number[] {
  const u16 = (at: number) => view.getUint16(at);
  /** The records after a rule's glyph or class sequences, as lookup indexes. */
  const records = (at: number, count: number) =>
    Array.from({ length: count }, (_, index) => u16(at + 4 * index + 2));
  /** One rule of a format 1 or 2 subtable. */
  const rule = (at: number): number[] => {
    if (!chained) return records(at + 4 + 2 * (u16(at) - 1), u16(at + 2));
    let cursor = at + 2 + 2 * u16(at);
    cursor += 2 * u16(cursor);
    cursor += 2 + 2 * u16(cursor);
    return records(cursor + 2, u16(cursor));
  };
  const format = u16(subtable);
  if (format === 3) {
    if (!chained) return records(subtable + 6 + 2 * u16(subtable + 2), u16(subtable + 4));
    let cursor = subtable + 2;
    for (let sequence = 0; sequence < 3; sequence++) cursor += 2 + 2 * u16(cursor);
    return records(cursor + 2, u16(cursor));
  }
  // Format 1 and 2 hold rule sets after their coverage and class definitions.
  const sets = subtable + (chained ? (format === 1 ? 4 : 10) : format === 1 ? 4 : 6);
  const found: number[] = [];
  for (let index = 0; index < u16(sets); index++) {
    const offset = u16(sets + 2 + 2 * index);
    if (!offset) continue;
    const set = subtable + offset;
    for (let entry = 0; entry < u16(set); entry++) {
      found.push(...rule(set + u16(set + 2 + 2 * entry)));
    }
  }
  return found;
}

/**
 * The single substitutions a default feature can make, from each glyph to
 * the glyphs that can replace it: the lookups those features list, and every
 * lookup their contextual lookups run in turn, such as the one behind calt.
 */
function readAlternates(view: DataView, gsub: number | undefined): Map<number, number[]> {
  const alternates = new Map<number, number[]>();
  if (gsub === undefined) return alternates;
  const u16 = (at: number) => view.getUint16(at);
  const byTag = featureLookups(view, gsub);
  const pending = [...DEFAULT_SUBSTITUTIONS].flatMap((name) => [
    ...(byTag.get(name) ?? []),
  ]);
  const seen = new Set<number>();
  const lookups = gsub + u16(gsub + 8);
  while (pending.length > 0) {
    const index = pending.pop() ?? 0;
    if (seen.has(index) || index >= u16(lookups)) continue;
    seen.add(index);
    const lookup = lookups + u16(lookups + 2 + 2 * index);
    for (let sub = 0; sub < u16(lookup + 4); sub++) {
      let subtable = lookup + u16(lookup + 6 + 2 * sub);
      let type = u16(lookup);
      if (type === 7) {
        type = u16(subtable + 2);
        subtable += view.getUint32(subtable + 4);
      }
      if (type === 5 || type === 6)
        pending.push(...nestedLookups(view, subtable, type === 6));
      if (type !== 1) continue;
      coveredGlyphs(view, subtable + u16(subtable + 2)).forEach((glyph, coverage) => {
        const other =
          u16(subtable) === 1
            ? (glyph + view.getInt16(subtable + 4)) & 0xffff
            : u16(subtable + 6 + 2 * coverage);
        alternates.set(glyph, [...(alternates.get(glyph) ?? []), other]);
      });
    }
  }
  return alternates;
}

/**
 * The pair adjustment subtables of every `kern` feature in GPOS, in lookup
 * order, with extension lookups unwrapped. A Latin line runs through the same
 * lookups under every script tag in the faces this app ships.
 */
function readKernLookups(
  view: DataView,
  gpos: number | undefined,
): { flag: number; subtables: number[] }[] {
  if (gpos === undefined) return [];
  const u16 = (at: number) => view.getUint16(at);
  const features = gpos + u16(gpos + 6);
  const lookups = gpos + u16(gpos + 8);
  const indexes = new Set<number>();
  for (let index = 0; index < u16(features); index++) {
    const record = features + 2 + 6 * index;
    const name = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    if (name !== "kern") continue;
    const feature = features + u16(record + 4);
    for (let lookup = 0; lookup < u16(feature + 2); lookup++) {
      indexes.add(u16(feature + 4 + 2 * lookup));
    }
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => {
      const lookup = lookups + u16(lookups + 2 + 2 * index);
      const type = u16(lookup);
      const subtables: number[] = [];
      for (let sub = 0; sub < u16(lookup + 4); sub++) {
        const subtable = lookup + u16(lookup + 6 + 2 * sub);
        if (type === 2) subtables.push(subtable);
        else if (type === 9 && u16(subtable + 2) === 2) {
          subtables.push(subtable + view.getUint32(subtable + 4));
        }
      }
      return { flag: u16(lookup + 2), subtables };
    });
}
