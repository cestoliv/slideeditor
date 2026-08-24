import { describe, expect, it } from "vitest";
import { libraryItemSchema, libraryUseSchema } from "./library.js";

it("parses tags from a comma-separated string into an array", () => {
  const item = libraryItemSchema.parse({
    id: "i1",
    kind: "asset",
    name: "Arrow",
    description: "",
    usage: "",
    tags: ["arrow", "pointer"],
    mediaId: "m1",
    ext: "png",
    url: "/media/m1.png",
    width: 100,
    height: 100,
    createdAt: 1,
    updatedAt: 2,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  });
  expect(item.tags).toEqual(["arrow", "pointer"]);
  expect(item.stats.lastUsedAt).toBeNull();
});

it("parses a background item with used stats", () => {
  const item = libraryItemSchema.parse({
    id: "i2",
    kind: "background",
    name: "Sky",
    description: "A sky",
    usage: "cover",
    tags: [],
    mediaId: "m2",
    ext: "jpg",
    url: "/media/m2.jpg",
    width: 1080,
    height: 1920,
    createdAt: 10,
    updatedAt: 20,
    stats: { timesUsed: 3, slideshowCount: 2, firstUsedAt: 5, lastUsedAt: 15 },
  });
  expect(item.kind).toBe("background");
  expect(item.stats.firstUsedAt).toBe(5);
  expect(item.stats.lastUsedAt).toBe(15);
});

describe("libraryUseSchema", () => {
  // Both halves of the wire read it: the server answers `usedBy` and
  // `brokeSlideshows` with it and the client parses both out of a 409.
  it("reads the slideshow a library item is used by", () => {
    expect(libraryUseSchema.parse({ id: "p1", name: "Morning routine" })).toEqual({
      id: "p1",
      name: "Morning routine",
    });
  });

  it("refuses a use that names no slideshow", () => {
    expect(libraryUseSchema.safeParse({ id: "p1" }).success).toBe(false);
  });
});
