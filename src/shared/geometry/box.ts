/** An axis-aligned rectangle in fractions of the slide. */
export type Box = { x: number; y: number; width: number; height: number };

export function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
