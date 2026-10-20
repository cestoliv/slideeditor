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

The agent chooses images and words. It can pick a named anchor for a slide's
text and assets, but it never sends coordinates.

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

Data lives in `~/.slide-studio`: a SQLite database and the image files. Back up
that one directory and you have backed up everything.

| Flag               | Default           | Purpose                                                            |
| ------------------ | ----------------- | ------------------------------------------------------------------ |
| `--port`           | `4173`            | Port to listen on                                                  |
| `--host`           | `127.0.0.1`       | Interface to bind. Use `0.0.0.0` to reach it from another machine. |
| `--data`           | `~/.slide-studio` | Data directory                                                     |
| `--allowed-host`   | none              | Extra hostname to accept, repeatable                               |
| `--trust-proxy`    | off               | Trust the scheme and client address a reverse proxy forwards       |
| `--public-url`     | none              | URL to advertise instead of one built from `--host` and `--port`   |
| `--reset-password` | none              | Set a new password and sign out every existing session             |

`SLIDE_STUDIO_PORT`, `SLIDE_STUDIO_DATA`, `SLIDE_STUDIO_PASSWORD`,
`SLIDE_STUDIO_TRUST_PROXY`, and `SLIDE_STUDIO_PUBLIC_URL` work as environment
variables too.

An external tool can only fetch the URLs `export_slideshow` returns when
`--public-url` (or `SLIDE_STUDIO_PUBLIC_URL`) names an address it can reach.
Without it, `export_slideshow` still succeeds and adds a `warning` field
saying so.

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

