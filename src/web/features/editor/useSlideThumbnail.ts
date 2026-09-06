import { useEffect, useRef, useState } from "react";
import { THUMBNAIL_WIDTH, thumbnailHeight } from "@shared/geometry/index.js";
import type { Ratio, Slide } from "@shared/schema/index.js";

/*
 * One slide's thumbnail. Ported from refreshSlideThumbnail, thumbnailSignature
 * and scheduleThumbnailRefresh (app.js:1581-1645).
 *
 * Two of the old pipeline's problems are fixed rather than carried over. It
 * never revoked an object URL on teardown, so a session leaked one blob per
 * redraw per slide; and its cache key read slide.backgroundRevision, a field
 * only handleSlideBackgroundChange ever wrote (app.js:3032), so a background
 * changed by any other route kept the stale picture.
 */

/** app.js:1584. How long the slide has to sit still before it is redrawn. */
export const THUMBNAIL_DEBOUNCE_MS = 80;

/** Draws a slide to a PNG. Task 17's renderSlideBlob is the real one. */
export type ThumbnailRenderer = (
  slide: Slide,
  size: { width: number; height: number },
) => Promise<Blob>;

export type SlideThumbnailOptions = {
  ratio: Ratio;
  /** Without one, the rail shows its placeholder rather than a stale picture. */
  render?: ThumbnailRenderer | undefined;
  debounceMs?: number | undefined;
  /** Bumping this redraws a slide whose signature hasn't changed - how a failed render is retried. */
  attempt?: number | undefined;
};

export type ThumbnailStatus = "loading" | "ready" | "error";

export type SlideThumbnailResult = {
  /** The last blob drawn, or null. A failed redraw keeps whatever picture is already up. */
  url: string | null;
  status: ThumbnailStatus;
};

/**
 * A cheap deep equality over everything a thumbnail draws (app.js:1590-1600).
 * backgroundItemId stands in for the old backgroundRevision, which the parsed
 * document does not carry and which missed every background change but one.
 */
export function thumbnailSignature(slide: Slide, ratio: Ratio): string {
  return JSON.stringify([
    ratio,
    slide.backgroundItemId,
    slide.imageScale || 1,
    slide.imageX || 0,
    slide.imageY || 0,
    slide.texts,
    slide.overlays,
  ]);
}

export function useSlideThumbnail(
  slide: Slide,
  options: SlideThumbnailOptions,
): SlideThumbnailResult {
  const { ratio, render, debounceMs = THUMBNAIL_DEBOUNCE_MS, attempt = 0 } = options;
  const signature = thumbnailSignature(slide, ratio);
  // thumbnailSignature stays a pure read of what a thumbnail draws, so a retry
  // (which draws nothing new) is folded in here rather than into it.
  const drawKey = `${signature}#${String(attempt)}`;
  const [url, setUrl] = useState<string | null>(null);
  // Without a render function, the rail's placeholder (status "loading") is
  // exactly the right thing to show forever.
  const [status, setStatus] = useState<ThumbnailStatus>("loading");
  // The URL is held twice: in state for the render, and in a ref so teardown
  // can hand it back without listing it as a dependency of the effect that
  // replaces it. Revoking from that effect's cleanup would kill the picture
  // currently on screen.
  const urlRef = useRef<string | null>(null);
  const drawnRef = useRef<string | null>(null);
  // app.js renders the whole rail at once on open and debounces only the
  // refreshes that follow, so the first picture is never held back.
  const drewOnceRef = useRef(false);

  const width = THUMBNAIL_WIDTH;
  const height = thumbnailHeight(ratio);

  useEffect(() => {
    if (render === undefined) return;
    // Skipping a key already drawn means it was drawn successfully - a failed
    // attempt never reaches the line that sets drawnRef - so "ready" is exactly
    // right here. Otherwise reverting to an earlier signature after a later
    // one failed left status stuck on "error" over a picture that is correct.
    if (drawnRef.current === drawKey) {
      setStatus("ready");
      return;
    }

    let cancelled = false;
    const draw = () => {
      // "In flight" starts here, not when the debounce timer was set, so a
      // picture already on screen keeps showing "ready" through the quiet
      // period rather than flickering to "loading" on every keystroke.
      setStatus("loading");
      void render(slide, { width, height })
        .then((blob) => {
          /*
           * app.js:1602-1612 kept a per-slide version counter here, because it
           * re-entered refreshSlideThumbnail from anywhere and had no way to
           * call off a render already running. An effect does: React runs this
           * run's cleanup before the next one starts, so `cancelled` alone
           * drops every overtaken render. A counter as well would be a second
           * guard on the same door, and one no test could ever redden.
           */
          if (cancelled) return;
          const next = URL.createObjectURL(blob);
          const previous = urlRef.current;
          urlRef.current = next;
          drawnRef.current = drawKey;
          setUrl(next);
          setStatus("ready");
          if (previous !== null) URL.revokeObjectURL(previous);
        })
        .catch((error: unknown) => {
          // app.js:1637 logs and leaves the placeholder up. A slide that cannot
          // be drawn must not take the rail down with it. The url is untouched,
          // so whatever picture was already up stays up; status alone reports
          // the failure, for the rail's retry affordance to act on.
          console.error(error);
          if (cancelled) return;
          setStatus("error");
        });
    };

    /*
     * Both paths return the same cleanup. The first draw used to return none,
     * so unmounting while it was still rendering left `cancelled` false: the
     * render then landed, minted an object URL, and stored it on a hook nobody
     * would ever revoke it from. That is the leak the brief singled out, on the
     * one path that skipped the guard.
     */
    let timer: number | null = null;
    if (drewOnceRef.current) timer = window.setTimeout(draw, debounceMs);
    else {
      drewOnceRef.current = true;
      draw();
    }
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [drawKey, render, slide, width, height, debounceMs]);

  useEffect(
    () => () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  return { url, status };
}
