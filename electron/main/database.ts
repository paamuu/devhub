import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const currentSchemaVersion = 5;

export function openDatabase(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "devhub.sqlite");
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
  });

  try {
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA busy_timeout = 5000");
    const previous = database
      .prepare("PRAGMA user_version")
      .get()?.user_version;
    if (Number(previous) > 0 && Number(previous) < currentSchemaVersion) {
      const backups = join(directory, "backups");
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      database
        .prepare("VACUUM INTO ?")
        .run(
          join(
            backups,
            `before-schema-${currentSchemaVersion}-${randomUUID()}.sqlite`,
          ),
        );
    }
    database.exec("BEGIN IMMEDIATE");
    const row = database.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version);
    if (version > currentSchemaVersion) {
      throw new Error("The database was created by a newer DevHub version.");
    }
    if (version === 0) {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value_json TEXT NOT NULL CHECK (json_valid(value_json)),
          updated_at TEXT NOT NULL
        );
      `);
      database
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(1, new Date().toISOString());
      database.exec("PRAGMA user_version = 1");
    }
    if (version < 2) {
      database.exec(`
        CREATE TABLE directory_registrations (
          id TEXT PRIMARY KEY NOT NULL,
          path_key TEXT UNIQUE NOT NULL,
          local_path TEXT NOT NULL
        );
        CREATE TABLE templates (
          id TEXT PRIMARY KEY NOT NULL REFERENCES directory_registrations(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          project_type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY NOT NULL REFERENCES directory_registrations(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          project_type TEXT NOT NULL,
          template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
          template_name_snapshot TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tags (name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE);
        CREATE TABLE directory_tags (
          directory_id TEXT NOT NULL REFERENCES directory_registrations(id) ON DELETE CASCADE,
          tag TEXT NOT NULL REFERENCES tags(name),
          PRIMARY KEY (directory_id, tag)
        );
        CREATE INDEX directory_tags_by_tag ON directory_tags(tag, directory_id);
      `);
      database
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(2, new Date().toISOString());
      database.exec("PRAGMA user_version = 2");
    }
    if (version < 3) {
      database.exec(`
        ALTER TABLE templates ADD COLUMN last_used_at TEXT;
        CREATE TABLE creation_operations (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)),
          state TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          copied INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);
      database
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(3, new Date().toISOString());
      database.exec("PRAGMA user_version = 3");
    }
    if (version < 4) {
      for (const table of ["templates", "projects"]) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN tech_stack_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tech_stack_json));
          ALTER TABLE ${table} ADD COLUMN preview_config_json TEXT CHECK(preview_config_json IS NULL OR json_valid(preview_config_json));
          ALTER TABLE ${table} ADD COLUMN last_checked_at TEXT;
          ALTER TABLE ${table} ADD COLUMN last_opened_at TEXT;`);
      }
      database.exec(`ALTER TABLE templates ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE templates ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local';
        CREATE INDEX projects_by_template ON projects(template_id);
        CREATE INDEX templates_by_name ON templates(name);
        CREATE INDEX projects_by_name ON projects(name);`);
      database
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(4, new Date().toISOString());
      database.exec("PRAGMA user_version = 4");
    }
    if (version < 5) {
      database.exec(
        "ALTER TABLE projects ADD COLUMN ide_config_json TEXT CHECK(ide_config_json IS NULL OR json_valid(ide_config_json))",
      );
      database
        .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
        .run(5, new Date().toISOString());
      database.exec("PRAGMA user_version = 5");
    }
    const applied = database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    if (applied?.version !== currentSchemaVersion) {
      throw new Error("The database migration history is inconsistent.");
    }
    database.exec("COMMIT");
    return { database, path, schemaVersion: currentSchemaVersion };
  } catch (error) {
    database.close();
    throw error;
  }
}