If `SLIDE_STUDIO_PASSWORD` is set, add a bearer token instead. See
[Authentication](#authentication).

### 3. Tools

| Tool                   | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `list_accounts`        | List every account: its id, name, and defaults                      |
| `list_library`         | List or search backgrounds and assets, with usage stats             |
| `get_library_item`     | Read one item, including its usage guidance                         |
| `list_slideshows`      | List slideshows with ids, versions, status, captions, and edit URLs |
| `get_slideshow`        | Read one slideshow's composition, status, and caption               |
| `create_slideshow`     | Draft a slideshow and its caption. Returns the edit URL.            |
| `update_slideshow`     | Edit an existing one, guarded by its version                        |
| `duplicate_slideshow`  | Copy a slideshow into a new draft in the same account               |
| `delete_slideshow`     | Delete a draft slideshow                                            |
| `set_slideshow_status` | Move a slideshow between draft, ready, and published                |
| `export_slideshow`     | Get temporary public image URLs for a ready slideshow's slides      |
| `revoke_export`        | Revoke a slideshow's export URLs before they expire                 |
| `create_account`       | Create an account, with partial defaults                            |
| `update_account`       | Rename an account or change its defaults                            |
| `add_library_item`     | Add an image to a library from a URL or base64                      |
| `update_library_item`  | Rewrite an item's name, description, usage, tags, or layout hints   |
| `preview_slideshow`    | See approximate JPEGs of a slideshow's slides, with layout warnings |

### 4. How to draft a slideshow

Start with `list_accounts` if you do not already know the account's id. Every
slideshow and every library item belongs to exactly one account, and
`create_slideshow` requires one. Pass the same id as `accountId` to
`list_library` or `list_slideshows` to see only that account's images or
slideshows; omit it there to see every account's.

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

Then call `create_slideshow`. It requires `accountId`. Each slide takes one
`background` id, any number of `assets` ids, and any number of `texts` lines in
reading order:

```json
{
  "accountId": "<account id>",
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

Do not try to set positions or fonts. There are no parameters for them. The
server places everything, and the human adjusts it afterwards. That split is the
point of the tool. What you can pick is a named anchor per slide, described in
Moving a slide's text or assets.

The server keeps everything inside a safe zone clear of the TikTok interface:
below 7% of the height, above 80%, and left of 76% of the width. Texts start
at 10% from the left and touch, so they read as one block. The block's centre
depends on the slide's place in the slideshow: 36% of the height on the first
slide (the hook), 47% on the middle slides, and 55% on the last slide (the call
to action). A lone asset sits top left, at most 40% of the width, and the text
moves below it when the two would overlap. Several assets share rows above the
text. A block too tall for the safe zone is placed as before: at the bottom, or
centred when it cannot fit the slide.

A background can carry `layoutHints` that say where its text goes. The server
moves the block into the `freeZone` third of the image, at the spot nearest its
role target, and off the `subject` box when another spot fits. A background with
no hints keeps the placement above. A slide's `text` anchor wins over the hints,
and hints never move the text into the slide's assets.

To make one line stand out, such as a hook set larger than the rest, pass that
line as an object instead of a string. A field you leave out takes the account's
default, and the server still places the line:

```json
"texts": [
  { "text": "Stop scrolling", "size": 96, "color": "#FFE600" },
  "Five things to know first"
]
```

The style fields are `size` (20 to 180), `style` (`plain`, `outline`, or
`boxed`), `color` and `background` as hex, `weight`, `italic`, and `align`.

Before you hand it over, call `preview_slideshow` to see each slide. It returns
one JPEG per slide and a list of `warnings`: text past the slide edge
(`text-out-of-frame`), text cut off by its box (`text-cut`), and an image drawn
over a text (`overlay-over-text`), and a text or image outside the safe zone
(`outside-safe-zone`). A text anchor moves a text up or down only, so a text
past the right edge of the zone needs shorter lines. The server draws the
preview with estimated text widths, so a line can wrap at a different word than
in the editor. Look at each image too: a text over a face or over the key part
of a screenshot needs to move.

#### Moving a slide's text or assets

To move what the preview shows in the wrong place, give that slide a `layout`
in `update_slideshow`. Every key is optional, and a key you leave out keeps the
default for the slide's role:

```json
"layout": { "text": "top", "assets": "bottom-left", "assetSize": "small" }
```

- `text` puts the text block at the `top`, `middle` or `bottom` of the safe
  zone.
- `assets` puts the assets `top-left`, `top-right`, `center` or `bottom-left`.
  Without it, a slide with a `text` anchor keeps its assets next to the text.
- `assetSize` makes each asset `small`, `medium` or `large`: at most 25%, 40% or
  60% of the slide width. Several assets share a row, so they can be narrower.

Texts and assets do not overlap. When the anchors you pick would make them, the
assets move out of the text's way, or else the text moves above or below them.
The response says so in `notes`. A text block taller than the safe zone ignores
its anchors, and can overlap the assets. An unknown anchor is refused.

`get_slideshow` returns each slide's `layout`. Send it back unchanged on the
slides you do not mean to move. A slide sent without its stored `layout` is laid
out again from its defaults, and loses the human's adjustments.

Then preview only the slides you changed. Stop after two rounds of fixes and
tell the user what is still wrong.

Finish by giving the user the `editUrl` from the response. That is the
deliverable. Say what is on each slide. The human makes the final adjustments.

### 5. Editing a slideshow later

Call `get_slideshow` first and pass the `version` it returns to
`update_slideshow`. A stale version is rejected rather than overwriting work the
human did in the meantime. On rejection, read the slideshow again and redo your
change on top of the current state.

A caption field you leave out keeps what is stored, so editing the slides never
wipes a caption the human has been working on. Send an empty string to clear one
on purpose.

Slides whose composition and `layout` you leave untouched keep the exact layout
the human gave them. A slide whose `layout` changes is laid out again from
scratch. On a slide you do change, any asset or text line that is still there
keeps its position too. So a small edit stays small.

To reuse a slideshow the human has already adjusted as a template, call
`duplicate_slideshow`. The copy is a new draft in the same account, with the
same layout and caption. Then change its texts with `update_slideshow`.

`get_slideshow` also returns `layoutChanged`: the number of slides the human
changed by hand since the slideshow was created or duplicated. A slide counts
when one of its texts or overlays moved, was resized, rotated, cropped,
rewritten, added, or removed. The server keeps the document exactly as
`create_slideshow` or `duplicate_slideshow` composed it, and never updates that
copy, so `update_slideshow` does not reset the count. The value is `null` for a
slideshow made in the editor.

To remove a draft you no longer need, call `delete_slideshow`. Only a draft can
be deleted. A ready or published slideshow is refused with a 409.

### 6. Exporting a slideshow

Call `export_slideshow` with the slideshow's `id` and `version` to get a public
image URL for every slide, in order. Hand these to a scheduling tool such as
Metricool, which imports media by URL rather than a file.

The slideshow must be `ready` before you export it, and `version` must match
what is stored, the same guard `update_slideshow` uses. Read `version` from
`get_slideshow` first.

Slides come back as JPEG at quality 92. Pass `format` to ask for `png` or
`webp` instead, and `quality` (1 to 100) to trade size against detail. The
server converts each slide over an opaque white background, so a transparent
pixel never reaches a feed composited against something the platform picked.
`quality` with `format: "png"` is refused, because PNG is lossless.

The browser still renders every slide as a PNG. The conversion happens once per
format and quality, so exporting the same version twice re-encodes nothing.

Each URL needs no credential and expires after 45 minutes. A URL serves only
the format its call asked for, so a JPEG URL cannot be edited into the PNG.

A `status` of `pending` means the editor has not rendered this version yet,
because the images render in the browser rather than on the server. Ask the
human to open the edit URL while the slideshow is `ready`, then call
`export_slideshow` again.

Call `revoke_export` once the scheduling tool finishes downloading. It stops
every URL early, whatever format each one serves, and keeps the rendered
images, so exporting again later does not make the human re-render anything.

### 7. Status

`list_slideshows` hides published slideshows by default. Pass `status: "all"` to
see everything. Leave new drafts as `draft`: `ready` is the human's call once
they have adjusted the layout, and `published` means they have posted it.

### 8. What to do when a tool fails

- **`No library item with id …`** — the id is wrong or the item was deleted.
  Search again.
- **`Library item … is an asset, expected a background`** — backgrounds and
  assets are separate. Filter by `kind` when searching.
- **`This slideshow changed since you loaded it`** — re-read with
  `get_slideshow` and retry with the new version.
- **An empty library** — nothing is uploaded yet. Add images with
  `add_library_item`, or ask the user to add them at `/library/backgrounds` and
  `/library/assets`. Do not invent ids.

### 9. Adding accounts and images

`create_account` takes a `name` and optional `defaults`. A field you leave out
of `defaults` takes the built-in value. `update_account` merges what you send
over the account's current defaults. New defaults apply to slideshows created
afterwards only. An existing slideshow keeps its ratio and layout.

`add_library_item` adds one image, from a public `url` or from base64 `data`.
Pass exactly one. It accepts PNG, JPEG, WebP, and GIF. `description` and `usage` are required, because they are what
`list_library` gives you to choose images with later. The server refuses a URL
on a private address, a download over 25 MB, and one that takes longer than 10
seconds. If the account already holds the same image as the same kind, nothing is added: the
existing item comes back with `duplicateOf`, so you can run an import again.

`update_library_item` rewrites a name, a description, a usage note, the tags, or
the layout hints. A field you leave out keeps its value.

Give every background `layoutHints` once. To fill them, fetch its `url` and look
at the image. All values are fractions of the image:

```json
"layoutHints": {
  "freeZone": "top",
  "subject": { "x": 0.25, "y": 0.4, "w": 0.5, "h": 0.35 }
}
```

`freeZone` is the third with the most empty space: `top`, `middle`, or
`bottom`. `subject` is the box around the face or the main subject. Hints apply
to slides composed afterwards only. An existing slide keeps its layout, and
`layoutHints: null` clears them.

`list_library` returns at most 200 items. To read a larger library, pass
`offset` and keep paging until it reaches `total`. Each item carries an absolute
`url`, which you can fetch with your token to look at the image.

## Authentication

Running locally with no password set needs no configuration. The server binds
`127.0.0.1` by default, so nothing outside your machine can reach it, and
`npx slide-studio` works exactly as described above.

Set `SLIDE_STUDIO_PASSWORD` to turn on the login screen everywhere, including
on your own machine. The variable only seeds the password on first run. After
that, change it from the Settings screen and the stored password wins, even if
the environment variable still holds the old value.

If you bind a public address with no password set, the server refuses to
start and names the variable to set:

```bash
npx github:cestoliv/slideeditor --host 0.0.0.0
```

Agents authenticate with a personal access token instead of a password.
Create one from the Settings screen, then register the MCP server with it:

```bash
claude mcp add --transport http slide-studio http://<your-ip>:4173/mcp \
  --header "Authorization: Bearer sst_..."
```

For another MCP client, send the same header on every request.

Running `--reset-password` signs out every existing session immediately. To
set a new password, run it with the same `--data` directory the server uses:

```bash
npx github:cestoliv/slideeditor --reset-password <new-password>
```

Passwords need at least 12 characters. The Settings screen and
`--reset-password` both enforce it.

### Behind a reverse proxy

A reverse proxy that terminates TLS needs `SLIDE_STUDIO_TRUST_PROXY=1`.
Without it, the server never sees the request as HTTPS, so it does not mark
the session cookie `Secure`.

## Deploying with Docker

CI publishes the image to `ghcr.io/cestoliv/slideeditor` on every merge to
`main`. The server pulls it, so the server needs no clone, no toolchain, and no
build.

Copy two files onto the server, `docker-compose.yml` and your own `.env`, then:

```bash
docker compose pull
docker compose up -d
```

This starts the container and publishes it on `127.0.0.1:4173`, ready for a
reverse proxy on the same host to reach. The container expects to sit behind a
TLS-terminating proxy. `docker-compose.yml` already sets
`SLIDE_STUDIO_TRUST_PROXY=1` for it.

Set `SLIDE_STUDIO_PASSWORD` in `.env` before you start it. See `.env.example`
for the full list of variables Compose reads.

Without a password, the container refuses to start and names the variable to
set. The compose file publishes the port, so an unauthenticated server there
would be reachable from outside your machine.

The image is built for `linux/amd64`.

### Updating and rolling back

To update, pull and recreate:

```bash
docker compose pull && docker compose up -d
```

Every build also publishes an immutable `sha-<short>` tag, taken from the commit
it was built from. `latest` moves, so roll back by pinning one of those instead.
Edit the `image:` line in `docker-compose.yml`:

```yaml
image: ghcr.io/cestoliv/slideeditor:sha-2ceda85
```

Then run `docker compose up -d` again. To find the tag you want, read the
commit list on `main`, or list what the registry holds:

```bash
docker run --rm gcr.io/go-containerregistry/crane ls ghcr.io/cestoliv/slideeditor
```

To build the image yourself rather than pull it, run `docker build -t
ghcr.io/cestoliv/slideeditor:latest .` from a clone.

### Backups

The server snapshots the database with `VACUUM INTO` right before it applies a
pending database migration. It never snapshots on an ordinary restart.
Snapshots land in `<data>/backups/db/`, named
`slide-studio-v<fromVersion>-<timestamp>.db`.

The server also archives your media directory once, before the first pending
filesystem migration. Archives land in `<data>/backups/fs/` as `.tar.gz`
files. No filesystem migration ships yet, so in practice `<data>/backups/fs/`
stays absent until a future release adds one.

`SLIDE_STUDIO_BACKUP_KEEP` sets how many snapshots of each kind to keep. It
defaults to `5`. Set it to `0` to keep every one. Set
`SLIDE_STUDIO_SKIP_BACKUP` to skip both kinds of backup entirely.

These backups guard migrations only. Back up the `<data>` volume yourself,
with a real backup strategy, for everything else.

### Restoring a snapshot

Restoring overwrites the live database with the snapshot's contents. Stop the
container first.

```bash
docker compose stop slide-studio
docker compose run --rm --entrypoint sh slide-studio -c \
  "cp /data/backups/db/slide-studio-v4-2026-08-25T12-00-00.000Z.db /data/slide-studio.db"
docker compose start slide-studio
```

Replace the filename with the snapshot you want to restore. `docker compose
run` reuses the same volume as the service, so it works without knowing the
volume's actual name.

A media archive restores the same way. Extract its `.tar.gz` over
`<data>/media` before you start the container again.

## HTTP API

The MCP tools are a thin wrapper over these routes, which you can call directly.

```
GET    /api/health
GET    /api/accounts
POST   /api/accounts             accountId not needed: creates the account
GET    /api/accounts/:id
PUT    /api/accounts/:id
DELETE /api/accounts/:id         409 while it still owns library items or slideshows
GET    /api/fonts
POST   /api/fonts                adds a Google font by family name
DELETE /api/fonts/:id            refuses a built-in font
GET    /fonts/:file              the font binary itself, revalidated hourly (ETag)
GET    /api/library?kind=&q=&sort=&limit=&offset=&account=
GET    /api/library/:id
POST   /api/library              accountId required
PATCH  /api/library/:id
DELETE /api/library/:id          409 when in use, unless force=1
GET    /api/projects?status=&account=
POST   /api/projects             accountId required
GET    /api/projects/:id         ?include=composed adds composedDocument
PUT    /api/projects/:id         guarded by version
PATCH  /api/projects/:id/status
DELETE /api/projects/:id
GET    /api/slideshows?status=&account=   hides published unless asked
POST   /api/slideshows                    accountId required, returns editUrl
PUT    /api/slideshows/:id                guarded by version
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

MIT. TikTok Sans and Space Mono are both distributed under the SIL Open Font
License 1.1; their licenses are included at `assets/TikTokSans-OFL.txt` and
`assets/SpaceMono-OFL.txt`. The GitHub Octicons mark is distributed under the
MIT License; its notice is included at `assets/Octicons-LICENSE.txt`.
