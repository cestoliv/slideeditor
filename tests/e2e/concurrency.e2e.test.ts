import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { Project } from "@shared/schema/index.js";
import {
  baseUrl,
  createSlideshow,
  editPath,
  openApp,
  readProject,
  seedLibrary,
} from "./setup/fixtures.js";

/*
 * Two clients, one server, one slideshow. This is the promise the whole product
 * turns on: an agent may write to a slideshow a person has open, and the
 * person's editor keeps up rather than silently writing its own stale copy back
 * over it.
 *
 * Both clients here are real. The person's is the mounted app driven through the
 * page, and the agent's is `fetch` against the same routes an MCP client calls.
 */

/** What an agent sends to /api/slideshows/:id: the shorthand, not a document. */
type AgentSlide = { background: string; assets?: string[]; texts?: string[] };

async function agentUpdate(
  id: string,
  slides: AgentSlide[],
  version?: number,
): Promise<Response> {
  return fetch(`${baseUrl}/api/slideshows/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slides, ...(version === undefined ? {} : { version }) }),
  });
}

/**
 * The person's own save route, called with a version that is no longer current.
 *
 * This is the editor's PUT, not a private one: `persistProject` sends exactly
 * this body (src/web/app/api.ts).
 */
async function personSave(project: Project, name: string): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      document: { ratio: project.ratio, slides: project.slides },
      version: project.version,
    }),
  });
}

/*
 * The live stream, held so a test can drop it the way a network drops one.
 *
 * Nothing here is a stand-in: every stream below is a real EventSource opened by
 * the real client against the real server. The proxy only keeps a handle, which
 * is the one thing a page gives no other way to reach.
 */
const opened: EventSource[] = [];
const NativeEventSource = window.EventSource;

function trackStreams(): void {
  window.EventSource = new Proxy(NativeEventSource, {
    construct(target, args: [string, EventSourceInit?]) {
      const stream = new target(...args);
      opened.push(stream);
      return stream;
    },
  });
}

function dropStreams(): void {
  for (const stream of opened.splice(0)) stream.close();
}

/**
 * Waits until every stream the client opened is registered on the server.
 *
 * `readyState === OPEN` means the browser has the response head, and the bus
 * writes that head and adds the client to its set in one synchronous block
 * (`EventBus.subscribe`, src/server/services/events.ts), so an open stream is a
 * client the server is already holding. Nothing replays a missed frame:
 * `events.ts` sends no Last-Event-ID and the bus keeps no history, so an event
 * broadcast before this point is lost rather than late.
 *
 * That one synchronous block is the whole strength of this signal. Should
 * `subscribe` ever write the head and register the client apart — an await
 * between them, a queue, a registration deferred to a later tick — an open
 * stream would no longer mean a registered one, this wait would go back to
 * being a coincidence, and the failure would return as a thirty second timeout
 * on the locator rather than here. Whoever splits them owes this a new signal.
 *
 * The rendered slide is not this signal. `Editor.tsx` builds the EventSource in
 * the same commit that first renders the slide, so the text a test can find and
 * the handshake it needs are co-timed rather than ordered. Deferring
 * `app.events.subscribe` by 600ms turns that race into a 30 second timeout on an
 * unrelated locator.
 */
async function streamsRegistered(): Promise<void> {
  await expect
    .poll(
      () =>
        opened.length > 0 &&
        opened.every((stream) => stream.readyState === EventSource.OPEN),
      { timeout: 10000 },
    )
    .toBe(true);
}

type Frame = { type: string; projectId?: string; version?: number };

/**
 * Every frame the tracked streams deliver, in order.
 *
 * A listener added to a stream the app already owns observes without consuming:
 * the app's own listener still receives each frame. This is the only signal a
 * page offers that a broadcast has actually reached it, which is what a test
 * needs before it can say which of two reload paths ran.
 */
function watchFrames(): Frame[] {
  const seen: Frame[] = [];
  for (const stream of opened) {
    stream.addEventListener("message", (event: MessageEvent<string>) => {
      try {
        seen.push(JSON.parse(event.data) as Frame);
      } catch {
        // A heartbeat carries no payload, which is not an error.
      }
    });
  }
  return seen;
}

/**
 * Holds matching requests on the wire until the returned function releases them.
 *
 * The request itself is real and so is its answer. Only the moment it leaves the
 * page is controlled, which is what a slow uplink does anyway, and it is the one
 * thing a page offers no other way to reach. The same class of intervention as
 * the EventSource handle above.
 */
function holdRequests(match: (url: string, method: string) => boolean): {
  /** How many matching requests are waiting at the gate. */
  waiting: () => number;
  release: () => void;
} {
  const native = window.fetch.bind(window);
  let waiting = 0;
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    if (match(url, method.toUpperCase())) {
      waiting += 1;
      await gate;
    }
    return native(input, init);
  };
  return {
    waiting: () => waiting,
    release: () => {
      window.fetch = native;
      open();
    },
  };
}

afterEach(() => {
  window.EventSource = NativeEventSource;
  opened.length = 0;
});

it("reloads rather than clobbering when an agent edits the open slideshow", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Shared slideshow",
    ratio: { w: 4, h: 5 },
    slides: [{ background: backgrounds[0]!.id, texts: ["Written by the person"] }],
  });

  trackStreams();
  await openApp(editPath(created.editUrl));
  await expect
    .element(page.getByLabelText("Text layer: Written by the person"))
    .toBeVisible();
  // The agent must not write before the person's stream is registered, or the
  // frame it broadcasts has nowhere to land and nothing replays it.
  await streamsRegistered();

  const response = await agentUpdate(created.id, [
    { background: backgrounds[1]!.id, texts: ["Changed by the agent"] },
  ]);
  expect(response.status).toBe(200);

  // The stream carries the version, the editor re-reads the slideshow, and the
  // agent's line appears on the person's screen. Nothing here waits on a clock.
  await expect
    .element(page.getByLabelText("Text layer: Changed by the agent"))
    .toBeVisible();
  await expect
    .element(page.getByText("An agent changed this slideshow, so it reloaded."))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Text layer: Written by the person"))
    .not.toBeInTheDocument();

  // What the person edits from here rides on the agent's copy rather than
  // overwriting it, which is the whole of "reload rather than clobber".
  await userEvent.fill(page.getByLabelText("Slideshow name"), "Shared and renamed");
  await expect
    .poll(async () => (await readProject(baseUrl, created.id)).name, { timeout: 10000 })
    .toBe("Shared and renamed");
  const stored = await readProject(baseUrl, created.id);
  expect(stored.slides[0]?.texts.map((text) => text.text)).toEqual([
    "Changed by the agent",
  ]);
});

it("returns 409 to a stale save rather than overwriting", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Two writers",
    slides: [{ background: backgrounds[0]!.id, texts: ["The first draft"] }],
  });
  const read = await readProject(baseUrl, created.id);

  // The agent writes first, so the copy the person is holding goes stale.
  const agent = await agentUpdate(
    created.id,
    [{ background: backgrounds[0]!.id, texts: ["The agent's draft"] }],
    read.version,
  );
  expect(agent.status).toBe(200);

  const stale = await personSave(read, "Renamed from the stale copy");
  expect(stale.status).toBe(409);
  const refused = (await stale.json()) as {
    error: string;
    currentVersion: number;
    project: Project;
  };
  expect(refused.error).toBe("This slideshow changed since you loaded it.");
  expect(refused.currentVersion).toBe(read.version + 1);
  // The refusal carries the server's copy, which is what lets the editor reload
  // straight from the error instead of asking again.
  expect(refused.project.slides[0]?.texts?.[0]?.text).toBe("The agent's draft");

  const stored = await readProject(baseUrl, created.id);
  expect(stored.name).toBe("Two writers");
  expect(stored.slides[0]?.texts.map((text) => text.text)).toEqual(["The agent's draft"]);
});

it("reloads from the 409 when the live stream is down", async () => {
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Stream down",
    ratio: { w: 4, h: 5 },
    slides: [{ background: backgrounds[0]!.id, texts: ["Before the outage"] }],
  });

  trackStreams();
  await openApp(editPath(created.editUrl));
  await expect
    .element(page.getByLabelText("Text layer: Before the outage"))
    .toBeVisible();
  // With the stream gone the editor hears nothing, so its next save is stale and
  // the 409 is the only thing left protecting the agent's work. That branch is
  // unreachable while the stream is up, because the reload always wins the race.
  dropStreams();

  const response = await agentUpdate(created.id, [
    { background: backgrounds[2]!.id, texts: ["Written during the outage"] },
  ]);
  expect(response.status).toBe(200);

  await userEvent.fill(page.getByLabelText("Slideshow name"), "Renamed while stale");

  // The stale save is refused, the editor adopts the server's copy from the
  // refusal, and the agent's line arrives on screen without any stream.
  await expect
    .element(page.getByLabelText("Text layer: Written during the outage"))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Text layer: Before the outage"))
    .not.toBeInTheDocument();

  const stored = await readProject(baseUrl, created.id);
  expect(stored.name).toBe("Stream down");
  expect(stored.slides[0]?.texts.map((text) => text.text)).toEqual([
    "Written during the outage",
  ]);
});

/**
 * Lets a matching request reach the server and answer, then holds its response.
 *
 * The other half of `holdRequests`. Holding before dispatch makes the person's
 * write stale and takes the 409; holding after it makes the write *land*, which
 * is the case the 409 never sees and the one the deferral exists for.
 */
function holdResponses(match: (url: string, method: string) => boolean): {
  /** How many answered requests are waiting to be handed back. */
  waiting: () => number;
  release: () => void;
} {
  const native = window.fetch.bind(window);
  let waiting = 0;
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const response = await native(input, init);
    if (match(url, method.toUpperCase())) {
      waiting += 1;
      await gate;
    }
    return response;
  };
  return {
    waiting: () => waiting,
    release: () => {
      window.fetch = native;
      open();
    },
  };
}

it("takes the 409 when the agent writes while the person's save is in flight", async () => {
  /*
   * The report for round one said this branch was unreachable while the stream
   * was up. That was wrong, and the product says so itself: the editor declines
   * to reload over a write already in flight, because that write will either
   * land or take the 409, which reloads through the same path. This is that
   * path, with a healthy stream throughout.
   */
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Stream up",
    ratio: { w: 4, h: 5 },
    slides: [{ background: backgrounds[0]!.id, texts: ["Before the agent"] }],
  });

  trackStreams();
  await openApp(editPath(created.editUrl));
  await expect.element(page.getByLabelText("Text layer: Before the agent")).toBeVisible();
  await streamsRegistered();

  // Held before dispatch, so the editor is in "saving" when the frame arrives
  // and declines to reload over its own write. That is the state the 409 exists
  // for, and the only way to enter it deliberately.
  const save = holdRequests(
    (url, method) => method === "PUT" && url.includes("/api/projects/"),
  );
  try {
    await userEvent.fill(page.getByLabelText("Slideshow name"), "Renamed while saving");
    /*
     * The save reaching the gate is the precondition, not the server still
     * holding version one. The debounce means the write leaves later than the
     * typing, and a test that only checked the server would pass before the
     * save had been attempted at all, which is the state this test is not
     * about.
     */
    await expect.poll(save.waiting, { timeout: 10000 }).toBeGreaterThan(0);
    expect((await readProject(baseUrl, created.id)).version).toBe(created.version);

    // Watched before the write, so the frame cannot arrive unobserved.
    const frames = watchFrames();
    const agent = await agentUpdate(created.id, [
      { background: backgrounds[1]!.id, texts: ["Written by the agent"] },
    ]);
    expect(agent.status).toBe(200);

    /*
     * The frame has to reach the page before the save is released, or the
     * editor never sees it while saving and the assertions below would be
     * measuring which of the two won a race rather than which path the product
     * takes.
     */
    await expect
      .poll(
        () =>
          frames.some(
            (frame) =>
              frame.projectId === created.id && (frame.version ?? 0) > created.version,
          ),
        { timeout: 10000 },
      )
      .toBe(true);
  } finally {
    save.release();
  }

  // The held save lands stale, the server refuses it, and the editor adopts the
  // copy the refusal carries. The stream never went away.
  await expect
    .element(page.getByLabelText("Text layer: Written by the agent"))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Text layer: Before the agent"))
    .not.toBeInTheDocument();
  expect(opened.every((stream) => stream.readyState === EventSource.OPEN)).toBe(true);

  /*
   * The refusal itself, which is the assertion this test exists for. The rename
   * never reached the server, so the PUT released above was answered 409 rather
   * than written, and the document on screen came from the copy that refusal
   * carried.
   *
   * Which of the two reload paths painted the screen is deliberately not
   * claimed. They converge on the same observable end state, and the one thing
   * that would tell them apart, the stream path's toast, dismisses itself after
   * 2.6 seconds, so its absence would pass whether or not it had ever appeared.
   * The 409 is taken either way, which is the whole of finding 2.2: this branch
   * is reachable with the stream up.
   */
  await expect
    .poll(async () => (await readProject(baseUrl, created.id)).name, { timeout: 10000 })
    .toBe("Stream up");
  const stored = await readProject(baseUrl, created.id);
  expect(stored.slides[0]?.texts.map((text) => text.text)).toEqual([
    "Written by the agent",
  ]);
});

it("reloads for an event it deferred once the person's save succeeds", async () => {
  /*
   * The other side of the in-flight guard, and the half no other test reaches.
   *
   * Declining to reload over a write on the wire is right, but the write that
   * *lands* leaves nothing behind: the person's PUT is answered 200, so no 409
   * carries the server's copy back, and an event dropped at that moment is gone
   * with a healthy stream and nothing on screen to say so. The editor defers the
   * version instead and reconsiders it once the save settles.
   *
   * The previous test enters the deferral and then discards it, because a 409
   * has already replaced the document. This one is the reconsideration.
   */
  const { backgrounds } = await seedLibrary(baseUrl);
  const created = await createSlideshow(baseUrl, {
    name: "Deferred reload",
    ratio: { w: 4, h: 5 },
    slides: [{ background: backgrounds[0]!.id, texts: ["Before the deferral"] }],
  });

  trackStreams();
  await openApp(editPath(created.editUrl));
  await expect
    .element(page.getByLabelText("Text layer: Before the deferral"))
    .toBeVisible();
  await streamsRegistered();

  // Held after the server answered, so the person's write is on disk while the
  // editor still believes it is saving.
  const save = holdResponses(
    (url, method) => method === "PUT" && url.includes("/api/projects/"),
  );
  try {
    await userEvent.fill(page.getByLabelText("Slideshow name"), "Renamed by the person");
    await expect.poll(save.waiting, { timeout: 10000 }).toBeGreaterThan(0);
    // The write landed rather than being refused, which is what makes this the
    // case the 409 never covers.
    const written = await readProject(baseUrl, created.id);
    expect(written.name).toBe("Renamed by the person");
    expect(written.version).toBeGreaterThan(created.version);

    const frames = watchFrames();
    const agent = await agentUpdate(created.id, [
      { background: backgrounds[1]!.id, texts: ["Written during the save"] },
    ]);
    expect(agent.status).toBe(200);

    // The frame must reach the page while the editor is still saving, or it is
    // never deferred and this test would be watching an ordinary reload.
    await expect
      .poll(
        () =>
          frames.some(
            (frame) =>
              frame.projectId === created.id && (frame.version ?? 0) > written.version,
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    // Nothing has reloaded yet: the editor is holding the version it owes.
    await expect
      .element(page.getByLabelText("Text layer: Before the deferral"))
      .toBeVisible();
  } finally {
    save.release();
  }

  // The save settles, the owed version is reconsidered against the document it
  // now holds, and the agent's line arrives. Without the deferral this frame was
  // simply gone and the editor sat here until the person reloaded the page.
  await expect
    .element(page.getByLabelText("Text layer: Written during the save"))
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Text layer: Before the deferral"))
    .not.toBeInTheDocument();

  // The person's rename survived, because it landed rather than being refused.
  const stored = await readProject(baseUrl, created.id);
  expect(stored.name).toBe("Renamed by the person");
  expect(stored.slides[0]?.texts.map((text) => text.text)).toEqual([
    "Written during the save",
  ]);
});
