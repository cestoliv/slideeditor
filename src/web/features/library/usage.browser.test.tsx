import { expect, it } from "vitest";
import type { LibraryStats } from "@shared/schema/index.js";
import { describeUsage, relativeDate } from "./usage.js";

/*
 * The two pure helpers behind every card's footer. They run in the web project
 * because vitest.config.ts collects only browser test files under src/web, so a
 * plain usage.test.ts here would never be run at all.
 */

const DAY = 86400000;
/** A fixed reading of the clock, so no assertion here depends on when it runs. */
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

function stats(overrides: Partial<LibraryStats> = {}): LibraryStats {
  return {
    timesUsed: 0,
    slideshowCount: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

it("says never used when there is no history", () => {
  expect(describeUsage(stats())).toBe("never used");
});

it("counts placements and slideshows separately", () => {
  const described = describeUsage(
    stats({ timesUsed: 5, slideshowCount: 2, firstUsedAt: 1, lastUsedAt: NOW - DAY }),
    NOW,
  );
  expect(described).toBe("5 uses across 2 slideshows · last used yesterday");
});

it("says one use of one slideshow in the singular", () => {
  const described = describeUsage(
    stats({ timesUsed: 1, slideshowCount: 1, firstUsedAt: NOW, lastUsedAt: NOW }),
    NOW,
  );
  expect(described).toBe("1 use across 1 slideshow · last used today");
});

it("separates placements from slideshows, so twice on one slide reads as one show", () => {
  // The whole point of the pair: 4 placements in 1 slideshow is not 4 slideshows.
  const described = describeUsage(
    stats({ timesUsed: 4, slideshowCount: 1, firstUsedAt: 1, lastUsedAt: NOW }),
    NOW,
  );
  expect(described).toBe("4 uses across 1 slideshow · last used today");
});

it("reads a recent timestamp as today", () => {
  expect(relativeDate(Date.now())).toBe("today");
});

it("has never used anything without a timestamp", () => {
  expect(relativeDate(null)).toBe("never");
  // The epoch is the server's own "no history" value in a numeric column.
  expect(relativeDate(0)).toBe("never");
});

it("reads yesterday and a clock that has run ahead", () => {
  expect(relativeDate(NOW - DAY, NOW)).toBe("yesterday");
  // A row written by a machine whose clock is fast must not read as "-1 days ago".
  expect(relativeDate(NOW + DAY, NOW)).toBe("today");
});

it("counts whole days up to a month and whole months past it", () => {
  // Every hour of a day belongs to that day, so a part day rounds down. An
  // implementation rounding to nearest would call 2.6 days "3 days ago".
  for (let days = 2; days < 30; days += 1) {
    for (const extra of [0, 3600000, DAY - 1]) {
      expect(relativeDate(NOW - days * DAY - extra, NOW)).toBe(
        `${String(days)} days ago`,
      );
    }
  }
  expect(relativeDate(NOW - 30 * DAY, NOW)).toBe("1 month ago");
  expect(relativeDate(NOW - 59 * DAY, NOW)).toBe("1 month ago");
  expect(relativeDate(NOW - 60 * DAY, NOW)).toBe("2 months ago");
  expect(relativeDate(NOW - 400 * DAY, NOW)).toBe("13 months ago");
});
