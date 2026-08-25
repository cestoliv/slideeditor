import { expect, it } from "vitest";
import { LoginBackoff } from "./backoff.js";

it("stays out of the way until the failures pile up", () => {
  const clock = 0;
  const backoff = new LoginBackoff(() => clock);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(backoff.delayFor("10.0.0.1")).toBe(0);
    backoff.recordFailure("10.0.0.1");
  }
  expect(backoff.delayFor("10.0.0.1")).toBeGreaterThan(0);
});

it("doubles up to a ceiling", () => {
  const clock = 0;
  const backoff = new LoginBackoff(() => clock);
  for (let attempt = 0; attempt < 20; attempt += 1) backoff.recordFailure("10.0.0.1");
  expect(backoff.delayFor("10.0.0.1")).toBe(60_000);
});

it("forgets a success and forgets an old failure", () => {
  let clock = 0;
  const backoff = new LoginBackoff(() => clock);
  for (let attempt = 0; attempt < 8; attempt += 1) backoff.recordFailure("10.0.0.1");
  backoff.recordSuccess("10.0.0.1");
  expect(backoff.delayFor("10.0.0.1")).toBe(0);

  for (let attempt = 0; attempt < 8; attempt += 1) backoff.recordFailure("10.0.0.2");
  clock += 15 * 60 * 1000 + 1;
  expect(backoff.delayFor("10.0.0.2")).toBe(0);
});

it("counts each address separately", () => {
  const clock = 0;
  const backoff = new LoginBackoff(() => clock);
  for (let attempt = 0; attempt < 8; attempt += 1) backoff.recordFailure("10.0.0.1");
  expect(backoff.delayFor("10.0.0.2")).toBe(0);
});

it("caps the Map so distinct IPs cannot grow it without bound", () => {
  const clock = 0;
  const backoff = new LoginBackoff(() => clock);
  for (let i = 0; i < 10_500; i += 1) backoff.recordFailure(`10.0.${i >> 8}.${i & 0xff}`);
  expect(backoff.size).toBeLessThanOrEqual(10_000);
  // Recording a failure right before the cap kicked in a recent offender, so
  // its count survives the sweep rather than being the one dropped.
  for (let attempt = 0; attempt < 4; attempt += 1) backoff.recordFailure("10.0.40.255");
  expect(backoff.delayFor("10.0.40.255")).toBeGreaterThan(0);
});
