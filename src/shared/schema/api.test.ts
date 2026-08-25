import { describe, expect, it } from "vitest";
import { parseProject, projectSchema, serverEventSchema } from "./api.js";

describe("parseProject", () => {
  // Important 6: projectSchema alone (documentSchema.extend(...)) never
  // assigns z, so a consumer parsing an API response directly with it skips
  // the back-fill parseDocument applies. parseProject runs the same
  // assignLayerOrder both entry points need.
  it("back-fills z on overlays and texts the same way parseDocument does", () => {
    const raw = {
      id: "p1",
      name: "Project",
      version: 1,
      status: "draft",
      createdAt: 1,
      updatedAt: 2,
      ratio: { w: 9, h: 16 },
      slides: [
        {
          id: "s1",
          backgroundItemId: "b1",
          overlays: [{ id: "o1", itemId: "a1", x: 0, y: 0 }],
          texts: [
            { id: "t1", text: "hi", x: 0, y: 0, width: 0.5, height: 0.1, size: 48 },
          ],
        },
      ],
    };

    // projectSchema alone does not assign z.
    expect(
      projectSchema.parse(structuredClone(raw)).slides[0]!.overlays[0]!.z,
    ).toBeUndefined();

    const project = parseProject(structuredClone(raw));
    expect(project.slides[0]!.overlays[0]!.z).toBe(1);
    expect(project.slides[0]!.texts[0]!.z).toBe(2);
  });

  it("still throws on a genuinely malformed project, unlike parseDocument", () => {
    expect(() => parseProject({ id: "p1" })).toThrow();
  });
});

describe("serverEventSchema", () => {
  /*
   * The union lives here rather than once on each side of the wire. The server
   * types EventBus.broadcast from it and the browser parses incoming frames
   * with it, so a renamed field is a compile error in the server instead of a
   * frame the client drops in silence.
   */
  it("reads each of the three frames the bus broadcasts", () => {
    expect(
      serverEventSchema.parse({ type: "project.changed", projectId: "p1", version: 7 }),
    ).toEqual({ type: "project.changed", projectId: "p1", version: 7 });
    expect(
      serverEventSchema.parse({
        type: "project.status",
        projectId: "p1",
        status: "ready",
      }),
    ).toEqual({ type: "project.status", projectId: "p1", status: "ready" });
    expect(serverEventSchema.parse({ type: "project.removed", projectId: "p1" })).toEqual(
      {
        type: "project.removed",
        projectId: "p1",
      },
    );
  });

  it("repairs an unknown status the way every other status field does", () => {
    const frame = serverEventSchema.parse({
      type: "project.status",
      projectId: "p1",
      status: "archived",
    });
    expect(frame).toEqual({ type: "project.status", projectId: "p1", status: "draft" });
  });

  it("refuses a frame it does not model", () => {
    expect(
      serverEventSchema.safeParse({ type: "library.changed", itemId: "i1" }).success,
    ).toBe(false);
    expect(
      serverEventSchema.safeParse({ type: "project.changed", projectId: "p1" }).success,
    ).toBe(false);
  });
});
