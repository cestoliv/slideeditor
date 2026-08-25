import { expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

it("accepts the password it hashed and refuses any other", () => {
  const stored = hashPassword("correct horse battery staple");
  expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
  expect(verifyPassword("", stored)).toBe(false);
});

it("salts, so the same password hashes differently every time", () => {
  expect(hashPassword("same")).not.toBe(hashPassword("same"));
});

it("records its parameters, so a later release can raise the cost", () => {
  expect(hashPassword("x")).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
});

it("refuses a stored value it cannot read rather than throwing", () => {
  for (const broken of ["", "plain", "scrypt$16384$8$1$onlysalt", "bcrypt$a$b$c$d$e"]) {
    expect(verifyPassword("x", broken)).toBe(false);
  }
});

it("refuses stored parameters scrypt itself rejects, rather than crashing the login that reads them", () => {
  // Six segments, `scrypt` first, integer parameters, a real salt and hash: everything
  // this function checks on its own passes. Only scryptSync's own limits reject these,
  // so this is the only case that reaches the catch in `derive` rather than the earlier
  // parsing checks above.
  const stored = hashPassword("x");
  const [, , blockSize, parallelism, salt, hash] = stored.split("$");
  const withCost = (cost: number) =>
    ["scrypt", cost, blockSize, parallelism, salt, hash].join("$");

  expect(verifyPassword("x", withCost(16383))).toBe(false); // scrypt requires N to be a power of two
  expect(verifyPassword("x", withCost(1))).toBe(false); // scrypt requires N > 1
  expect(verifyPassword("x", withCost(1048576))).toBe(false); // N * r exceeds the 64MB maxmem cap
});
