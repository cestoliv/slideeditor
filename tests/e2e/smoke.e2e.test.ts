import { expect, it } from "vitest";

it("serves the health check from the real server", async () => {
  const response = await fetch("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, name: "slide-studio" });
});

it("survives a request carrying a custom header", async () => {
  // A cross-origin fetch would have to preflight this header first. The page and
  // the server share an origin now, so there is nothing to preflight and no CORS
  // answer that could hide a real origin bug.
  const response = await fetch("/api/health", {
    headers: { "x-slide-studio-test": "1" },
  });
  expect(response.status).toBe(200);
  // The body is what makes this a proof. Vitest's own page server answers this
  // path with 200 and an index.html, so a status check alone passes with no
  // server behind it at all.
  expect(await response.json()).toEqual({ ok: true, name: "slide-studio" });
});

it("stores an image and hands it back to the browser", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser has no 2d canvas.");
  context.fillStyle = "#3355ff";
  context.fillRect(0, 0, 64, 48);

  const created = await fetch("/api/library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "background",
      name: "Canvas",
      contentType: "image/png",
      data: canvas.toDataURL("image/png"),
      accountId: "default",
    }),
  });
  expect(created.status).toBe(200);
  const { item } = (await created.json()) as {
    item: { url: string; width: number; height: number };
  };
  expect(item).toMatchObject({ width: 64, height: 48 });

  const image = new Image();
  const loaded = new Promise((resolve, reject) => {
    image.addEventListener("load", resolve);
    image.addEventListener("error", () =>
      reject(new Error(`The browser could not load ${item.url}`)),
    );
  });
  image.src = item.url;
  await loaded;
  expect(image.naturalWidth).toBe(64);
});
