import { afterEach, expect, it } from "vitest";
import {
  addItem,
  asHttpError,
  catchError,
  createTestApp,
  solidPng,
  type TestApp,
} from "../testing.js";

let app: TestApp | undefined;
afterEach(() => {
  app?.close();
  app = undefined;
});

it("lists only the projects in the requested account", () => {
  app = createTestApp();
  const { projects, accounts } = app.services;
  const defaults = accounts.require("default").defaults;
  const other = accounts.create({ name: "Other", defaults });
  projects.create({ name: "In default", accountId: "default" });
  projects.create({ name: "In other", accountId: other.id });

  const defaultOnly = projects.list({ accountId: "default" });
  expect(defaultOnly.map((p) => p.name)).toEqual(["In default"]);
  expect(defaultOnly[0]?.accountId).toBe("default");

  const otherOnly = projects.list({ accountId: other.id });
  expect(otherOnly.map((p) => p.name)).toEqual(["In other"]);

  expect(projects.list({}).length).toBe(2);
});

it("rejects creating a project in an unknown account", async () => {
  app = createTestApp();
  const { projects } = app.services;
  const error = asHttpError(
    await catchError(() => projects.create({ name: "Ghost", accountId: "nope" })),
  );
  expect(error.status).toBe(400);
});

it("stamps a library item with its account and lists only that account's items", async () => {
  app = createTestApp();
  const { library, accounts } = app.services;
  const defaults = accounts.require("default").defaults;
  const other = accounts.create({ name: "Other", defaults });
  const inDefault = await addItem(library, "asset", "In default", {
    accountId: "default",
  });
  const inOther = await addItem(library, "asset", "In other", { accountId: other.id });

  expect(inDefault.accountId).toBe("default");
  expect(inOther.accountId).toBe(other.id);

  const defaultOnly = library.list({ accountId: "default" });
  expect(defaultOnly.items.map((item) => item.id)).toEqual([inDefault.id]);
  expect(defaultOnly.total).toBe(1);

  expect(library.list({}).total).toBe(2);
});

it("rejects creating a library item in an unknown account", async () => {
  app = createTestApp();
  const { library } = app.services;
  const error = asHttpError(
    await catchError(() =>
      library.create({
        kind: "asset",
        name: "Ghost",
        contentType: "image/png",
        bytes: solidPng(10, 10),
        accountId: "nope",
      }),
    ),
  );
  expect(error.status).toBe(400);
});
