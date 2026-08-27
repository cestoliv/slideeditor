import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "../../../design/tokens.css";
import "../../../design/reset.css";
// Finding 3: injectFontFaces() now deliberately skips re-declaring TikTok
// Sans (it is already declared here, statically, pointed at Vite's
// fingerprinted bundle asset — main.tsx imports this same file for exactly
// that reason). Without it, nothing in this file's DOM would declare a face
// for TikTok Sans at all, and assertFaceLoaded (below) would fail for every
// fixture that uses the app's own default family.
import "../../../design/fonts.css";
import "./testFonts.css";
import { DEFAULT_FONT_FAMILY, TEXT_WEIGHT, textFontString } from "@shared/text/index.js";
import {
  BUILTIN_DEFAULTS,
  DEFAULT_ACCOUNT_ID,
  parseProject,
} from "@shared/schema/index.js";
import type { LibraryItem, Project, Slide } from "@shared/schema/index.js";
import { injectFontFaces, weightFor } from "../../../app/fontFaces.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";
import { EditorStore } from "../store.js";
import { Stage } from "../Stage.js";
import { useLayerStack } from "../layers/LayerStack.js";
import { roundedRectPath } from "../text/renderTextDom.js";
import { renderSlideCanvas } from "./render.js";
import {
  diffRatio,
  gradientImage,
  layoutAt,
  libraryItem,
  normalise,
  screenshotDataUrl,
} from "./testing.js";

/*
 * The test the whole rewrite exists to make possible.
 *
 * Slide Studio draws every slide twice, as DOM and SVG on the stage and onto a
 * canvas for the PNG. In the app this replaces, those two paths worked the same
 * geometry out separately and drifted, so what the editor showed was not what
 * the export wrote. Both paths now read one TextLayout and one geometry module,
 * and this is what holds them to it.
 *
 * Each case renders the real stage, screenshots it, renders the same slide
 * through renderSlideCanvas, resamples both to 540 wide, and counts the pixels
 * that disagree. Nothing is compared against a stored baseline, so no PNG is
 * committed and a macOS run and a Linux run measure the same thing.
 */

// Each case mounts its own stage, so the one before it has to come down. Two
// stages on screen would leave the screenshot pointing at the older one.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The two measurements, and why there are two.
 *
 * TOLERANCE is the brief's own budget: the share of pixels that differ by more
 * than twelve on any channel. Nearly all of it is antialiasing. The stage
 * rasterises a glyph through the DOM at a third of the export's scale and the
 * export rasterises it through fillText at 1080, and the two shade the edge of
 * every stroke differently. That noise floor sits around one per cent on a
 * text fixture, which leaves this measurement too blunt to see a layer that
 * moved: shifting a text by 21.6 export pixels, half again the corner-radius
 * drift the deleted pixel floors used to cause, lifts it only to 1.8 per cent.
 *
 * HARD_TOLERANCE is the one that sees geometry. A pixel counts only when a
 * channel moves by more than HARD_CHANNEL, which no antialiasing difference
 * reaches and every displaced glyph does, because a displaced glyph puts ink
 * where the photo was. The noise floor drops by a factor of four and the
 * signal barely moves, which is what makes the negative controls below fail by
 * a margin rather than by a hair.
 *
 * What neither one can see, measured rather than guessed: a text moved by two
 * export pixels, and a single pill corner squared off. A corner radius at a 34
 * pixel font covers about nine pixels of the comparison grid out of half a
 * million, so no whole-frame count will ever resolve one. That is not what
 * holds the corners together. There is one lineCornerRadii, both renderers
 * read it, and src/shared/text/pill.test.ts is where its arithmetic is
 * defended. This file defends the thing a shared module cannot: that the two
 * renderers actually draw what it returns.
 */
const TOLERANCE = 0.02;
const HARD_CHANNEL = 120;
const HARD_TOLERANCE = 0.008;

/** Both renders are resampled to this grid before they are compared. */
const COMPARE_WIDTH = 540;
const COMPARE_HEIGHT = 960;

const BACKGROUND = gradientImage(540, 960, "#1b3a6b", "#d9a441");
const OVERLAY_IMAGE = gradientImage(400, 400, "#2f8f5b", "#f0e6c8");

type TextSeed = Record<string, unknown>;
type OverlaySeed = Record<string, unknown>;

