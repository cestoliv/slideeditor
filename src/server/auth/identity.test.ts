import { expect, it } from "vitest";
import { bearerFrom, guardFor, isOriginAllowed } from "./identity.js";

it("names the guard each path needs", () => {
  expect(guardFor("/api/health")).toBe("none");
  expect(guardFor("/api/auth/session")).toBe("none");
  expect(guardFor("/api/auth/login")).toBe("none");
  expect(guardFor("/api/auth/logout")).toBe("session");
  expect(guardFor("/api/auth/tokens")).toBe("session");
  expect(guardFor("/api/auth/tokens/abc")).toBe("session");
  expect(guardFor("/api/auth/password")).toBe("session");
  expect(guardFor("/mcp")).toBe("token");
  expect(guardFor("/api/projects")).toBe("any");
  expect(guardFor("/media/abc.png")).toBe("any");
  expect(guardFor("/")).toBe("none");
  expect(guardFor("/assets/index.js")).toBe("none");
  // Deliberately public: the two bundled font binaries under assets/, named
  // by the login screen before any credential exists — unlike /media/, which
  // also serves uploaded library images through the same URL shape.
  expect(guardFor("/fonts/tiktok-sans.ttf")).toBe("none");
});

it("leaves the export links public, because a third party fetches them", () => {
  expect(guardFor("/export/abc123/01.png")).toBe("none");
  expect(guardFor("/EXPORT/abc123/01.png")).toBe("none");
});

it("still guards media, which the same token cannot open publicly", () => {
  expect(guardFor("/media/abc.png")).toBe("any");
});

it("ignores the query string when naming a guard", () => {
  expect(guardFor("/api/projects?status=draft")).toBe("any");
});

it("is case-insensitive, so a case-normalising proxy cannot open a path", () => {
  expect(guardFor("/MEDIA/x.png")).toBe("any");
  expect(guardFor("/API/projects")).toBe("any");
});

it("reads a bearer token out of the header and nowhere else", () => {
  expect(bearerFrom("Bearer sst_abc")).toBe("sst_abc");
  expect(bearerFrom("bearer   sst_abc  ")).toBe("sst_abc");
  expect(bearerFrom("Basic sst_abc")).toBe("");
  expect(bearerFrom(undefined)).toBe("");
});

it("accepts an Origin matching the Host and refuses anything else", () => {
  expect(isOriginAllowed("https://studio.example.com", "studio.example.com")).toBe(true);
  expect(isOriginAllowed("http://localhost:4173", "localhost:4173")).toBe(true);
  expect(isOriginAllowed("https://evil.example.com", "studio.example.com")).toBe(false);
  expect(isOriginAllowed("null", "studio.example.com")).toBe(false);
  // A same-origin fetch from an older browser may send no Origin at all.
  expect(isOriginAllowed(undefined, "studio.example.com")).toBe(true);
});

it("strips a Host header's explicit default port before comparing", () => {
  expect(isOriginAllowed("https://example.com", "example.com:443")).toBe(true);
  expect(isOriginAllowed("http://example.com", "example.com:80")).toBe(true);
  // A genuinely different port is still a different origin.
  expect(isOriginAllowed("https://example.com", "example.com:8443")).toBe(false);
});
