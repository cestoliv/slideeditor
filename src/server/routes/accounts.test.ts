import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTempApp } from "../testing.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeTempApp();
});

afterEach(async () => {
  await app.close();
});

const sampleDefaults = {
  ratio: { w: 9, h: 16 },
  text: {
    fontFamily: "TikTok Sans",
    size: 64,
    style: "plain",
    color: "#FFFFFF",
    background: "white",
    backgroundShape: "lines",
    align: "center",
  },
};

it("lists the seeded default account", async () => {
  const response = await app.inject({ method: "GET", url: "/api/accounts" });
  expect(response.statusCode).toBe(200);
  const ids = response.json().accounts.map((account: { id: string }) => account.id);
  expect(ids).toContain("default");
});

it("creates and reads back an account", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: { name: "Brand B", defaults: sampleDefaults },
  });
  expect(create.statusCode).toBe(200);
  const id = create.json().account.id;

  const read = await app.inject({ method: "GET", url: `/api/accounts/${id}` });
  expect(read.statusCode).toBe(200);
  expect(read.json().account.name).toBe("Brand B");
});

it("updates an account's name", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: { name: "Brand C", defaults: sampleDefaults },
  });
  const id = create.json().account.id;

  const update = await app.inject({
    method: "PUT",
    url: `/api/accounts/${id}`,
    payload: { name: "Brand C Renamed" },
  });
  expect(update.statusCode).toBe(200);
  expect(update.json().account.name).toBe("Brand C Renamed");
});

it("deletes an empty account", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: { name: "Throwaway", defaults: sampleDefaults },
  });
  const id = create.json().account.id;

  const remove = await app.inject({ method: "DELETE", url: `/api/accounts/${id}` });
  expect(remove.statusCode).toBe(200);

  const read = await app.inject({ method: "GET", url: `/api/accounts/${id}` });
  expect(read.statusCode).toBe(404);
});

// composeDocument's normalizeRatio (shared/compose/compose.ts) throws outside
// 0.4:1-2.5:1, so an account whose default sat outside it used to save fine
// and only fail later, on the first create_slideshow/save that omitted its
// own ratio.
it("rejects an account default ratio outside what compose will ever lay out", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: {
      name: "Too Narrow",
      defaults: { ...sampleDefaults, ratio: { w: 1, h: 4 } },
    },
  });
  expect(response.statusCode).toBe(400);
});

// Finding 1: text.size used to be a bare z.number().catch(64), so this used
// to 200 and every later create_slideshow for the account composed invisible
// (size 0) or upside-down, negative-height (size -400) text layers with no
// error anywhere.
it("rejects an account default text size of 0", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: {
      name: "Invisible Text",
      defaults: { ...sampleDefaults, text: { ...sampleDefaults.text, size: 0 } },
    },
  });
  expect(response.statusCode).toBe(400);
});

it("rejects a negative account default text size", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: {
      name: "Negative Text",
      defaults: { ...sampleDefaults, text: { ...sampleDefaults.text, size: -400 } },
    },
  });
  expect(response.statusCode).toBe(400);
});

it("rejects an absurdly large account default text size", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: {
      name: "Giant Text",
      defaults: { ...sampleDefaults, text: { ...sampleDefaults.text, size: 1_000_000 } },
    },
  });
  expect(response.statusCode).toBe(400);
});

// A bearer token, a curl, or an agent has nothing else stopping it: the admin
// UI only disabled its own delete control at one account, "no opinion" on the
// server's part by its own comment.
it("refuses to delete the last account", async () => {
  const list = await app.inject({ method: "GET", url: "/api/accounts" });
  expect(list.json().accounts).toHaveLength(1);
  const id = String(list.json().accounts[0].id);

  const remove = await app.inject({ method: "DELETE", url: `/api/accounts/${id}` });
  expect(remove.statusCode).toBe(409);

  const read = await app.inject({ method: "GET", url: `/api/accounts/${id}` });
  expect(read.statusCode).toBe(200);
});

it("allows deleting an account once a second one exists", async () => {
  const list = await app.inject({ method: "GET", url: "/api/accounts" });
  const defaultId = String(list.json().accounts[0].id);

  await app.inject({
    method: "POST",
    url: "/api/accounts",
    payload: { name: "Second", defaults: sampleDefaults },
  });

  const remove = await app.inject({
    method: "DELETE",
    url: `/api/accounts/${defaultId}`,
  });
  expect(remove.statusCode).toBe(200);
});
