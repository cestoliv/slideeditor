import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, addItem } from "./helpers.mjs";
import { composeDocument, toComposition, outputHeight, validateComposition } from "../server/compose.mjs";

async function fixture(t) {
  const app = createTestApp();
  t.after(() => app.close());
  const { library } = app.services;
  return {
    app,
    library,
    background: await addItem(library, "background", "Backdrop", { width: 1200, height: 1600 }),
    wide: await addItem(library, "asset", "Wide", { width: 800, height: 400 }),
    square: await addItem(library, "asset", "Square", { width: 500, height: 500 }),
    tall: await addItem(library, "asset", "Tall", { width: 400, height: 900 }),
  };
}

/** Everything must sit inside the canvas and clear of the text block. */
function assertWellFormed(document, label) {
  const height = outputHeight(document.ratio);
  for (const [index, slide] of document.slides.entries()) {
    const where = `${label} slide ${index + 1}`;
    for (const overlay of slide.overlays) {
      assert.ok(overlay.x >= -0.001 && overlay.x + overlay.width <= 1.001, `${where}: overlay outside horizontally`);
      assert.ok(overlay.y >= -0.001 && overlay.y + overlay.height <= 1.001, `${where}: overlay outside vertically`);
      assert.ok(overlay.width > 0 && overlay.height > 0, `${where}: overlay has no size`);
    }
    for (const text of slide.texts) {
      assert.ok(text.y >= -0.001 && text.y + text.height <= 1.001, `${where}: text outside vertically`);
    }
    const textTop = slide.texts.length ? Math.min(...slide.texts.map((text) => text.y)) : 1;
    for (const overlay of slide.overlays) {
      assert.ok(overlay.y + overlay.height <= textTop + 0.001, `${where}: overlay overlaps the text block`);
    }
    assert.ok(height > 0);
  }
}

test("computes even output heights from the ratio", () => {
  assert.equal(outputHeight({ w: 9, h: 16 }), 1920);
  assert.equal(outputHeight({ w: 4, h: 5 }), 1350);
  assert.equal(outputHeight({ w: 3, h: 4 }), 1440);
  assert.equal(outputHeight({ w: 1, h: 1 }), 1080);
  assert.equal(outputHeight({ w: 1.91, h: 1 }), 566);
  assert.equal(outputHeight({ w: 1.91, h: 1 }) % 2, 0);
});

test("lays out every ratio without overflow or overlap", async (t) => {
  const f = await fixture(t);
  for (const ratio of [{ w: 9, h: 16 }, { w: 3, h: 4 }, { w: 4, h: 5 }, { w: 1, h: 1 }, { w: 1.91, h: 1 }]) {
    const document = composeDocument({
      ratio,
      library: f.library,
      slides: [
        { background: f.background.id, assets: [f.wide.id], texts: ["Short line"] },
        { background: f.background.id, assets: [f.wide.id, f.square.id, f.tall.id], texts: ["One", "Two", "Three"] },
        { background: f.background.id, assets: [], texts: ["A much longer line that certainly has to wrap more than once on a narrow canvas"] },
        { background: f.background.id, assets: [f.square.id], texts: [] },
      ],
    });
    assertWellFormed(document, `${ratio.w}:${ratio.h}`);
  }
});

test("keeps every asset undistorted", async (t) => {
  const f = await fixture(t);
  const ratio = { w: 4, h: 5 };
  const height = outputHeight(ratio);
  const document = composeDocument({
    ratio,
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.wide.id, f.square.id, f.tall.id], texts: ["Caption"] }],
  });
  const sources = [f.wide, f.square, f.tall];
  document.slides[0].overlays.forEach((overlay, index) => {
    const drawn = (overlay.width * 1080) / (overlay.height * height);
    const source = sources[index].width / sources[index].height;
    assert.ok(Math.abs(drawn - source) < 0.01, `asset ${index} distorted: ${drawn} vs ${source}`);
  });
});

test("gives a partial last row the same item size as a full row", async (t) => {
  const f = await fixture(t);
  const document = composeDocument({
    ratio: { w: 4, h: 5 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.square.id, f.square.id, f.square.id, f.square.id], texts: [] }],
  });
  const widths = document.slides[0].overlays.map((overlay) => overlay.width);
  assert.ok(Math.max(...widths) - Math.min(...widths) < 0.001, `widths drifted: ${widths}`);
});

