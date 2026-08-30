import { render } from "vitest-browser-react";
import { expect, it, vi } from "vitest";
import { usePublishOnReady } from "./usePublishOnReady.js";
import type { PublishDeps } from "./usePublishOnReady.js";
import { EditorStore } from "../store.js";
import { DEFAULT_ACCOUNT_ID } from "@shared/schema/index.js";
import type { LibraryItem, SlideshowStatus } from "@shared/schema/index.js";
import { fixtureProject } from "../testing.js";
import type { LibraryIndex } from "../../../app/useLibrary.js";

function makeStore(options: { status: SlideshowStatus; version?: number }): EditorStore {
  const { status, version } = options;
  return new EditorStore(
    { ...fixtureProject(version === undefined ? {} : { version }), status },
    { save: vi.fn(), setStatus: vi.fn(async () => undefined) },
  );
}

/** A background asset, so a library built from it resolves fixtureProject's one slide. */
function asset(id: string): LibraryItem {
  return {
    id,
    kind: "background",
    name: id,
    description: "",
    usage: "",
    tags: [],
    accountId: DEFAULT_ACCOUNT_ID,
    mediaId: id,
    ext: "png",
    url: `/media/${id}.png`,
    width: 1600,
    height: 900,
    createdAt: 1,
    updatedAt: 1,
    stats: { timesUsed: 0, slideshowCount: 0, firstUsedAt: null, lastUsedAt: null },
  };
}

/** Resolves every background fixtureProject's default (single, one-slide) project uses. */
const FULL_LIBRARY: LibraryIndex = new Map([["item-1", asset("item-1")]]);

function Harness({
  store,
  library,
  publish,
  upload,
  onError,
}: {
  store: EditorStore;
  library: LibraryIndex;
  publish: PublishDeps["publish"];
  upload: PublishDeps["upload"];
  onError?: (message: string) => void;
}) {
  usePublishOnReady({
    store,
    library,
    // A fresh arrow every render, the way Editor.tsx's real onError is built
    // inline in OpenEditor — an identity that changes on every re-render, not
    // the stable mock reference `onError` itself would be if forwarded as-is.
    onError: onError
      ? (message: string) => {
          onError(message);
        }
      : undefined,
    deps: { publish, upload },
  });
  return null;
}

