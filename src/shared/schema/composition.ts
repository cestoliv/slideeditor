import { z } from "zod";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TEXT_WEIGHT_MAX,
  TEXT_WEIGHT_MIN,
} from "../text/constants.js";
import { hexColorSchema } from "./account.js";

/**
 * One styled line of an agent's composition. The MCP tools and the raw HTTP
 * route both parse through this, so a colour is stored as `#RRGGBB` whichever
 * path it came in by, and a kept line compares equal to the one asked for.
 */
export const styledTextSchema = z.object({
  text: z.string().min(1).describe("The line itself."),
  size: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).optional(),
  style: z.enum(["plain", "outline", "boxed"]).optional(),
  color: hexColorSchema.optional().describe("Text colour as hex, e.g. #FFE600."),
  background: hexColorSchema.optional().describe("Box colour as hex, for `boxed`."),
  weight: z.number().int().min(TEXT_WEIGHT_MIN).max(TEXT_WEIGHT_MAX).optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});