test("shrinks text rather than running off the canvas", async (t) => {
  const f = await fixture(t);
  const long = "word ".repeat(90).trim();
  const document = composeDocument({
    ratio: { w: 1.91, h: 1 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [], texts: [long, long] }],
  });
  assertWellFormed(document, "long text");
  assert.ok(document.slides[0].texts[0].size <= 64);
});

test("produces identical geometry for identical input", async (t) => {
  const f = await fixture(t);
  const build = () => composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.wide.id, f.square.id], texts: ["Alpha", "Beta"] }],
  });
  const strip = (document) => JSON.stringify(document, (key, value) => (key === "id" ? undefined : value));
  assert.equal(strip(build()), strip(build()));
});

test("leaves an unchanged slide byte-identical on edit", async (t) => {
  const f = await fixture(t);
  const first = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [
      { background: f.background.id, assets: [f.wide.id], texts: ["Keep me"] },
      { background: f.background.id, assets: [f.square.id], texts: ["Change me"] },
    ],
  });
  // Stand in for the human moving things around.
  first.slides[0].overlays[0].x = 0.4321;
  first.slides[0].texts[0].color = "#123456";

  const second = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    previous: first,
    slides: [
      { background: f.background.id, assets: [f.wide.id], texts: ["Keep me"] },
      { background: f.background.id, assets: [f.square.id, f.tall.id], texts: ["Change me", "And add"] },
    ],
  });
  assert.deepEqual(second.slides[0], first.slides[0], "an untouched composition must not be relaid out");
  assert.equal(second.slides[1].overlays.length, 2);
  assert.equal(second.slides[1].texts.length, 2);
});

test("preserves geometry for items that survive a slide edit", async (t) => {
  const f = await fixture(t);
  const first = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.wide.id], texts: ["Stays"] }],
  });
  first.slides[0].overlays[0].x = 0.77;
  first.slides[0].overlays[0].rotation = 31;
  first.slides[0].texts[0].y = 0.11;

  const second = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    previous: first,
    slides: [{ background: f.background.id, assets: [f.wide.id, f.square.id], texts: ["Stays", "New"] }],
  });
  const kept = second.slides[0].overlays.find((overlay) => overlay.itemId === f.wide.id);
  assert.equal(kept.x, 0.77);
  assert.equal(kept.rotation, 31);
  assert.equal(second.slides[0].texts.find((text) => text.text === "Stays").y, 0.11);
});

test("relays out from scratch when the ratio changes", async (t) => {
  const f = await fixture(t);
  const first = composeDocument({
    ratio: { w: 9, h: 16 },
    library: f.library,
    slides: [{ background: f.background.id, assets: [f.wide.id], texts: ["Line"] }],
  });
  first.slides[0].overlays[0].x = 0.77;
  const second = composeDocument({
    ratio: { w: 1, h: 1 },
    library: f.library,
    previous: first,
    slides: [{ background: f.background.id, assets: [f.wide.id], texts: ["Line"] }],
  });
  assert.notEqual(second.slides[0].overlays[0].x, 0.77, "a new ratio invalidates the old geometry");
  assertWellFormed(second, "after ratio change");
});

test("round-trips a composition", async (t) => {
  const f = await fixture(t);
  const slides = [{ background: f.background.id, assets: [f.wide.id, f.square.id], texts: ["One", "Two"] }];
  const document = composeDocument({ ratio: { w: 4, h: 5 }, library: f.library, slides });
  const back = toComposition({ id: "x", name: "n", version: 1, ...document });
  assert.deepEqual(back.slides[0].background, slides[0].background);
  assert.deepEqual(back.slides[0].assets, slides[0].assets);
  assert.deepEqual(back.slides[0].texts, slides[0].texts);
});

test("rejects malformed compositions", () => {
  assert.throws(() => validateComposition([]), (error) => error.status === 400);
  assert.throws(() => validateComposition([{ texts: ["no background"] }]), (error) => error.status === 400);
  assert.throws(() => validateComposition(null), (error) => error.status === 400);
});

test("rejects a ratio outside the supported band", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => composeDocument({ ratio: { w: 1, h: 5 }, library: f.library, slides: [{ background: f.background.id }] }),
    (error) => error.status === 400,
  );
});