function text(overrides: TextSeed): TextSeed {
  return {
    id: "text-1",
    text: "Ship it",
    x: 0.08,
    y: 0.42,
    width: 0.84,
    height: 0.16,
    size: 96,
    style: "plain",
    outlineWidth: 12,
    color: "#FFFFFF",
    background: "white",
    backgroundShape: "full",
    align: "center",
    fontFamily: "TikTok Sans",
    rotation: 0,
    z: 2,
    ...overrides,
  };
}

function overlay(overrides: OverlaySeed): OverlaySeed {
  return {
    id: "overlay-1",
    itemId: "overlay",
    x: 0.12,
    y: 0.1,
    width: 0.5,
    height: 0.25,
    rotation: 0,
    cropX: 0,
    cropY: 0,
    cropW: 1,
    cropH: 1,
    z: 1,
    ...overrides,
  };
}

function projectWith(layers: { texts?: TextSeed[]; overlays?: OverlaySeed[] }): Project {
  return parseProject({
    id: "project-1",
    name: "Parity",
    version: 1,
    status: "draft",
    accountId: DEFAULT_ACCOUNT_ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ratio: { w: 9, h: 16 },
    slides: [
      {
        id: "slide-1",
        backgroundItemId: "background",
        name: "One",
        width: 540,
        height: 960,
        imageScale: 1,
        imageX: 0,
        imageY: 0,
        overlays: layers.overlays ?? [],
        texts: layers.texts ?? [],
      },
    ],
  });
}

function libraryIndex(): LibraryIndex {
  const items = new Map<string, LibraryItem>([
    ["background", libraryItem("background", BACKGROUND, 540, 960)],
    ["overlay", libraryItem("overlay", OVERLAY_IMAGE, 400, 400)],
  ]);
  return items;
}

/*
 * The size the stage is photographed at.
 *
 * Vitest runs a test inside an iframe on a 1280 by 720 page, and it scales that
 * iframe down whenever its viewport is larger than the page. A screenshot then
 * carries the scaled raster rather than the stage, so a taller viewport buys a
 * blurrier picture rather than a bigger one. These two numbers keep the iframe
 * at its own scale, which makes the capture one device pixel per CSS pixel.
 */
const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 716;
const HARNESS_WIDTH = 980;
const HARNESS_HEIGHT = 700;

/*
 * The real composition: Stage holding the real layer stack. A stand-in for
 * either half would prove nothing about the halves the app ships.
 */
function ParityHarness({
  store,
  library,
}: {
  store: EditorStore;
  library: LibraryIndex;
}) {
  const { layers, onFinishCrop } = useLayerStack({
    store,
    library,
    defaults: BUILTIN_DEFAULTS,
  });
  return (
    <div
      style={{
        width: `${String(HARNESS_WIDTH)}px`,
        height: `${String(HARNESS_HEIGHT)}px`,
        display: "grid",
      }}
    >
      <Stage store={store} library={library} onFinishCrop={onFinishCrop}>
        {layers}
      </Stage>
    </div>
  );
}

type Mounted = {
  slide: Slide;
  frame: Element;
  library: LibraryIndex;
  /**
   * The stage as the layer stack measured it, unrounded.
   *
   * This is the pair useTextLayout divided by, published on the stack's own
   * dataset, so a test that recomputes the layout from these two numbers
   * recomputes exactly what the DOM was handed. A bounding rect would be close
   * and not equal.
   */
  stage: { width: number; height: number };
};

/**
 * The Vite-served paths testFonts.css's `@assets/SpaceMono.ttf` and
 * design/fonts.css's own `@assets/TikTokSans.ttf` resolve to, confirmed by
 * reading the registered CSSFontFaceRule back out of document.styleSheets.
 * weightFor's catalogue, and every @font-face rule faceRule() emits, only
 * exist once injectFontFaces() has fetched and parsed one, so this hands it
 * entries that point at the same real, already-working files rather than
 * invented ones that would leave document.fonts holding a second, broken
 * declaration alongside the real one.
 */
const SPACE_MONO_URL = "/assets/SpaceMono.ttf";
const TIKTOK_SANS_URL = "/assets/TikTokSans.ttf";

type CatalogueFontEntry = {
  id: string;
  family: string;
  weight: number;
  weightMin: number | null;
  weightMax: number | null;
  source: "google" | "builtin";
  url: string;
};

