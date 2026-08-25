// The first two are copied byte for byte from server/db.mjs:5-91. A byte
// difference risks a different user_version path on a database that already
// exists on disk, so neither is a place to tidy SQL, rename a column, or add an
// index. Anything after them is this rewrite's own, and is appended rather than
// folded into one of those two for the same reason.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE library_item (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('background','asset')),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    usage       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    media_id    TEXT NOT NULL,
    ext         TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX library_item_kind ON library_item (kind, updated_at DESC);

  CREATE VIRTUAL TABLE library_search USING fts5(
    name, description, usage, tags,
    content='library_item', content_rowid='rowid'
  );

  CREATE TRIGGER library_item_ai AFTER INSERT ON library_item BEGIN
    INSERT INTO library_search (rowid, name, description, usage, tags)
    VALUES (new.rowid, new.name, new.description, new.usage, new.tags);
  END;

  CREATE TRIGGER library_item_ad AFTER DELETE ON library_item BEGIN
    INSERT INTO library_search (library_search, rowid, name, description, usage, tags)
    VALUES ('delete', old.rowid, old.name, old.description, old.usage, old.tags);
  END;

  CREATE TRIGGER library_item_au AFTER UPDATE ON library_item BEGIN
    INSERT INTO library_search (library_search, rowid, name, description, usage, tags)
    VALUES ('delete', old.rowid, old.name, old.description, old.usage, old.tags);
    INSERT INTO library_search (rowid, name, description, usage, tags)
    VALUES (new.rowid, new.name, new.description, new.usage, new.tags);
  END;

  CREATE TABLE project (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    document   TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX project_updated ON project (updated_at DESC);

  CREATE TABLE project_item_use (
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL REFERENCES library_item(id),
    PRIMARY KEY (project_id, item_id)
  ) STRICT;

  CREATE INDEX project_item_use_item ON project_item_use (item_id);
  `,
  `
  ALTER TABLE project ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','published'));

  CREATE INDEX project_status ON project (status, updated_at DESC);

  -- Cumulative, unlike project_item_use. project_id carries no foreign key on
  -- purpose: the history outlives the slideshow, so deleting old drafts cannot
  -- make a heavily used item look untouched.
  CREATE TABLE item_use_history (
    item_id       TEXT NOT NULL REFERENCES library_item(id) ON DELETE CASCADE,
    project_id    TEXT NOT NULL,
    placements    INTEGER NOT NULL,
    first_used_at INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    PRIMARY KEY (item_id, project_id)
  ) STRICT;

  CREATE INDEX item_use_history_item ON item_use_history (item_id);

  -- Seed from what is already in use, so an existing library does not read as
  -- never used the moment stats appear.
  INSERT INTO item_use_history (item_id, project_id, placements, first_used_at, last_used_at)
  SELECT use.item_id, use.project_id, 1, project.updated_at, project.updated_at
  FROM project_item_use AS use
  JOIN project ON project.id = use.project_id;
  `,
  `
  -- The caption a slideshow is posted with. Columns rather than document
  -- fields, beside name and status, because they describe the slideshow rather
  -- than its slides: an editor saving a document must not be the only way a
  -- caption reaches disk, and an agent reading one must not have to parse the
  -- slides to find it.
  --
  -- Both default to empty, so every slideshow already on disk gains them
  -- carrying no caption rather than gaining nothing.
  ALTER TABLE project ADD COLUMN description TEXT NOT NULL DEFAULT '';

  -- Space separated tags, each carrying one leading '#'
  -- (normalizeHashtags in src/shared/schema/metadata.ts). One column rather
  -- than a tag table: nothing queries a slideshow by tag, and the whole point
  -- of the field is to be copied out in one piece.
  ALTER TABLE project ADD COLUMN hashtags TEXT NOT NULL DEFAULT '';
  `,
];
