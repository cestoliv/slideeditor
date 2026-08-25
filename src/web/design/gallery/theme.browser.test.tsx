import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../tokens.css";
import "../reset.css";
// The token layer as text. The lists below are derived from it rather than typed
// out, so a token added to one block and forgotten in another is a failure here
// instead of a wrong colour in the gallery.
import tokensCss from "../tokens.css?raw";

/*
 * tokens.css carries the theme-varying values three times: once inside the
 * prefers-color-scheme media query, and once in each pinned [data-theme] block
 * the gallery needs to show light and dark side by side. Plain CSS gives no way
 * to share one declaration block between a media query and a selector, so this
 * file is the guard against the three drifting apart.
 */

function declarationsIn(source: string): string[] {
  return [...source.matchAll(/(--[a-z0-9-]+|color-scheme)\s*:/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

function block(pattern: RegExp): string {
  const match = pattern.exec(tokensCss);
  if (match === null)
    throw new Error(`tokens.css has no block matching ${String(pattern)}`);
  return match[1] ?? "";
}

const mediaBlock = block(
  /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/,
);
const darkBlock = block(/\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
const lightBlock = block(/\[data-theme="light"\] \{([\s\S]*?)\n\}/);

const themed = declarationsIn(mediaBlock).filter((name) => name !== "color-scheme");

function Pair() {
  return (
    <>
      <div data-theme="light" data-testid="light" />
      <div data-theme="dark" data-testid="dark" />
    </>
  );
}

it("finds every block it is meant to guard", () => {
  // If a rewrite of tokens.css changes the shape of these blocks, this fails
  // loudly rather than leaving the rest of the file quietly checking nothing.
  expect(themed.length).toBeGreaterThan(20);
});

it("declares the same properties in the media query and in both pinned blocks", () => {
  const media = declarationsIn(mediaBlock);
  expect(declarationsIn(darkBlock)).toEqual(media);
  expect(declarationsIn(lightBlock)).toEqual(media);
});

it("gives every themed token a different value in each pinned theme", async () => {
  const screen = await render(<Pair />);
  const light = getComputedStyle(screen.getByTestId("light").element());
  const dark = getComputedStyle(screen.getByTestId("dark").element());

  const same = themed.filter(
    (token) => light.getPropertyValue(token) === dark.getPropertyValue(token),
  );
  // A pinned block that repeats the light value rather than the dark one lands
  // here, which is the copy-paste this arrangement invites.
  expect(same).toEqual([]);
});

it("resolves every themed token rather than leaving one empty", async () => {
  const screen = await render(<Pair />);
  for (const theme of ["light", "dark"]) {
    const style = getComputedStyle(screen.getByTestId(theme).element());
    const empty = themed.filter((token) => style.getPropertyValue(token).trim() === "");
    expect(empty).toEqual([]);
  }
});

it("pins a theme against the operating system's preference", async () => {
  const screen = await render(<Pair />);
  const light = getComputedStyle(screen.getByTestId("light").element());
  const dark = getComputedStyle(screen.getByTestId("dark").element());
  // The literal is the assertion: whichever way the machine running this test is
  // set, light stays light and dark stays dark.
  expect(light.getPropertyValue("--color-ink").trim()).toBe("#151515");
  expect(dark.getPropertyValue("--color-ink").trim()).toBe("#f4f5f0");
  expect(light.colorScheme).toBe("light");
  expect(dark.colorScheme).toBe("dark");
});
