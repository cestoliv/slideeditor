import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readFontMetrics } from "../../shared/text/index.js";
import { packageRoot } from "../plugins/client.js";
import { toWoff2 } from "../testing.js";
import { woff2ToSfnt } from "./woff2.js";

const ttf = new Uint8Array(readFileSync(join(packageRoot(), "assets", "TikTokSans.ttf")));
const fromTtf = readFontMetrics(ttf);

const LINES = [
  "elle m'a dit que j'avais changé",
  "MAXIMUM WEIGHT WORKOUT",
  "Te Vo Wa 5:30",
];

it.each([
  ["every table stored as is", false],
  ["hmtx reduced to its advances", true],
])("measures a WOFF2 face with %s as its TrueType file", (_name, transformHmtx) => {
  const sfnt = woff2ToSfnt(toWoff2(ttf, transformHmtx));
  const fromWoff2 = sfnt && readFontMetrics(sfnt);
  expect(fromWoff2).not.toBeNull();
  for (const line of LINES) {
    for (const weight of [300, 500, 900]) {
      expect(fromWoff2?.measure(line, 48, weight)).toBe(
        fromTtf?.measure(line, 48, weight),
      );
    }
  }
});

it("refuses a file that is not WOFF2, or one cut short", () => {
  expect(woff2ToSfnt(ttf)).toBeNull();
  const woff2 = toWoff2(ttf);
  expect(woff2ToSfnt(woff2.subarray(0, woff2.byteLength / 2))).toBeNull();
});
