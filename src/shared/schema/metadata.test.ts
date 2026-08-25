import { expect, it } from "vitest";
import {
  DESCRIPTION_LIMIT,
  HASHTAG_LIMIT,
  normalizeDescription,
  normalizeHashtags,
} from "./metadata.js";

/*
 * The caption's two normalisers, which the server and the editor both call. An
 * agent sends whichever hashtag shape it thinks in, and everything that reads
 * one back has to see the same shape, so these are the tests that say what that
 * shape is.
 */

it("keeps a description as it was written", () => {
  const written = "Five things to know\n\nbefore you book a summer trip.";
  expect(normalizeDescription(written)).toBe(written);
});

it("stops a description at the caption limit both platforms enforce", () => {
  const long = "a".repeat(DESCRIPTION_LIMIT + 50);
  expect(normalizeDescription(long)).toHaveLength(DESCRIPTION_LIMIT);
});

it("reads no description out of a value that is not text", () => {
  expect(normalizeDescription(undefined)).toBe("");
  expect(normalizeDescription(null)).toBe("");
  expect(normalizeDescription(42)).toBe("");
});

it("puts one hash on every tag of a list", () => {
  expect(normalizeHashtags(["travel", "#summer", "tips"])).toBe("#travel #summer #tips");
});

it("reads a string of tags the same way as the list", () => {
  expect(normalizeHashtags("travel #summer  tips")).toBe("#travel #summer #tips");
});

it("takes commas as a separator, because a person typing tags uses them", () => {
  expect(normalizeHashtags("#travel, summer,tips")).toBe("#travel #summer #tips");
});

it("keeps a repeated tag once, whatever its casing", () => {
  expect(normalizeHashtags("#Travel travel #TRAVEL summer")).toBe("#Travel #summer");
});

it("collapses a run of hashes rather than stacking them", () => {
  expect(normalizeHashtags("##travel")).toBe("#travel");
});

it("drops a stray hash that names no tag", () => {
  expect(normalizeHashtags("# #travel #")).toBe("#travel");
});

it("stops at the thirty tags Instagram accepts", () => {
  const many = Array.from({ length: HASHTAG_LIMIT + 5 }, (_tag, index) => `tag${index}`);
  const tags = normalizeHashtags(many).split(" ");
  expect(tags).toHaveLength(HASHTAG_LIMIT);
  expect(tags.at(-1)).toBe(`#tag${HASHTAG_LIMIT - 1}`);
});

it("reads no tags out of an empty or absent value", () => {
  expect(normalizeHashtags("")).toBe("");
  expect(normalizeHashtags("   ")).toBe("");
  expect(normalizeHashtags(undefined)).toBe("");
  expect(normalizeHashtags([])).toBe("");
});

it("skips a list entry that is not text and keeps the rest", () => {
  expect(normalizeHashtags(["travel", 7, null, "summer"])).toBe("#travel #summer");
});
