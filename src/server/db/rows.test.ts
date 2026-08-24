import { expect, it } from "vitest";
import { integer, optionalInteger, text } from "./rows.js";

it("reads a text column and falls back to an empty string", () => {
  expect(text({ name: "Backdrop" }, "name")).toBe("Backdrop");
  expect(text({ name: 12 }, "name")).toBe("");
  expect(text({}, "missing")).toBe("");
});

it("reads an integer column, widening a bigint", () => {
  expect(integer({ width: 1080 }, "width")).toBe(1080);
  expect(integer({ total: 7n }, "total")).toBe(7);
  expect(integer({ total: null }, "total")).toBe(0);
  expect(integer({}, "missing")).toBe(0);
});

it("tells a missing aggregate from a zero", () => {
  expect(optionalInteger({ times_used: 0 }, "times_used")).toBe(0);
  expect(optionalInteger({ times_used: 3n }, "times_used")).toBe(3);
  expect(optionalInteger({ times_used: null }, "times_used")).toBeNull();
  expect(optionalInteger({}, "times_used")).toBeNull();
});
