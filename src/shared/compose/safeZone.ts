import type { Box } from "../geometry/index.js";
import { SAFE_BOTTOM, SAFE_RIGHT, SAFE_TOP } from "./constants.js";

/**
 * Whether a layer leaves the TikTok safe zone. Rounding in a composed layout
 * stays well under the tolerance, so only a real move trips it.
 */
export function outsideSafeZone(box: Box): boolean {
  const epsilon = 1e-3;
  return (
    box.x < -epsilon ||
    box.y < SAFE_TOP - epsilon ||
    box.x + box.width > SAFE_RIGHT + epsilon ||
    box.y + box.height > SAFE_BOTTOM + epsilon
  );
}
