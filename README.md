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

To work on the code instead, clone the repo and run `npm start`, which installs
dependencies on first run.

Data lives in `~/.slide-studio`: a SQLite database, the image files, and the
access token. Back up that one directory and you have backed up everything.

| Flag | Default | Purpose |
|---|---|---|
| `--port` | `4173` | Port to listen on |
| `--host` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to reach it from another machine. |
| `--data` | `~/.slide-studio` | Data directory |
| `--allowed-host` | none | Extra hostname to accept, repeatable |

`SLIDE_STUDIO_PORT` and `SLIDE_STUDIO_DATA` work as environment variables too.

## What it does

### Library

- Two libraries, backgrounds and assets, each with its own admin page at
  `/library/backgrounds` and `/library/assets`
- Every item carries a description of what the image shows and guidance on when
  to use it. An agent reads both to choose well.
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

| Tool | Purpose |
|---|---|
| `list_library` | List or search backgrounds and assets |
| `get_library_item` | Read one item, including its usage guidance |
| `list_slideshows` | List slideshows with ids, versions, and edit URLs |
| `get_slideshow` | Read one slideshow's composition |
| `create_slideshow` | Draft a slideshow. Returns the edit URL. |
| `update_slideshow` | Edit an existing one, guarded by its version |

### 4. How to draft a slideshow

Search before you choose. Call `list_library` with a query describing what the
slide needs, not a filename. Every item carries a `description` of what the
image shows and a `usage` note saying when to use it. Read both. An item whose
usage says "opening slide for travel posts" belongs on slide 1 of a travel
slideshow and nowhere else.

Then call `create_slideshow`. Each slide takes one `background` id, any number of
`assets` ids, and any number of `texts` lines in reading order:

```json
{
  "name": "Summer travel tips",
  "ratio": { "w": 4, "h": 5 },
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

Slides whose composition you leave untouched keep the exact layout the human
gave them. On a slide you do change, any asset or text line that is still there
keeps its position too. So a small edit stays small.

### 6. What to do when a tool fails

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
GET    /api/library?kind=&q=&limit=&offset=
GET    /api/library/:id
POST   /api/library
PATCH  /api/library/:id
DELETE /api/library/:id          409 when in use, unless force=1
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PUT    /api/projects/:id         guarded by version
DELETE /api/projects/:id
POST   /api/slideshows           returns editUrl
PUT    /api/slideshows/:id       guarded by version
GET    /api/events               server-sent events
GET    /media/:file
```

Writes to a slideshow carry the version you read. A stale write gets a 409
instead of overwriting someone else's work, and an open editor reloads when an
agent changes the slideshow you are looking at.

## Tests

```bash
npm test
```

## License

MIT. TikTok Sans is distributed under the SIL Open Font License 1.1; its license
is included at `assets/TikTokSans-OFL.txt`. The GitHub Octicons mark is
distributed under the MIT License; its notice is included at
`assets/Octicons-LICENSE.txt`.
