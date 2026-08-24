import { expect, it } from "vitest";
import { wrapText } from "./wrap.js";

const measure = (line: string) => line.length * 10;

it("wraps on whitespace", () => {
  expect(wrapText("one two three", 100, measure)).toEqual(["one two", "three"]);
});

it("keeps an explicit newline as a line break", () => {
  expect(wrapText("one\ntwo", 1000, measure)).toEqual(["one", "two"]);
});

it("keeps an empty paragraph as an empty line", () => {
  expect(wrapText("one\n\ntwo", 1000, measure)).toEqual(["one", "", "two"]);
});

it("breaks a word that cannot fit on its own line", () => {
  expect(wrapText("abcdefgh", 30, measure)).toEqual(["abc", "def", "gh"]);
});

it("never returns an empty array", () => {
  expect(wrapText("", 100, measure)).toEqual([""]);
});

it("keeps every empty line of a run of newlines", () => {
  expect(wrapText("\n\n\n", 100, measure)).toEqual(["", "", "", ""]);
});

it("gives a word wider than the box one line per chunk that fits", () => {
  expect(wrapText("aaa", 1, measure)).toEqual(["a", "a", "a"]);
});
