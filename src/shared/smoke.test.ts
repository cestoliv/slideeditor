import { expect, it } from "vitest";
import { DESIGN_WIDTH } from "./index.js";

it("exports the design width", () => {
  expect(DESIGN_WIDTH).toBe(1080);
});
