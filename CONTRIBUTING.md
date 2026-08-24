# Contributing

Slide Studio is a TypeScript project. One Fastify server holds the API, the MCP
endpoint, and the built client. One React app holds the editor. One pure library
sits under both and owns every number either of them draws.

## The layout

```
src/shared/   Pure TypeScript. Geometry, text layout, composition, Zod schemas.
src/server/   Fastify. Routes, MCP tools, SQLite services, the CLI.
src/web/      React. The design system, the dashboard, the library pages, the editor.
tests/e2e/    Browser tests against a real server on a real port.
assets/       The TikTok Sans font, the SVG marks, and the two licence notices.
bin/          The published entry point.
```

`index.html` at the repo root is Vite's entry. It carries `<div id="root">` and
the module script for `src/web/main.tsx`. Do not delete it.

## Where a change goes

Ask what the change is made of, not where it will be seen.

A formula belongs in `src/shared`. Anything that turns a slide into coordinates,
wraps a line, rounds a pill corner, clamps a crop, or fits an overlay to a
canvas is a formula. The editor and the PNG exporter both call it, so it lives
in one place or they disagree.

A route, a tool, a query, or a flag belongs in `src/server`. That is the only
root allowed to touch the filesystem, the database, or the network.

A component, a hook, or a stylesheet belongs in `src/web`. Presentation lives
here. Arithmetic does not.

## Two rules that hold the design together

**`src/shared` stays pure.** No `node:` import, no `window`, no `document`, no
`fetch`, no clock, and no random source. Every function takes what it needs and
returns a value. The browser bundles this root and the server compiles it
unbundled, so anything platform-specific breaks one of the two.

**No renderer computes text geometry of its own.** `computeTextLayout` in
`src/shared/text/layout.ts` returns every line box, every pill path, and every
offset. `src/web/features/editor/text/renderTextDom.tsx` draws the DOM from that
object and `src/web/features/editor/export/render.ts` draws the canvas from the
same object. Neither one derives a coordinate. A renderer that works a number
out for itself is how the editor and the export drift apart, and the drift shows
up as a wrapped line that moves when you download it.

## Tests

`npm test` runs four Vitest projects.

| Project  | Where it runs      | What it covers                                                    |
| -------- | ------------------ | ----------------------------------------------------------------- |
| `shared` | Node               | `src/shared/**/*.test.ts` and the editor's pure store and history |
| `server` | Node               | `src/server/**/*.test.ts`, against an injected Fastify app        |
| `web`    | Chromium           | `src/web/**/*.browser.test.tsx`                                   |
| `e2e`    | Chromium + Fastify | `tests/e2e/**/*.e2e.test.ts`, against a real server               |

The `web` and `e2e` projects drive a real browser, so they need Chromium from
Playwright. Run `npx playwright install chromium` once.

Pick the project from what you changed. A formula needs a `shared` test. A route
or a tool needs a `server` test. A component needs a `web` test. A change that
only holds together across the API, the database, and the browser needs an `e2e`
test.

Run one project while you work with `npm run test:shared`, `npm run test:server`,
`npm run test:web`, or `npm run test:e2e`.

`npm run test:coverage` enforces 90% statements on `src/shared` and 85% on
`src/server`. Add the missing test rather than lowering the threshold.

## Working on it

```bash
npm install
npm run dev:all      # the API with a watcher, plus the Vite dev server
npm run check        # both typechecks, ESLint, and Prettier
npm test
```

`npm run dev` starts the API alone on port 4173. `npm run dev:web` starts Vite
alone on port 5173 and proxies `/api`, `/media`, and `/mcp` to the API. `npm run
dev:all` runs both.

`npm start` runs the built server, so run `npm run build` first.

## Where the `app.js` and `styles.css` line numbers point

Around a thousand comments across `src/shared` and `src/web` cite the file and
line this behaviour was ported from, in the form `app.js:2723` or
`styles.css:1798`. Both files are deleted. They were the whole pre-rewrite app,
4884 lines of JavaScript and 3443 lines of CSS at the repo root.

The citations still resolve, through git rather than through the working tree.
Commit `c6b3970` is the last one that carries them:

```bash
git show c6b3970:app.js | sed -n '2723p'
git show c6b3970:styles.css | sed -n '1798p'
```

Keeping the files only to keep the citations live would have kept 250KB of dead
code in every checkout. The citations record why a formula is shaped the way it
is, which is worth reading when you change one, and git holds that for as long
as the repo exists.

## Two defects carried on purpose

Neither is a bug someone missed. Both are recorded so the next person does not
rediscover them, and neither is in scope for the rewrite.

**The auto-layout engine gives every overlay a negative width and height when a
slide carries many assets and an overflowing text block.** `layoutAssets` in
`src/shared/compose/compose.ts` subtracts its gaps from the asset band with no
floor. Once the rows outgrow the band, every overlay comes out negative and
renders as nothing. Ten assets plus an overflowing text block is enough.
`tests/e2e/agent-flow.e2e.test.ts` carries a test failing on purpose for it,
"gives an overlay a real size when a slide carries many assets", written as
`it.fails` so it turns red the day someone fixes the engine. Delete the `.fails`
then.

**`list()` reports the page length rather than the match count when a search
term is given.** `LibraryService.list` in `src/server/services/library.ts`
returns `total: rows.length` on the FTS branch and `total: this.count(...)` on
the unfiltered branch. An agent paging through search results reads a `total`
that never exceeds its own `limit`. The route and the MCP tool both pass it
through, so fixing it changes an API that agents read.

## Before you open a pull request

Run `npm run check && npm test`. CI runs the same two commands and blocks the
merge when either fails. A failing test on your branch is yours to fix, whoever
wrote it.
