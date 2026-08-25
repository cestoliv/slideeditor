import { expect, it } from "vitest";
import { packTar, unpackTar } from "./tar.js";

it("round trips a file byte for byte", () => {
  const body = Buffer.from("hello, tar");
  const [entry] = unpackTar(packTar([{ name: "a.txt", body }]));
  expect(entry?.name).toBe("a.txt");
  expect(entry?.body.equals(body)).toBe(true);
});

it("round trips several files and keeps their order", () => {
  const entries = [
    { name: "one.bin", body: Buffer.from([0, 1, 2, 3]) },
    { name: "two.bin", body: Buffer.alloc(1024, 7) },
    { name: "three.txt", body: Buffer.from("") },
  ];
  const back = unpackTar(packTar(entries));
  expect(back.map((entry) => entry.name)).toEqual(["one.bin", "two.bin", "three.txt"]);
  expect(back[1]?.body.equals(entries[1]!.body)).toBe(true);
  // An empty file is a real case: a zero length body must survive.
  expect(back[2]?.body.length).toBe(0);
});

it("round trips a body that is not a multiple of the block size", () => {
  // 512 is tar's block size, so 513 exercises the padding path.
  const body = Buffer.alloc(513, 9);
  const [entry] = unpackTar(packTar([{ name: "odd.bin", body }]));
  expect(entry?.body.equals(body)).toBe(true);
});

it("round trips binary content with no encoding damage", () => {
  const body = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x0a, 0x0d]);
  const [entry] = unpackTar(packTar([{ name: "raw.bin", body }]));
  expect(entry?.body.equals(body)).toBe(true);
});

it("refuses a name too long for the header rather than truncating it", () => {
  // A truncated name silently restores to the wrong path, which is worse than
  // a refusal an operator can see.
  expect(() => packTar([{ name: "x".repeat(101), body: Buffer.alloc(0) }])).toThrow();
});
