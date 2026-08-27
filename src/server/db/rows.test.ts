import { expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { integer, optionalInteger, requiredText, text } from "./rows.js";

it("reads a text column and falls back to an empty string", () => {
  expect(text({ name: "Backdrop" }, "name")).toBe("Backdrop");
  expect(text({ name: 12 }, "name")).toBe("");
  expect(text({}, "missing")).toBe("");
});

// Finding 3: text()'s quiet "" fallback is wrong for a column like
// account_id, whose NOT NULL is enforced by the service layer rather than by
// SQL (see migrations.ts). A NULL there used to read back as "", an empty
// string that passed every scope check as if it were a real account. This
// reader fails loudly instead, at the row-mapping boundary, the moment such
// a row is read.
it("reads a required text column and throws rather than fall back for NULL or empty", () => {
  expect(requiredText({ account_id: "default" }, "account_id")).toBe("default");
  expect(() => requiredText({ account_id: null }, "account_id")).toThrow(HttpError);
  expect(() => requiredText({ account_id: "" }, "account_id")).toThrow(HttpError);
  expect(() => requiredText({}, "account_id")).toThrow(HttpError);
  expect(() => requiredText({ account_id: 12 }, "account_id")).toThrow(HttpError);
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