/**
 * Makes weightFor("Space Mono") return its true catalogued weight, 400,
 * instead of the TEXT_WEIGHT fallback, 500, that every fixture and the meta-
 * test below got before this stub existed.
 *
 * TikTok Sans is catalogued too, with its real weightMin/weightMax (300/900),
 * even though finding 3 makes injectFontFaces() skip re-declaring this exact
 * family from the fetched catalogue — the STATIC @font-face design/fonts.css
 * imports above already covers it, with the same range, so nothing here
 * ever measures against an invented face. This entry still earns its place:
 * without it, "TikTok Sans" would drop out of `cataloguedFamilies` below and
 * mount()'s assertFaceLoaded would silently stop checking it, rather than
 * verifying the static face genuinely reaches "loaded" the way every other
 * catalogued family here is checked.
 *
 * A caller passing its own entries is deliberately not restricted to these
 * two families — see DEFAULT_CATALOGUE's own comment for why mount() needs
 * that.
 */
const DEFAULT_CATALOGUE: CatalogueFontEntry[] = [
  {
    id: "space-mono",
    family: "Space Mono",
    weight: 400,
    weightMin: null,
    weightMax: null,
    source: "google",
    url: SPACE_MONO_URL,
  },
  {
    id: "tiktok-sans",
    family: "TikTok Sans",
    weight: TEXT_WEIGHT,
    weightMin: 300,
    weightMax: 900,
    source: "builtin",
    url: TIKTOK_SANS_URL,
  },
];

async function stubFontCatalogue(
  catalogue: CatalogueFontEntry[] = DEFAULT_CATALOGUE,
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ fonts: catalogue }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  await injectFontFaces();
}

/**
 * Finding 10 (fix round 3): `document.fonts.load()` then `.ready` both
 * resolve happily whether or not the face's `src` actually loaded — a
 * FontFaceSet with no matching face just falls back to a system font, with
 * no rejection and no thrown error. TIKTOK_SANS_URL above is a bare string
 * this file never verifies against a real Vite-served path (unlike
 * SPACE_MONO_URL, whose own comment says as much): if it ever stopped
 * resolving — the asset moved, the alias changed — every family here would
 * silently render in the same substitute system font on both the DOM and
 * the canvas path, and this whole suite would keep passing while measuring
 * two renderers agreeing on nothing this feature actually shipped.
 *
 * Iterates `document.fonts` directly rather than calling `.check()`: check()
 * only promises a face the UA COULD supply for the string matches, which a
 * system fallback can satisfy too, so it cannot tell "loaded for real" apart
 * from "quietly gave up and substituted".
 */
