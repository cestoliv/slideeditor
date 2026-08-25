# Slide Studio

A local editor and agent backend for TikTok and Instagram slideshow images.

You curate an image library. An agent drafts slideshows from it and hands back an
edit URL. You adjust the layout by hand, export every slide, and publish.

Everything runs on your own machine. Nothing is sent to a third party.

## The flow

1. You fill the background and asset libraries through the admin pages.
2. You ask an agent for a slideshow.
3. The agent searches the libraries and drafts it, then gives you an edit URL.
4. You open the URL and move things around until it looks right.
5. You export every slide as a ZIP and publish them yourself.

The agent chooses images and words. It never chooses layout or styling.

## Run it

Needs Node 22 or newer.

```bash
npx github:cestoliv/slideeditor
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

That is the whole setup. There is nothing to install and nothing to configure.
Each run pulls the current default branch, so you are always on the latest
version.

The first run builds the editor before it starts, so it takes a minute. Later
runs reuse npm's cache and start straight away.

To work on the code instead, see [Working on the code](#working-on-the-code).

Data lives in `~/.slide-studio`: a SQLite database, the image files, and the
access token. Back up that one directory and you have backed up everything.

| Flag             | Default           | Purpose                                                            |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| `--port`         | `4173`            | Port to listen on                                                  |
| `--host`         | `127.0.0.1`       | Interface to bind. Use `0.0.0.0` to reach it from another machine. |
| `--data`         | `~/.slide-studio` | Data directory                                                     |
| `--allowed-host` | none              | Extra hostname to accept, repeatable                               |

`SLIDE_STUDIO_PORT` and `SLIDE_STUDIO_DATA` work as environment variables too.

## What it does

### Library

- Two libraries, backgrounds and assets, each with its own admin page at
  `/library/backgrounds` and `/library/assets`
- Every item carries a description of what the image shows and guidance on when
  to use it. An agent reads both to choose well.
- Every item also tracks how often it has been used and when it was last used,
  so an agent can favour the ones it has been ignoring
- Full-text search across name, description, usage, and tags
- Identical images are stored once, whatever they are named
- Deleting an item in use warns you which slideshows it would break

### Editing

- Sets one aspect ratio per slideshow: 9:16 for TikTok, 3:4, 4:5, 1:1, or 1.91:1
  for Instagram, plus any custom ratio
- Keeps the layout intact when the ratio changes, and never distorts an overlay
- Crops each photo with drag and zoom controls
- Shows every slide in the sidebar and supports drag-to-reorder
- Adds photo overlays by dragging a library asset onto the image, then resizing
  or rotating it
- Adds multiline text layers that can be dragged, resized, and rotated
- Offers text color presets plus a live color wheel with hex and RGB values
- Includes clean text, adjustable outlines, per-line rounded backgrounds, and
  full-box backgrounds
- Previews TikTok, Instagram feed, or Instagram Stories chrome, suggested from
  the ratio and never exported
- Uses the official open-source TikTok Sans font

### Export

- Downloads the selected slide as a 1080-pixel-wide PNG
- Downloads every slide at once as a ZIP
- Shares one slide or every slide through the system share sheet

### Status

Each slideshow is `draft`, `ready`, or `published`. New ones start as `draft`.
Set it from the switch in the editor header, or let an agent set it.

Published slideshows are hidden from the dashboard and from the agent's default
list, because that work is already posted. Tick **Show published** to see them.
The status is a label, not a lock: you can still edit a published slideshow, and
doing so does not change its status.

## For agents

This section is written for an AI agent setting itself up. If you are a person,
you can hand this whole section to your agent.

### 1. Start the server

```bash
npx github:cestoliv/slideeditor
```

Leave it running. It serves the editor and the MCP endpoint on the same port.

### 2. Register the MCP server

On the same machine:

```bash
claude mcp add --transport http slide-studio http://127.0.0.1:4173/mcp
```

For another MCP client, point it at `http://127.0.0.1:4173/mcp` over Streamable
HTTP.

### 3. Tools

| Tool                   | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `list_library`         | List or search backgrounds and assets, with usage stats             |
| `get_library_item`     | Read one item, including its usage guidance                         |
| `list_slideshows`      | List slideshows with ids, versions, status, captions, and edit URLs |
| `get_slideshow`        | Read one slideshow's composition, status, and caption               |
| `create_slideshow`     | Draft a slideshow and its caption. Returns the edit URL.            |
| `update_slideshow`     | Edit an existing one, guarded by its version                        |
| `set_slideshow_status` | Move a slideshow between draft, ready, and published                |

### 4. How to draft a slideshow

Search before you choose. Call `list_library` with a query describing what the
slide needs, not a filename. Every item carries a `description` of what the
image shows and a `usage` note saying when to use it. Read both. An item whose
usage says "opening slide for travel posts" belongs on slide 1 of a travel
slideshow and nowhere else.

Then vary. Every item also carries `stats`:

```json
"stats": { "timesUsed": 12, "slideshowCount": 4, "firstUsedAt": 0, "lastUsedAt": 0 }
```

When several items fit the slide equally well, take the one with the lower
`timesUsed`, or the older `lastUsedAt`. Sort by `least-used` to see the
neglected ones first. Without this, every slideshow ends up using the same three
images.

Then call `create_slideshow`. Each slide takes one `background` id, any number of
`assets` ids, and any number of `texts` lines in reading order:

```json
{
  "name": "Summer travel tips",
  "ratio": { "w": 4, "h": 5 },
  "description": "Five things to know before you book a summer trip.",
  "hashtags": ["travel", "summer"],
  "slides": [
    {
      "background": "<background id>",
      "assets": ["<asset id>"],
      "texts": ["Booking a summer trip?", "Five things to know first"]
    },
    {
      "background": "<background id>",
      "assets": [],
      "texts": ["1. Prices peak in July"]
    }
  ]
}
```