/** One turn of the event loop, so the hook's effect and its awaits settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it("stays quiet while the slideshow is a draft", async () => {
  const publish = vi.fn(async () => 0);
  const upload = vi.fn(async () => undefined);
  const store = makeStore({ status: "draft" });
  await render(
    <Harness store={store} library={FULL_LIBRARY} publish={publish} upload={upload} />,
  );
  await settle();
  expect(publish).not.toHaveBeenCalled();
});

it("publishes once the slideshow becomes ready", async () => {
  const publish = vi.fn(async () => 1);
  const upload = vi.fn(async () => undefined);
  const store = makeStore({ status: "draft" });
  await render(
    <Harness store={store} library={FULL_LIBRARY} publish={publish} upload={upload} />,
  );
  await settle();
  await store.setStatus("ready", { fromServer: true });
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

it("publishes only once for one version, however often it re-renders", async () => {
  const publish = vi.fn(async () => 1);
  const upload = vi.fn(async () => undefined);
  const store = makeStore({ status: "ready" });
  const screen = await render(
    <Harness store={store} library={FULL_LIBRARY} publish={publish} upload={upload} />,
  );
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(1);
  });
  // Same contents, new identity, so the effect really re-runs and the key guard
  // is the only thing holding the count at 1. Passing FULL_LIBRARY again would
  // leave every dependency identity-stable and let React skip the effect, which
  // would keep this test green with the guard deleted.
  screen.rerender(
    <Harness
      store={store}
      library={new Map(FULL_LIBRARY)}
      publish={publish}
      upload={upload}
    />,
  );
  await settle();
  expect(publish).toHaveBeenCalledTimes(1);
});

it("publishes again when an edit bumps the version while ready", async () => {
  const publish = vi.fn(async () => 1);
  const upload = vi.fn(async () => undefined);
  const store = makeStore({ status: "ready", version: 1 });
  await render(
    <Harness store={store} library={FULL_LIBRARY} publish={publish} upload={upload} />,
  );
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(1);
  });
  store.replaceProject({ ...store.getSnapshot().project, version: 2 });
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

it("reports a failure without touching the slideshow's status", async () => {
  const publish = vi.fn(async () => {
    throw new Error("canvas said no");
  });
  const upload = vi.fn(async () => undefined);
  const onError = vi.fn();
  const store = makeStore({ status: "ready" });
  await render(
    <Harness
      store={store}
      library={FULL_LIBRARY}
      publish={publish}
      upload={upload}
      onError={onError}
    />,
  );
  await vi.waitFor(() => {
    expect(onError).toHaveBeenCalled();
  });
  expect(store.getSnapshot().project.status).toBe("ready");
});

it("waits for a resolvable library before publishing a slideshow that opens already ready", async () => {
  const publish = vi.fn(async () => 1);
  const upload = vi.fn(async () => undefined);
  const store = makeStore({ status: "ready" });
  // The empty map useLibrary starts every scope with (EMPTY_STATE.items),
  // before its own effect has fetched anything — the shape a cold open of an
  // already-ready slideshow actually mounts with.
  const screen = await render(
    <Harness store={store} library={new Map()} publish={publish} upload={upload} />,
  );
  await settle();
  expect(publish).not.toHaveBeenCalled();

  screen.rerender(
    <Harness store={store} library={FULL_LIBRARY} publish={publish} upload={upload} />,
  );
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

it("reports a failure even when a re-render lands while the publish is in flight", async () => {
  let rejectPublish: (error: Error) => void = () => {
    throw new Error("rejectPublish called before publish started");
  };
  const publish = vi.fn(
    () =>
      new Promise<number>((_resolve, reject) => {
        rejectPublish = reject;
      }),
  );
  const upload = vi.fn(async () => undefined);
  const onError = vi.fn();
  const store = makeStore({ status: "ready" });
  const screen = await render(
    <Harness
      store={store}
      library={FULL_LIBRARY}
      publish={publish}
      upload={upload}
      onError={onError}
    />,
  );
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // A re-render while the publish is still pending — Editor.tsx causes one on
  // every pointer move, since it hands the hook a fresh onError each render.
  screen.rerender(
    <Harness
      store={store}
      library={FULL_LIBRARY}
      publish={publish}
      upload={upload}
      onError={onError}
    />,
  );
  await settle();

  rejectPublish(new Error("canvas said no"));
  await vi.waitFor(() => {
    expect(onError).toHaveBeenCalled();
  });
});

it("reports a failure when the library changes while the publish is in flight", async () => {
  let rejectPublish: (error: Error) => void = () => {
    throw new Error("rejectPublish called before publish started");
  };
  const publish = vi.fn(
    () =>
      new Promise<number>((_resolve, reject) => {
        rejectPublish = reject;
      }),
  );
  const upload = vi.fn(async () => undefined);
  const onError = vi.fn();
  const store = makeStore({ status: "ready" });
  const screen = await render(
    <Harness
      store={store}
      library={FULL_LIBRARY}
      publish={publish}
      upload={upload}
      onError={onError}
    />,
  );
  await vi.waitFor(() => {
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // A library mutation mid-publish: LibraryCache.upsert and remove publish a new
  // map identity, and library is a real dependency, so this re-runs the effect
  // while the first pass is still pending. The re-run returns at the key guard,
  // which leaves the first pass as the only one that can report the failure.
  screen.rerender(
    <Harness
      store={store}
      library={new Map(FULL_LIBRARY)}
      publish={publish}
      upload={upload}
      onError={onError}
    />,
  );
  await settle();
  expect(publish).toHaveBeenCalledTimes(1);

  rejectPublish(new Error("canvas said no"));
  await vi.waitFor(() => {
    expect(onError).toHaveBeenCalled();
  });
});
