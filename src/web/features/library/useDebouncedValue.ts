import { useEffect, useState } from "react";

/**
 * The search box's delay. app.js:1403 waited 200ms after the last keystroke
 * before re-rendering the grid, so a search of a large library never filtered
 * on a half typed word.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * The value as it was `delay` milliseconds after it last changed. Each change
 * cancels the pending one, so typing publishes once rather than once per key.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return settled;
}
