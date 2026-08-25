import { describe, expect, it } from "vitest";
import { DEFAULT_RATIO, parseDocument } from "./document.js";

describe("parseDocument", () => {
  it("returns the default ratio when the ratio is missing", () => {
    expect(parseDocument({}).ratio).toEqual(DEFAULT_RATIO);
  });

  it("rejects a zero ratio and falls back", () => {
    expect(parseDocument({ ratio: { w: 0, h: 5 } }).ratio).toEqual(DEFAULT_RATIO);
  });

  it("coerces a numeric ratio given as a string, matching normalizeDocument's Number() call", () => {
    expect(parseDocument({ ratio: { w: "4", h: "5" } }).ratio).toEqual({ w: 4, h: 5 });
  });

  it("fills the background pan and zoom defaults", () => {
    const document = parseDocument({
      slides: [
        { id: "s1", name: "Slide 1", backgroundItemId: "b1", width: 100, height: 200 },
      ],
    });
    const slide = document.slides[0]!;
    expect(slide.imageScale).toBe(1);
    expect(slide.imageX).toBe(0);
    expect(slide.imageY).toBe(0);
    expect(slide.overlays).toEqual([]);
    expect(slide.texts).toEqual([]);
  });

  it("fills the text layer defaults the old app back-filled at load", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          name: "Slide 1",
          backgroundItemId: "b1",
          width: 100,
          height: 200,
          texts: [
            {
              id: "t1",
              text: "hello",
              x: 0.06,
              y: 0.5,
              width: 0.88,
              height: 0.1,
              size: 48,
            },
          ],
        },
      ],
    });
    const text = document.slides[0]!.texts[0]!;
    expect(text.style).toBe("plain");
    expect(text.color).toBe("#FFFFFF");
    expect(text.background).toBe("white");
    expect(text.backgroundShape).toBe("full");
    expect(text.align).toBe("center");
    expect(text.rotation).toBe(0);
  });

  /*
   * outlineWidth was modelled here and defaulted to 12 (app.js:128) until Task
   * 16 retired it. Neither render path ever read it: both derive the stroke
   * from fontSize * OUTLINE_RATIO (app.js:2872, app.js:4493, and
   * computeTextLayout). Saved slideshows still carry the key, so this pins what
   * happens to one: the parse succeeds and the key is dropped, because
   * documentSchema is a plain z.object. The migration is one way and needs no
   * step of its own, and an older app.js reading such a document simply
   * back-fills 12 again.
   */
  it("drops the retired outlineWidth a saved slideshow still carries", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [{ id: "t1", text: "hello", size: 48, outlineWidth: 8 }],
        },
      ],
    });
    const text = document.slides[0]!.texts[0]!;
    expect(text).not.toHaveProperty("outlineWidth");
    // The rest of the layer is untouched, so this is a dropped key rather than
    // a rejected layer.
    expect(text.text).toBe("hello");
    expect(text.size).toBe(48);
  });

  it("assigns z-order by position, overlays before texts", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          name: "Slide 1",
          backgroundItemId: "b1",
          width: 100,
          height: 200,
          overlays: [{ id: "o1", itemId: "a1", x: 0, y: 0, width: 0.3, height: 0.3 }],
          texts: [
            { id: "t1", text: "hello", x: 0, y: 0, width: 0.5, height: 0.1, size: 48 },
          ],
        },
      ],
    });
    expect(document.slides[0]!.overlays[0]!.z).toBe(1);
    expect(document.slides[0]!.texts[0]!.z).toBe(2);
  });

  it("drops a slide with no background rather than rendering it wrong", () => {
    expect(parseDocument({ slides: [{ id: "s1" }] }).slides).toEqual([]);
  });

  // Critical 1: normalizeDocument (server/projects.mjs:160-161) guards against
  // a stored document column that parsed as valid JSON but not an object.
  // parseDocument must repair the same way instead of throwing.
  it.each([null, undefined, "hello", 42, [], [1, 2, 3]])(
    "never throws on non-object input: %p",
    (value) => {
      expect(() => parseDocument(value)).not.toThrow();
      expect(parseDocument(value)).toEqual({ ratio: DEFAULT_RATIO, slides: [] });
    },
  );

  // Critical 2: a boxed text with no stored color must default to dark text
  // on anything but a black box (app.js:232-235, textColor's legacyDefault),
  // not white-on-white. Before this fix, the flat `.catch("#FFFFFF")` on the
  // color field returned "#FFFFFF" for every one of these, painting the two
  // "white"/default-background cases invisible.
  it("defaults a boxed text's missing color to dark on a white box, not white-on-white", () => {
    const withDefaultBackground = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [
            {
              id: "t1",
              text: "hi",
              x: 0,
              y: 0,
              width: 0.5,
              height: 0.1,
              size: 48,
              style: "boxed",
            },
          ],
        },
      ],
    });
    expect(withDefaultBackground.slides[0]!.texts[0]!.color).toBe("#111111");

    const withWhiteBackground = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [
            {
              id: "t1",
              text: "hi",
              x: 0,
              y: 0,
              width: 0.5,
              height: 0.1,
              size: 48,
              style: "boxed",
              background: "white",
            },
          ],
        },
      ],
    });
    expect(withWhiteBackground.slides[0]!.texts[0]!.color).toBe("#111111");
  });

  it("defaults a boxed text's missing color to white on a black box", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [
            {
              id: "t1",
              text: "hi",
              x: 0,
              y: 0,
              width: 0.5,
              height: 0.1,
              size: 48,
              style: "boxed",
              background: "black",
            },
          ],
        },
      ],
    });
    expect(document.slides[0]!.texts[0]!.color).toBe("#FFFFFF");
  });

  it("defaults a non-boxed text's missing color to white", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [
            { id: "t1", text: "hi", x: 0, y: 0, width: 0.5, height: 0.1, size: 48 },
          ],
        },
      ],
    });
    expect(document.slides[0]!.texts[0]!.color).toBe("#FFFFFF");
  });

  // Important 3: normalizeHexColor (app.js:226-230) accepts 3-digit and
  // unprefixed hex. Before this fix, the schema's `/^#[0-9a-fA-F]{6}$/` regex
  // rejected both and silently replaced the user's color with the fallback.
  it("expands a 3-digit hex color and normalizes an unprefixed one", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [
            {
              id: "t1",
              text: "hi",
              x: 0,
              y: 0,
              width: 0.5,
              height: 0.1,
              size: 48,
              color: "#abc",
            },
            {
              id: "t2",
              text: "hi",
              x: 0,
              y: 0,
              width: 0.5,
              height: 0.1,
              size: 48,
              color: "ffcc00",
            },
          ],
        },
      ],
    });
    expect(document.slides[0]!.texts[0]!.color).toBe("#AABBCC");
    expect(document.slides[0]!.texts[1]!.color).toBe("#FFCC00");
  });

  // Important 4: hydrateProject (app.js:312-313) falls back to 1080x1920, not
  // 0. Before this fix, a missing width/height defaulted to 0, which divides
  // by zero in every downstream aspect and pan/zoom computation.
  it("defaults a missing slide width and height to 1080x1920", () => {
    const document = parseDocument({ slides: [{ id: "s1", backgroundItemId: "b1" }] });
    expect(document.slides[0]!.width).toBe(1080);
    expect(document.slides[0]!.height).toBe(1920);
  });

  // Important 5: parseDocument has no library, so it cannot compute a missing
  // overlay height from the asset's aspect the way app.js:119-123 does.
  // Leaving it unset lets a consumer with library access fill it in, rather
  // than inventing a flat value that stretches or squashes the asset. Before
  // this fix, a missing height silently became 0.3.
  it("leaves a missing overlay height unset rather than inventing one", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          overlays: [{ id: "o1", itemId: "a1", x: 0, y: 0, width: 0.3 }],
        },
      ],
    });
    expect(document.slides[0]!.overlays[0]!.height).toBeUndefined();
  });

  it("defaults a missing overlay width to 0.34, matching constrainOverlay's fallback", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          overlays: [{ id: "o1", itemId: "a1", x: 0, y: 0, height: 0.3 }],
        },
      ],
    });
    expect(document.slides[0]!.overlays[0]!.width).toBe(0.34);
  });

  // Deviation (b): one bad overlay or text is dropped, not the whole array.
  it("drops a malformed overlay without losing its siblings", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          overlays: [{ id: "o1", itemId: "a1", x: 0, y: 0 }, { itemId: "missing-id" }],
        },
      ],
    });
    expect(document.slides[0]!.overlays).toHaveLength(1);
    expect(document.slides[0]!.overlays[0]!.id).toBe("o1");
  });

  it("drops a malformed text without losing its siblings", () => {
    const document = parseDocument({
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          texts: [
            { id: "t1", text: "keep me", x: 0, y: 0, width: 0.5, height: 0.1, size: 48 },
            { text: "no id" },
          ],
        },
      ],
    });
    expect(document.slides[0]!.texts).toHaveLength(1);
    expect(document.slides[0]!.texts[0]!.id).toBe("t1");
  });

  // A fully populated document survives a parse untouched: no field is
  // dropped, coerced or reshaped. It says nothing about the defaults, because
  // a fixture that sets every field never fires one. Mutating a default to a
  // wrong value leaves this test green, so the cases above are what guard
  // those, and this one guards the shape.
  it("round-trips a real, varied document shape unchanged", () => {
    const real = {
      ratio: { w: 4, h: 5 },
      slides: [
        {
          id: "s1",
          name: "Slide 1",
          backgroundItemId: "b1",
          width: 1080,
          height: 1350,
          imageScale: 1.2,
          imageX: 10,
          imageY: -5,
          overlays: [
            {
              id: "o1",
              itemId: "a1",
              x: 0.1,
              y: 0.2,
              width: 0.3,
              height: 0.3,
              rotation: 5,
              cropX: 0.25,
              cropY: 0.1,
              cropW: 0.5,
              cropH: 0.6,
              z: 1,
            },
          ],
          texts: [
            {
              id: "t1",
              text: "hello",
              x: 0.06,
              y: 0.5,
              width: 0.88,
              height: 0.1,
              size: 48,
              style: "boxed",
              color: "#111111",
              background: "white",
              backgroundShape: "lines",
              align: "left",
              rotation: 0,
              z: 2,
            },
            {
              id: "t2",
              text: "world",
              x: 0.06,
              y: 0.65,
              width: 0.88,
              height: 0.1,
              size: 36,
              style: "outline",
              color: "#FFFFFF",
              background: "black",
              backgroundShape: "full",
              align: "right",
              rotation: 12,
              z: 3,
            },
          ],
        },
        {
          id: "s2",
          name: "Slide 2",
          backgroundItemId: "b2",
          width: 1080,
          height: 1350,
          imageScale: 1,
          imageX: 0,
          imageY: 0,
          overlays: [],
          texts: [
            {
              id: "t3",
              text: "plain center",
              x: 0.06,
              y: 0.5,
              width: 0.88,
              height: 0.1,
              size: 48,
              style: "plain",
              color: "#FFFFFF",
              background: "white",
              backgroundShape: "full",
              align: "center",
              rotation: 0,
              z: 1,
            },
          ],
        },
      ],
    };
    expect(parseDocument(structuredClone(real))).toStrictEqual(real);
  });
});