async function assertFaceLoaded(family: string): Promise<void> {
  const faces = [...document.fonts].filter(
    (face) => face.family.replace(/^["']|["']$/g, "") === family,
  );
  expect(
    faces.length,
    `no @font-face was ever registered for "${family}"`,
  ).toBeGreaterThan(0);
  const loaded = faces.filter((face) => face.status === "loaded");
  expect(
    loaded.length,
    `"${family}" registered ${String(faces.length)} face(s) but none reached "loaded" — its src likely 404s`,
  ).toBeGreaterThan(0);
}

/**
 * Puts the stage on screen and waits until it is worth photographing.
 *
 * Every wait below is on a signal the render itself produces. The layer stack
 * publishes the stage measurement its ResizeObserver delivered, the images
 * report their own decode, and the font set reports its own load. Nothing waits
 * on the clock.
 *
 * `catalogue` defaults to DEFAULT_CATALOGUE, but a fixture that deliberately
 * uses a family outside it — a real production state, the one weightFor's
 * TEXT_WEIGHT fallback exists for — is not locked out: assertFaceLoaded only
 * runs for a family this same catalogue actually names. Without that,
 * asserting "loaded" on a family faceRule() never emitted a rule for (there
 * is nothing else here that could) would fail mount() itself for a fixture
 * whose whole point is to exercise the fallback, rather than the assertion
 * the fixture was written to make.
 */
async function mount(
  project: Project,
  options: { catalogue?: CatalogueFontEntry[] } = {},
): Promise<Mounted> {
  const catalogue = options.catalogue ?? DEFAULT_CATALOGUE;
  await page.viewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  // Before anything measures or paints, so weightFor already resolves every
  // catalogued family's real weight rather than the TEXT_WEIGHT fallback.
  await stubFontCatalogue(catalogue);
  const cataloguedFamilies = new Set(catalogue.map((entry) => entry.family));
  // Loaded before the mount, so the stage's first measurement already uses the
  // real faces rather than wrapping against a fallback and settling afterwards.
  // Every distinct family the project's text layers actually use, not just the
  // default, so a fixture in a non-default font is measured against its own
  // face rather than a fallback that happens to still be point-for-point.
  const families = [
    ...new Set(
      project.slides.flatMap((slide) => slide.texts.map((layer) => layer.fontFamily)),
    ),
  ];
  await Promise.all(
    families.map((family) => document.fonts.load(textFontString(64, family))),
  );
  await document.fonts.ready;
  // See assertFaceLoaded's own doc comment: the two waits above cannot tell
  // a real load apart from a silent fallback on their own. Only meaningful
  // for a catalogued family — an uncatalogued one is supposed to fall back,
  // and asserting "loaded" on it would be asserting something faceRule()
  // never promised.
  await Promise.all(
    families.filter((family) => cataloguedFamilies.has(family)).map(assertFaceLoaded),
  );

  const library = libraryIndex();
  const store = new EditorStore(project, { save: (saved) => Promise.resolve(saved) });
  const screen = await render(<ParityHarness store={store} library={library} />);

  const stage = await screen.getByTestId("stage").element();
  await expect
    .poll(() => {
      const stack = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
      return Number(stack?.dataset["stageWidth"] ?? 0);
    })
    .toBeGreaterThan(0);
  const stack = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
  const measured = {
    width: Number(stack?.dataset["stageWidth"] ?? 0),
    height: Number(stack?.dataset["stageHeight"] ?? 0),
  };

  const frame = stage.parentElement;
  if (frame === null) throw new Error("The stage has no frame around it.");
  expect(
    frame.querySelector('[data-testid="layer-stack"]'),
    "the screenshot has to cover the layers as well as the photo",
  ).not.toBeNull();

  await expect
    .poll(() => {
      const images = [...frame.querySelectorAll("img")];
      return (
        images.length > 0 &&
        images.every((image) => image.complete && image.naturalWidth > 0)
      );
    })
    .toBe(true);

  const slide = store.getSnapshot().project.slides[0];
  if (slide === undefined) throw new Error("The fixture project holds no slide.");
  // Nothing is selected, so no outline, handle or greyed overhang is on screen.
  expect(store.getSnapshot().selection).toEqual([]);
  return { slide, frame, library, stage: measured };
}

/** The stage as photographed, resampled onto the comparison grid. */
async function stageImage(frame: Element): Promise<ImageData> {
  return normalise(await screenshotDataUrl(frame), COMPARE_WIDTH, COMPARE_HEIGHT);
}

/** The export of one slide, resampled onto the same grid. */
async function exportImage(slide: Slide, library: LibraryIndex): Promise<ImageData> {
  const canvas = await renderSlideCanvas(slide, {
    height: 1920,
    assets: new Map(library),
  });
  return normalise(canvas, COMPARE_WIDTH, COMPARE_HEIGHT);
}

const FIXTURES: { name: string; project: () => Project }[] = [
  {
    name: "plain text",
    project: () => projectWith({ texts: [text({ text: "Plain text on a photo" })] }),
  },
  {
    name: "outlined text",
    project: () =>
      projectWith({
        texts: [text({ text: "Outlined text", style: "outline", color: "#FFE45E" })],
      }),
  },
  {
    name: "per-line boxed text",
    project: () =>
      projectWith({
        texts: [
          text({
            text: "One\nTwo lines here\nThree",
            style: "boxed",
            backgroundShape: "lines",
            background: "white",
            color: "#111111",
            height: 0.32,
            size: 78,
          }),
        ],
      }),
  },
  {
    /*
     * The same pills at a font small enough to matter. src/shared/text/pill.ts
     * deliberately carries no Math.max(2, radius * 0.2) and no
     * Math.max(1, radius * 0.1), where app.js had both. Those were absolute
     * pixel constants inside otherwise proportional geometry, so below a 37
     * pixel font for the corner and a 55.56 pixel font for the junction the
     * stage and the export disagreed by a whole corner radius. The export font
     * at 1080 is the layer's own size, so 34 sits under both thresholds and
     * this fixture renders in the band where that fault used to live.
     */
    name: "per-line boxed text at a small font",
    project: () =>
      projectWith({
        texts: [
          text({
            text: "Small\nA longer middle line\nEnd",
            style: "boxed",
            backgroundShape: "lines",
            background: "black",
            color: "#FFFFFF",
            y: 0.3,
            height: 0.2,
            size: 34,
          }),
        ],
      }),
  },
  {
    /*
     * A real, metrically different face. Space Mono is monospace where
     * TikTok Sans is not, so if either the measuring canvas or the paint
     * path ever regressed to a hardcoded default instead of the layer's own
     * fontFamily, this face wraps differently enough for that to show up
     * here rather than only in the meta-test below.
     *
     * mount() stubs the font catalogue (stubFontCatalogue) so weightFor
     * ("Space Mono") genuinely resolves to its real 400, matching TikTok
     * Sans's 500 fallback route through the same function rather than one of
     * the two families skipping it. That does not, on its own, prove the two
     * render paths would disagree if a *weight* mismatch were reintroduced:
     * see the comment on the meta-test below for the measured limit of what
     * this file's pixel comparison can see on that axis.
     */
    name: "text in a non-default font",
    project: () =>
      projectWith({
        texts: [text({ fontFamily: "Space Mono" })],
      }),
  },
  {
    name: "a rotated overlay with a crop",
    project: () =>
      projectWith({
        overlays: [
          overlay({
            rotation: 18,
            cropX: 0.2,
            cropY: 0.15,
            cropW: 0.6,
            cropH: 0.7,
            x: 0.2,
            y: 0.3,
            width: 0.5,
            height: 0.3,
          }),
        ],
      }),
  },
];

/** The boxed fixture, which two of the tests below both need. */
function boxedProject(): Project {
  return projectWith({
    texts: [
      text({
        text: "One\nTwo lines here\nThree",
        style: "boxed",
        backgroundShape: "lines",
        background: "white",
        color: "#111111",
        height: 0.32,
        size: 78,
      }),
    ],
  });
}

/** Both measurements of one pair, printed so a report can quote the numbers. */
function measure(name: string, shown: ImageData, exported: ImageData) {
  const soft = diffRatio(shown, exported);
  const hard = diffRatio(shown, exported, HARD_CHANNEL);
  console.log(`parity ${name}: soft=${soft.toFixed(5)} hard=${hard.toFixed(5)}`);
  return { soft, hard };
}

describe("the stage and the export agree", () => {
  for (const fixture of FIXTURES) {
    it(`exports ${fixture.name} the way the stage shows it`, async () => {
      const { slide, frame, library } = await mount(fixture.project());
      const { soft, hard } = measure(
        fixture.name,
        await stageImage(frame),
        await exportImage(slide, library),
      );
      expect(soft).toBeLessThan(TOLERANCE);
      expect(hard).toBeLessThan(HARD_TOLERANCE);
    });
  }
});

describe("the parity test can fail", () => {
  /*
   * A parity test that cannot go red is worse than none, because it retires the
   * suspicion that made anyone write it. Each case below breaks the export on
   * purpose and asserts the measurement notices, and each breakage is the shape
   * of the drift this rewrite removed: one number the two paths disagree about.
   *
   * Each also asserts the honest render of the same fixture passes, so the
   * failure it reports is the breakage rather than the harness.
   */

  it("catches a text layer whose export origin has moved", async () => {
    const { slide, frame, library } = await mount(
      projectWith({ texts: [text({ text: "Plain text on a photo" })] }),
    );
    const honest = measure(
      "plain text, honest",
      await stageImage(frame),
      await exportImage(slide, library),
    );
    expect(honest.hard).toBeLessThan(HARD_TOLERANCE);

    // One per cent of the canvas width, which is 10.8 pixels at 1080. The
    // corner-radius drift the deleted pixel floors caused was about 1.4 per
    // cent, so this is smaller than the fault the module exists to prevent.
    const moved: Slide = {
      ...slide,
      texts: slide.texts.map((layer) => ({ ...layer, x: layer.x + 0.01 })),
    };
    const broken = measure(
      "plain text, origin moved",
      await stageImage(frame),
      await exportImage(moved, library),
    );
    expect(broken.hard).toBeGreaterThan(HARD_TOLERANCE);
  });

  it("catches a text layer whose export font identity has drifted", async () => {
    /*
     * A short word, as the fixture above uses, has too little glyph area for
     * a family swap to move the hard measurement: "Ship it" at the default
     * size 96 measures honest hard=0.00283, and swapping its export family
     * only moves that to hard=0.00432, short of HARD_TOLERANCE. This case
     * wants a signal, not a passing grade, so it renders at 140 rather than
     * the default 96:
     * large enough that the honest render still clears HARD_TOLERANCE with
     * margin (0.00633, measured) while the swap below clears it with margin
     * from the other side (0.00988, measured), and small enough to stay under
     * FONT_SIZE_MAX.
     */
    const { slide, frame, library } = await mount(
      projectWith({
        texts: [text({ fontFamily: "Space Mono", size: 140 })],
      }),
    );
    const honest = measure(
      "non-default font, honest",
      await stageImage(frame),
      await exportImage(slide, library),
    );
    expect(honest.hard).toBeLessThan(HARD_TOLERANCE);

    // The stage above was photographed in Space Mono. Exporting the same
    // slide with every layer's fontFamily swapped back to the default paints
    // a proportional face where the photo shows a monospace one — the exact
    // drift a hardcoded font string, rather than the layer's own
    // fontFamily, would reintroduce into either render path.
    const wrongFamily: Slide = {
      ...slide,
      texts: slide.texts.map((layer) => ({ ...layer, fontFamily: DEFAULT_FONT_FAMILY })),
    };
    const broken = measure(
      "non-default font, export family reverted to default",
      await stageImage(frame),
      await exportImage(wrongFamily, library),
    );
    expect(broken.hard).toBeGreaterThan(HARD_TOLERANCE);
  });

  /*
   * No case here proves the weight half of a font string the way the case
   * above proves the family half, and that is a measured limit rather than
   * an oversight.
   *
   * weightFor("Space Mono") now resolves through stubFontCatalogue to its
   * real 400 (see mount()), so the fixture above renders honestly at 400 in
   * both paths. The historical bug this axis guards against is one path
   * reading that real weight and the other falling back to TEXT_WEIGHT
   * (500) instead — a delta of 100. Measured directly (mount the fixture
   * above at size 140, then re-stub the catalogue to 500 and export the
   * same slide again so only the export's weightFor("Space Mono") call
   * disagrees with what the already-screenshotted stage was painted at):
   * hard=0.00633 and soft=0.01106, identical to the honest render's own
   * numbers to five decimal places. Chromium does not synthesise a visibly
   * different Space Mono at 500 from the one @font-face declares at 400 —
   * canvas ink-coverage probes at "HHH"/200px show zero difference between
   * fillText at weight 400 and weight 500 against this face (ratio 1.0),
   * and only start to diverge past roughly weight 900 (ratio ~1.3, and even
   * then hard=0.00931 clears HARD_TOLERANCE by a thin margin while
   * soft=0.01406 never clears TOLERANCE at all). A weight-only mismatch at
   * any value this app's real catalogue could actually contain is
   * therefore invisible to a whole-frame pixel diff, on this face, in this
   * browser — not a case this suite's pixel-comparison method can carry,
   * regardless of fixture size or tolerance. See task-11-report.md for the
   * full numbers and what was tried.
   *
   * The case below covers the same regression a different way: not by
   * rendering pixels and diffing them, but by reading the actual weight
   * number each paint path handed the browser and asserting both are
   * `weightFor`'s real value rather than one of them silently being
   * TEXT_WEIGHT.
   */
  it("hands weightFor's real weight to both the DOM paint and the canvas paint", async () => {
    const { slide, frame, library } = await mount(
      projectWith({ texts: [text({ fontFamily: "Space Mono" })] }),
    );
    // mount() has already run stubFontCatalogue by this point, which is what
    // makes weightFor("Space Mono") resolve to its real 400 rather than the
    // TEXT_WEIGHT fallback. If this ever equals TEXT_WEIGHT, every assertion
    // below still passes whether or not weightFor is actually being called
    // anywhere — the case only means something because Space Mono's real
    // weight and the fallback disagree.
    const catalogued = weightFor("Space Mono");
    expect(catalogued).not.toBe(TEXT_WEIGHT);
    expect(catalogued).toBe(400);

    // The DOM side: textBlockStyle (renderTextDom.tsx) writes fontWeight:
    // weightFor(family) straight into the text block's inline style.
    const block = frame.querySelector<HTMLElement>('[data-testid="text-block"]');
    expect(block, "the plain-style fixture renders a text block").not.toBeNull();
    expect(Number(block?.style.fontWeight)).toBe(catalogued);

    // The canvas side: drawTextLayer (render.ts) sets context.font from
    // textFontString(fontSize, layer.fontFamily, weightFor(layer.fontFamily))
    // — the weight is the leading token. A spy on the inherited `font`
    // setter reads back what was actually assigned during the real export,
    // rather than recomputing what render.ts *should* have assigned.
    const descriptor = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "font",
    );
    if (descriptor?.set === undefined) {
      throw new Error(
        "This browser has no CanvasRenderingContext2D.font setter to spy on.",
      );
    }
    const realSetter = descriptor.set;
    const assignments: string[] = [];
    Object.defineProperty(CanvasRenderingContext2D.prototype, "font", {
      ...descriptor,
      set(this: CanvasRenderingContext2D, value: string) {
        assignments.push(value);
        realSetter.call(this, value);
      },
    });
    try {
      await exportImage(slide, library);
    } finally {
      Object.defineProperty(CanvasRenderingContext2D.prototype, "font", descriptor);
    }

    const spaceMonoFont = assignments.find((value) => value.includes("Space Mono"));
    expect(spaceMonoFont, "the export set a font naming Space Mono").not.toBeUndefined();
    const weight = Number(/^(\d+)\s/.exec(spaceMonoFont ?? "")?.[1]);
    expect(weight).toBe(catalogued);
  });

  /*
   * Fix round 4, finding 12: assertFaceLoaded (inside mount()) used to hard-
   * fail for any family outside DEFAULT_CATALOGUE, so this file had no way
   * to express a fixture that deliberately uses an uncatalogued family — a
   * real production state (an agent-authored slideshow naming a font that
   * was never added, say) and exactly the case weightFor's TEXT_WEIGHT
   * fallback exists for. Now that mount() only asserts "loaded" for a family
   * its own catalogue actually names, this fixture can exist: it mirrors the
   * catalogued case above, but for the fallback, and proves the DOM and
   * canvas paths agree on it the same way they agree on a real weight.
   */
  it("hands weightFor's TEXT_WEIGHT fallback to both the DOM paint and the canvas paint, for an uncatalogued family", async () => {
    const { slide, frame, library } = await mount(
      projectWith({ texts: [text({ fontFamily: "Totally Uncatalogued Font" })] }),
    );
    // DEFAULT_CATALOGUE (mount()'s own default) never names this family, so
    // weightFor has nothing to resolve it against and falls back.
    const fallback = weightFor("Totally Uncatalogued Font");
    expect(fallback).toBe(TEXT_WEIGHT);

    const block = frame.querySelector<HTMLElement>('[data-testid="text-block"]');
    expect(block, "the plain-style fixture renders a text block").not.toBeNull();
    expect(Number(block?.style.fontWeight)).toBe(fallback);

    const descriptor = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "font",
    );
    if (descriptor?.set === undefined) {
      throw new Error(
        "This browser has no CanvasRenderingContext2D.font setter to spy on.",
      );
    }
    const realSetter = descriptor.set;
    const assignments: string[] = [];
    Object.defineProperty(CanvasRenderingContext2D.prototype, "font", {
      ...descriptor,
      set(this: CanvasRenderingContext2D, value: string) {
        assignments.push(value);
        realSetter.call(this, value);
      },
    });
    try {
      await exportImage(slide, library);
    } finally {
      Object.defineProperty(CanvasRenderingContext2D.prototype, "font", descriptor);
    }

    const uncataloguedFont = assignments.find((value) =>
      value.includes("Totally Uncatalogued Font"),
    );
    expect(
      uncataloguedFont,
      "the export set a font naming the uncatalogued family",
    ).not.toBeUndefined();
    const weight = Number(/^(\d+)\s/.exec(uncataloguedFont ?? "")?.[1]);
    expect(weight).toBe(fallback);
  });

  it("catches a boxed text whose export pills have drifted", async () => {
    const { slide, frame, library } = await mount(boxedProject());
    const honest = measure(
      "boxed text, honest",
      await stageImage(frame),
      await exportImage(slide, library),
    );
    expect(honest.hard).toBeLessThan(HARD_TOLERANCE);

    const moved: Slide = {
      ...slide,
      texts: slide.texts.map((layer) => ({ ...layer, x: layer.x + 0.01 })),
    };
    const brokenOrigin = measure(
      "boxed text, origin moved",
      await stageImage(frame),
      await exportImage(moved, library),
    );
    expect(brokenOrigin.hard).toBeGreaterThan(HARD_TOLERANCE);

    const grown: Slide = {
      ...slide,
      texts: slide.texts.map((layer) => ({ ...layer, size: layer.size * 1.06 })),
    };
    const brokenSize = measure(
      "boxed text, font grown",
      await stageImage(frame),
      await exportImage(grown, library),
    );
    expect(brokenSize.hard).toBeGreaterThan(HARD_TOLERANCE);
  });

  it("catches an overlay whose export crop has been dropped", async () => {
    const { slide, frame, library } = await mount(
      projectWith({
        overlays: [
          overlay({
            rotation: 18,
            cropX: 0.2,
            cropY: 0.15,
            cropW: 0.6,
            cropH: 0.7,
            x: 0.2,
            y: 0.3,
            width: 0.5,
            height: 0.3,
          }),
        ],
      }),
    );
    const honest = measure(
      "rotated overlay, honest",
      await stageImage(frame),
      await exportImage(slide, library),
    );
    expect(honest.hard).toBeLessThan(HARD_TOLERANCE);

    const uncropped: Slide = {
      ...slide,
      overlays: slide.overlays.map((layer) => ({
        ...layer,
        cropX: 0,
        cropY: 0,
        cropW: 1,
        cropH: 1,
      })),
    };
    const broken = measure(
      "rotated overlay, crop dropped",
      await stageImage(frame),
      await exportImage(uncropped, library),
    );
    /*
     * This one is caught by the blunt measurement and not by the sharp one,
     * which is the clearest statement of what each is for. Dropping the crop
     * slides a smooth wash under the overlay, so every pixel in it changes and
     * none of them changes by much. The two measurements answer different
     * questions, and a suite carrying only one of them would miss whichever
     * fault the other one owns.
     */
    expect(broken.soft).toBeGreaterThan(TOLERANCE);
    expect(honest.soft).toBeLessThan(TOLERANCE);
  });
});

