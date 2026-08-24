import { parseProject } from "@shared/schema/index.js";
import type { Project } from "@shared/schema/index.js";

export type FixtureOptions = {
  /** Slides to build, each with the same layer counts. */
  slides?: number;
  /** Texts per slide, laid out one below the other. */
  texts?: number;
  /** Overlays per slide. */
  overlays?: number;
  version?: number;
};

/**
 * A project the editor tests can edit. Built through parseProject so a fixture
 * cannot drift into a shape the real parser would reject, and so the defaults
 * here are the ones a real document carries.
 *
 * z runs 1..n across the overlays and then the texts of each slide, the order
 * assignLayerOrder gives a document that has never been reordered.
 */
export function fixtureProject(options: FixtureOptions = {}): Project {
  const { slides = 1, texts = 1, overlays = 0, version = 1 } = options;
  return parseProject({
    id: "project-1",
    name: "Fixture",
    version,
    status: "draft",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ratio: { w: 9, h: 16 },
    slides: Array.from({ length: slides }, (_slide, slideIndex) => ({
      id: `slide-${slideIndex + 1}`,
      backgroundItemId: `item-${slideIndex + 1}`,
      name: `Slide ${slideIndex + 1}`,
      width: 1080,
      height: 1920,
      imageScale: 1,
      imageX: 0,
      imageY: 0,
      overlays: Array.from({ length: overlays }, (_overlay, index) => ({
        id: `overlay-${slideIndex + 1}-${index + 1}`,
        itemId: `item-${slideIndex + 1}`,
        x: 0.2,
        y: 0.2 + index * 0.1,
        width: 0.34,
        height: 0.34,
        rotation: 0,
        cropX: 0,
        cropY: 0,
        cropW: 1,
        cropH: 1,
        z: index + 1,
      })),
      texts: Array.from({ length: texts }, (_text, index) => ({
        id: `text-${slideIndex + 1}-${index + 1}`,
        text: `Line ${index + 1}`,
        x: 0.06,
        y: 0.5 + index * 0.1,
        width: 0.88,
        height: 0.1,
        size: 48,
        style: "plain",
        color: "#ffffff",
        background: "white",
        backgroundShape: "full",
        align: "center",
        rotation: 0,
        z: overlays + index + 1,
      })),
    })),
  });
}