Write the caption as part of the draft. A slideshow exists to be posted, and the
`description` and the `hashtags` are what gets pasted into TikTok or Instagram
beside the images, so a placeholder there is work the human has to redo.

Hashtags go in as a list or as one string, and the leading `#` is optional.
What comes back is always one string, `"#travel #summer"`, whichever way they
went in. A tag repeated in any casing is kept once, and only the first 30 are
stored, which is Instagram's own limit. A description stops at 2200 characters,
the caption limit on both platforms.

The human edits both behind the Caption button in the editor's header, and
copies each one out when they post.

Pick the ratio from where it will be posted: `9:16` for TikTok, Reels, or
Stories; `4:5` or `3:4` for an Instagram feed post; `1:1` for a square; `1.91:1`
for landscape. Default is 9:16.

Do not try to set positions, sizes, colors, or fonts. There are no parameters for
them. The server places everything, and the human adjusts it afterwards. That
split is the point of the tool.

Finish by giving the user the `editUrl` from the response. That is the
deliverable. Say what is on each slide, and leave the layout to them.

### 5. Editing a slideshow later

Call `get_slideshow` first and pass the `version` it returns to
`update_slideshow`. A stale version is rejected rather than overwriting work the
human did in the meantime. On rejection, read the slideshow again and redo your
change on top of the current state.

A caption field you leave out keeps what is stored, so editing the slides never
wipes a caption the human has been working on. Send an empty string to clear one
on purpose.

Slides whose composition you leave untouched keep the exact layout the human
gave them. On a slide you do change, any asset or text line that is still there
keeps its position too. So a small edit stays small.

### 6. Status

`list_slideshows` hides published slideshows by default. Pass `status: "all"` to
see everything. Leave new drafts as `draft`: `ready` is the human's call once
they have adjusted the layout, and `published` means they have posted it.

### 7. What to do when a tool fails

- **`No library item with id …`** — the id is wrong or the item was deleted.
  Search again.
- **`Library item … is an asset, expected a background`** — backgrounds and
  assets are separate. Filter by `kind` when searching.
- **`This slideshow changed since you loaded it`** — re-read with
  `get_slideshow` and retry with the new version.
- **An empty library** — the user has not uploaded anything yet. Ask them to add
  images at `/library/backgrounds` and `/library/assets`, with a description and
  a usage note on each. Do not invent ids.

## From another machine

```bash
npx github:cestoliv/slideeditor --host 0.0.0.0
```

The server prints a token on first start and stores it at
`~/.slide-studio/token`. Every request from another machine must carry it:

```bash
claude mcp add --transport http slide-studio http://<your-ip>:4173/mcp \
  --header "Authorization: Bearer <token>"
```

Requests from the machine itself skip the token, so the local editor needs no
setup. To open the editor from another machine, append the token once:
`http://<your-ip>:4173/?token=<token>`.

This is a single-user tool with one shared token. It suits a home or office
network. Do not expose it to the open internet.

## HTTP API

The MCP tools are a thin wrapper over these routes, which you can call directly.

```
GET    /api/health
GET    /api/library?kind=&q=&sort=&limit=&offset=
GET    /api/library/:id
POST   /api/library
PATCH  /api/library/:id
DELETE /api/library/:id          409 when in use, unless force=1
GET    /api/projects?status=
POST   /api/projects
GET    /api/projects/:id
PUT    /api/projects/:id         guarded by version
PATCH  /api/projects/:id/status
DELETE /api/projects/:id
GET    /api/slideshows?status=   hides published unless asked
POST   /api/slideshows           returns editUrl
PUT    /api/slideshows/:id       guarded by version
PATCH  /api/slideshows/:id/status
GET    /api/events               server-sent events
GET    /media/:file
```

Writes to a slideshow carry the version you read. A stale write gets a 409
instead of overwriting someone else's work, and an open editor reloads when an
agent changes the slideshow you are looking at.

## Working on the code

```bash
git clone https://github.com/cestoliv/slideeditor.git
cd slideeditor
npm install
npm run dev:all
```

`npm run dev:all` starts the API with a watcher on port 4173 and the Vite dev
server on port 5173 together. Open the Vite one. It proxies `/api`, `/media`,
and `/mcp` to the API. `npm run dev` and `npm run dev:web` start each half on
its own.

`npm start` runs the built server, so it needs `npm install` and `npm run build`
first.

The code sits in three roots. `src/shared` holds pure TypeScript: geometry, text
layout, composition, and the schemas. `src/server` holds Fastify, the MCP tools,
and the SQLite services. `src/web` holds the React editor and the design system.

### Tests

```bash
npm test
```

That runs four Vitest projects: `shared` and `server` in Node, `web` and `e2e`
in a real browser. The two browser projects need Chromium from Playwright, so
run `npx playwright install chromium` once.

Run one at a time with `npm run test:shared`, `npm run test:server`,
`npm run test:web`, or `npm run test:e2e`. `npm run check` runs both typechecks,
ESLint, and Prettier.

[CONTRIBUTING.md](CONTRIBUTING.md) covers where a change goes, which test
project it needs, and the two rules that keep the editor and the export drawing
the same picture.

## License

MIT. TikTok Sans is distributed under the SIL Open Font License 1.1; its license
is included at `assets/TikTokSans-OFL.txt`. The GitHub Octicons mark is
distributed under the MIT License; its notice is included at
`assets/Octicons-LICENSE.txt`.
