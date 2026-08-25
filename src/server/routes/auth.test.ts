import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { fixturePassword, makeTempApp } from "../testing.js";

let app: FastifyInstance;
afterEach(async () => app?.close());

const headers = { host: "localhost", origin: "http://localhost" };

const login = (instance: FastifyInstance, password = fixturePassword) =>
  instance.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password },
    headers,
  });

it("reports open mode without a password", async () => {
  app = await makeTempApp();
  expect((await app.inject({ url: "/api/auth/session" })).json()).toEqual({
    authenticated: true,
    mode: "open",
  });
});

it("signs in, reports the session, and signs out", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const response = await login(app);
  expect(response.statusCode).toBe(204);
  const cookie = response.cookies[0];
  expect(cookie?.name).toBe("slide_studio_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite?.toLowerCase()).toBe("lax");

  const cookies = { slide_studio_session: cookie?.value ?? "" };
  expect((await app.inject({ url: "/api/auth/session", cookies })).json()).toEqual({
    authenticated: true,
    mode: "required",
  });

  const out = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    cookies,
    headers,
  });
  expect(out.statusCode).toBe(204);
  expect((await app.inject({ url: "/api/auth/session", cookies })).json()).toEqual({
    authenticated: false,
    mode: "required",
  });
});

it("refuses the wrong password and says nothing useful", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const response = await login(app, "wrong");
  expect(response.statusCode).toBe(401);
  expect(response.json().error).toBe("That password is not right.");
  expect(response.cookies).toHaveLength(0);
});

it("changes the password and ends every other session", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const first = (await login(app)).cookies[0]?.value ?? "";
  const second = (await login(app)).cookies[0]?.value ?? "";

  const changed = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { current: fixturePassword, next: "a-much-longer-one" },
    cookies: { slide_studio_session: second },
    headers,
  });
  expect(changed.statusCode).toBe(204);

  const stale = await app.inject({
    url: "/api/auth/session",
    cookies: { slide_studio_session: first },
  });
  expect(stale.json().authenticated).toBe(false);
  expect((await login(app, "a-much-longer-one")).statusCode).toBe(204);
});

it("refuses an empty next password, leaving the old one working", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const cookie = (await login(app)).cookies[0]?.value ?? "";
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { current: fixturePassword, next: "" },
    cookies: { slide_studio_session: cookie },
    headers,
  });
  expect(response.statusCode).toBe(400);
  // Proves the rejection did not partially apply: an empty password never
  // becomes the live one, and the old password keeps working.
  expect((await login(app)).statusCode).toBe(204);
});

it("refuses a next password one character short of the minimum", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const cookie = (await login(app)).cookies[0]?.value ?? "";
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { current: fixturePassword, next: "a".repeat(11) },
    cookies: { slide_studio_session: cookie },
    headers,
  });
  expect(response.statusCode).toBe(400);
});

it("accepts a next password exactly at the minimum length", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const cookie = (await login(app)).cookies[0]?.value ?? "";
  const next = "a".repeat(12);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { current: fixturePassword, next },
    cookies: { slide_studio_session: cookie },
    headers,
  });
  expect(response.statusCode).toBe(204);
  expect((await login(app, next)).statusCode).toBe(204);
});

it("refuses a password change that gets the current one wrong", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const cookie = (await login(app)).cookies[0]?.value ?? "";
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { current: "nope", next: "a-much-longer-one" },
    cookies: { slide_studio_session: cookie },
    headers,
  });
  expect(response.statusCode).toBe(401);
});

it("creates, lists and revokes a token, showing the secret once", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const cookies = { slide_studio_session: (await login(app)).cookies[0]?.value ?? "" };

  const created = await app.inject({
    method: "POST",
    url: "/api/auth/tokens",
    payload: { name: "agent" },
    cookies,
    headers,
  });
  expect(created.statusCode).toBe(200);
  const { token, secret } = created.json();
  expect(secret).toMatch(/^sst_/);

  const listed = await app.inject({ url: "/api/auth/tokens", cookies });
  expect(listed.json().tokens).toHaveLength(1);
  // The list must never carry the secret back.
  expect(JSON.stringify(listed.json())).not.toContain(secret);

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/auth/tokens/${token.id}`,
    cookies,
    headers,
  });
  expect(removed.statusCode).toBe(200);
  expect(
    (await app.inject({ url: "/api/auth/tokens", cookies })).json().tokens,
  ).toHaveLength(0);
});

it("reports an unknown token id as a 404", async () => {
  app = await makeTempApp({ password: fixturePassword });
  const cookies = { slide_studio_session: (await login(app)).cookies[0]?.value ?? "" };
  const response = await app.inject({
    method: "DELETE",
    url: "/api/auth/tokens/does-not-exist",
    cookies,
    headers,
  });
  expect(response.statusCode).toBe(404);
});