describe("the corner radii both renderers were handed", () => {
  /*
   * The half of the layering argument that no whole-frame count can carry.
   *
   * pill.test.ts defends what lineCornerRadii returns, and it never loads
   * either renderer, so a renderer that ignores the radii it was given is
   * invisible to it. The parity figures above are equally blind: forcing a
   * pill's radii to zero moves them from 0.00476 to 0.00478, because a corner
   * is a few dozen pixels of a half-million-pixel frame.
   *
   * So the field is asserted directly, once on each side. The canvas half
   * measures the drawn arc in render.browser.test.tsx. This is the DOM half:
   * the path the SVG actually carries, against the path the layout asks for.
   */
  it("draws every pill on the exact path the layout describes", async () => {
    const { stage } = await mount(boxedProject());
    const stack = document.querySelector<HTMLElement>('[data-testid="layer-stack"]');
    const layer = document
      .querySelector('[data-layer-kind="text"]')
      ?.getAttribute("data-layer-id");
    expect(stack, "the stage published its measurement").not.toBeNull();
    expect(layer, "the boxed text is on the stage").not.toBeNull();

    const store = boxedProject();
    const text = store.slides[0]?.texts[0];
    if (text === undefined) throw new Error("The fixture holds no text layer.");
    const layout = layoutAt(text, stage.width, stage.height);
    expect(layout.perLineBox, "the fixture is the per-line boxed style").toBe(true);
    expect(layout.lines.length, "the fixture wraps to three pills").toBe(3);

    const drawn = [
      ...document.querySelectorAll<SVGPathElement>('[data-testid="text-pills"] path'),
    ].map((path) => path.getAttribute("d"));

    const expected = layout.lines
      .map((_line, index) =>
        layout.pillVisible[index] === true
          ? roundedRectPath(
              layout.pillStarts[index] ?? 0,
              (layout.lineCenters[index] ?? 0) - layout.pillHeight / 2,
              layout.pillWidths[index] ?? 0,
              layout.pillHeight,
              layout.pillRadii[index] ?? [0, 0, 0, 0],
            )
          : null,
      )
      .filter((path): path is string => path !== null);

    expect(expected.length, "the layout asks for three pills").toBe(3);
    expect(drawn.slice(0, expected.length)).toEqual(expected);

    // A pill whose corners the DOM squared would still be a path of the right
    // length and position, so the radii are named here as well as compared.
    const rounded = layout.pillRadii.filter((radii) => radii.some((value) => value > 0));
    expect(rounded.length, "the layout rounds at least one pill").toBeGreaterThan(0);
  });
});
