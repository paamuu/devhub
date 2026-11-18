import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";

test("initializes and reopens a local workspace without reapplying its migration", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "devhub-db-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = openDatabase(directory);
  try {
    assert.equal(first.schemaVersion, 5);
    assert.equal(first.path, join(directory, "devhub.sqlite"));
    first.database
      .prepare("INSERT INTO app_settings VALUES (?, ?, ?)")
      .run("theme", JSON.stringify("system"), new Date().toISOString());
  } finally {
    first.database.close();
  }

  const reopened = openDatabase(directory);
  try {
    assert.equal(
      reopened.database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get()?.count,
      5,
    );
    assert.equal(
      reopened.database
        .prepare("SELECT value_json FROM app_settings WHERE key = ?")
        .get("theme")?.value_json,
      '"system"',
    );
  } finally {
    reopened.database.close();
  }
});

test("upgrades existing schema 3 registrations with metadata defaults and preserves user files", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "devhub-v3-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const prior = openDatabase(directory);
  const id = new DirectoryStore(prior.database).add(
    "template",
    await resolveDirectory(directory),
    {
      name: "Existing template",
      description: "Preserved",
      projectType: "web",
      tags: ["old"],
    },
  );
  for (const table of ["templates", "projects"]) {
    for (const column of [
      "tech_stack_json",
      "preview_config_json",
      "last_checked_at",
      "last_opened_at",
    ])
      prior.database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  prior.database.exec(
    "ALTER TABLE projects DROP COLUMN ide_config_json; ALTER TABLE templates DROP COLUMN source_url; ALTER TABLE templates DROP COLUMN source_type; DROP INDEX projects_by_template; DROP INDEX templates_by_name; DROP INDEX projects_by_name; DELETE FROM schema_migrations WHERE version >= 4; PRAGMA user_version = 3;",
  );
  prior.database.close();
  const upgraded = openDatabase(directory);
  try {
    const [entry] = await new DirectoryStore(upgraded.database).list(
      "template",
    );
    assert.equal(entry.id, id);
    assert.equal(entry.description, "Preserved");
    assert.deepEqual(entry.tags, ["old"]);
    assert.deepEqual(entry.techStack, []);
    assert.equal(entry.previewConfig, null);
    assert.equal(entry.sourceUrl, "");
    assert.equal(upgraded.schemaVersion, 5);
  } finally {
    upgraded.database.close();
  }
  assert.equal(readdirSync(join(directory, "backups")).length, 1);
});

test("refuses a newer database and preserves its version", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "devhub-db-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "devhub.sqlite");
  const newer = new DatabaseSync(path);
  newer.exec("PRAGMA user_version = 6");
  newer.close();

  assert.throws(() => openDatabase(directory), /newer DevHub version/);
  const unchanged = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      unchanged.prepare("PRAGMA user_version").get()?.user_version,
      6,
    );
  } finally {
    unchanged.close();
  }
});

test("upgrades schema 1 and keeps a consistent snapshot before the upgrade", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "devhub-db-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(join(directory, "devhub.sqlite"));
  try {
    old.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'previous');
      INSERT INTO app_settings VALUES ('theme', '"system"', 'previous');
      PRAGMA user_version = 1;`);
  } finally {
    old.close();
  }
  const current = openDatabase(directory);
  try {
    assert.equal(current.schemaVersion, 5);
    assert.equal(
      current.database
        .prepare("SELECT value_json FROM app_settings WHERE key = 'theme'")
        .get()?.value_json,
      '"system"',
    );
    assert.ok(
      current.database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'templates'")
        .get(),
    );
  } finally {
    current.database.close();
  }
  const files = readdirSync(join(directory, "backups"));
  assert.equal(files.length, 1);
  const snapshot = new DatabaseSync(join(directory, "backups", files[0]), {
    readOnly: true,
  });
  try {
    assert.equal(
      snapshot.prepare("PRAGMA user_version").get()?.user_version,
      1,
    );
  } finally {
    snapshot.close();
  }
});
