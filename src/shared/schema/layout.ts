import { z } from "zod";

/**
 * Named anchors an agent may pick for one slide, after it has seen a preview.
 * Each key is optional, and a missing key keeps the default for the slide's
 * role. Strict, so a misspelt key is refused rather than silently ignored.
 */
export const slideLayoutSchema = z
  .object({
    text: z
      .enum(["top", "middle", "bottom"])
      .optional()
      .describe("Where the text block sits, always inside the safe zone."),
    assets: z
      .enum(["top-left", "top-right", "center", "bottom-left"])
      .optional()
      .describe(
        "Where the assets sit. Without it, the assets sit next to an anchored text.",
      ),
    assetSize: z
      .enum(["small", "medium", "large"])
      .optional()
      .describe("Width of each asset: at most 0.25, 0.40 or 0.60 of the slide."),
  })
  .strict();

export type SlideLayout = z.infer<typeof slideLayoutSchema>;
