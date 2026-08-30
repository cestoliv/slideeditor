import { expect, inject, it } from "vitest";
import "./provided.js";
import { page, userEvent } from "vitest/browser";
import {
  baseUrl,
  createSlideshow,
  editPath,
  openApp,
  seedLibrary,
} from "./setup/fixtures.js";

/*
 * The export chain, end to end, with nothing stubbed.
 *
 * A person marks a slideshow ready in a real browser, the editor renders it and
 * uploads the pixels, an agent asks for the URLs over MCP, and a stranger with
 * no cookie and no token downloads them. Every unit test on this path fakes the
 * hop on either side of it, so this is the only run where the browser that drew
 * the pixels and the bytes a scheduling tool receives are the same pixels.
 */

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

type ToolAnswer = { isError: boolean; text: string };

/** Calls one MCP tool through the proxy and hands back its single text block. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.text();
  // The transport answers a POST as one server-sent event, so the JSON-RPC
  // envelope arrives on a data: line rather than as the whole body.
  const line = body.split("\n").find((candidate) => candidate.startsWith("data:"));
  const envelope = JSON.parse(line === undefined ? body : line.slice(5)) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (envelope.result === undefined) {
    throw new Error(`${name} failed at the protocol: ${envelope.error?.message ?? body}`);
  }
  return {
    isError: envelope.result.isError === true,
    text: envelope.result.content?.[0]?.text ?? "",
  };
}

type ExportSlide = {
  index: number;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

type ExportAnswer = {
  status: string;
  version: number;
  rendered?: number;
  slideCount?: number;
  slides?: ExportSlide[];
};

async function exportSlideshow(id: string, version: number): Promise<ExportAnswer> {
  const answer = await callTool("export_slideshow", { id, version });
  if (answer.isError) throw new Error(`export_slideshow refused: ${answer.text}`);
  return JSON.parse(answer.text) as ExportAnswer;
}

/** The bytes a scheduling tool gets, fetched the way one fetches them. */
async function download(url: string): Promise<Response> {
  // The path, not the absolute URL the tool returned: the page is served by
  // Vitest and forwards /export to the server. credentials: "omit" is the point
  // of the route, so it is stated rather than left to the default.
  return await fetch(new URL(url).pathname, { credentials: "omit" });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The colour at the middle of a PNG, as three channels. */
async function centreColor(blob: Blob): Promise<[number, number, number]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser has no 2d canvas.");
  context.drawImage(bitmap, 0, 0);
  const pixel = context.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data;
  return [pixel[0] ?? -1, pixel[1] ?? -1, pixel[2] ?? -1];
}

it("hands an agent public image URLs once a person marks the slideshow ready", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  // No text and no overlays, so every pixel away from the edges is the
  // background's own colour. That is what makes the order assertion below a
  // statement about which slide the URL serves rather than about a checksum.
  const created = await createSlideshow(baseUrl, {
    name: "Export by URL",
    ratio: { w: 4, h: 5 },
    slides: [{ background: backgrounds[0]!.id }, { background: backgrounds[1]!.id }],
  });

  // Dawn beach and Night market, the colours seedLibrary filled them with.
  const colors: [number, number, number][] = [
    [0xf2, 0xc1, 0x85],
    [0x2b, 0x1b, 0x4a],
  ];

  // A draft is refused before anything is rendered, so the guard is the first
  // thing an agent meets rather than a detail behind a happy path.
  const draft = await callTool("export_slideshow", {
    id: created.id,
    version: created.version,
  });
  expect(draft.isError).toBe(true);
  expect(draft.text).toMatch(/ready/);

  await openApp(editPath(created.editUrl));
  await expect
    .element(page.getByLabelText("Slideshow name"))
    .toHaveValue("Export by URL");

  await userEvent.click(
    page.getByRole("group", { name: "Slideshow status" }).getByRole("button", {
      name: "Ready",
    }),
  );

  // The renders are drawn and uploaded by the tab that was just clicked, so the
  // export stays pending until that round trip lands.
  let answer: ExportAnswer = { status: "unasked", version: created.version };
  await expect
    .poll(
      async () => {
        answer = await exportSlideshow(created.id, created.version);
        return answer.status;
      },
      { timeout: 20000 },
    )
    .toBe("ready");

  const slides = answer.slides ?? [];
  expect(slides).toHaveLength(2);
  expect(slides.map((slide) => slide.index)).toEqual([1, 2]);

  for (const [position, slide] of slides.entries()) {
    const label = `slide ${String(slide.index)}`;
    // The whole URL, against the origin the server was told to mint against. A
    // token short of 64 hex characters is a credential this assertion refuses.
    const origin = inject("e2eOrigin").replaceAll(".", "\\.");
    expect(slide.url, label).toMatch(
      new RegExp(`^${origin}/export/[0-9a-f]{64}/0${String(slide.index)}\\.png$`),
    );

    const response = await download(slide.url);
    expect(response.status, label).toBe(200);
    expect(response.headers.get("content-type"), label).toBe("image/png");
    expect(response.headers.get("x-robots-tag"), label).toBe("noindex, nofollow");

    const bytes = await response.arrayBuffer();
    // The three fields an agent checks its upload against, checked against the
    // file itself rather than against the row that described it.
    expect(bytes.byteLength, label).toBe(slide.bytes);
    expect(await sha256Hex(bytes), label).toBe(slide.sha256);

    const blob = new Blob([bytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    expect([bitmap.width, bitmap.height], label).toEqual([slide.width, slide.height]);
    expect([bitmap.width, bitmap.height], label).toEqual([1080, 1350]);

    // Which slide this URL serves. A renderer that published the slides in the
    // wrong order passes everything above and fails here.
    const centre = await centreColor(blob);
    const expected = colors[position]!;
    for (const channel of [0, 1, 2]) {
      // Scaling a solid fill leaves the middle of the image exact, so the
      // tolerance covers an 8 bit round trip and nothing wider.
      const drift = Math.abs(centre[channel]! - expected[channel]!);
      expect(drift, `${label} channel ${String(channel)}`).toBeLessThanOrEqual(2);
    }
  }

  // Revoking ends the grant and keeps the pixels, which is the promise that
  // lets an agent revoke the moment the import finishes.
  const first = slides[0]!;
  const revoked = await callTool("revoke_export", { id: created.id });
  expect(revoked.isError).toBe(false);
  expect((JSON.parse(revoked.text) as { revoked: number }).revoked).toBeGreaterThan(0);
  expect((await download(first.url)).status).toBe(404);

  const again = await exportSlideshow(created.id, created.version);
  expect(again.status).toBe("ready");
  const reissued = again.slides?.[0];
  expect(reissued?.url).not.toBe(first.url);
  expect(reissued?.sha256).toBe(first.sha256);
  expect((await download(reissued!.url)).status).toBe(200);
});
