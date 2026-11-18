import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  DirectoryEntry,
  DirectoryFields,
  DirectoryKind,
} from "../../shared/contracts";

export class DirectoryError extends Error {}

export async function resolveDirectory(path: string) {
  try {
    const actual = normalize(await realpath(path));
    if ((await stat(actual)).isDirectory()) {
      return {
        path: actual,
        key: process.platform === "win32" ? actual.toLowerCase() : actual,
      };
    }
  } catch {
    // Report a stable message without exposing underlying system errors.
  }
  throw new DirectoryError("所选目录不存在或无法访问。请重新选择。");
}

const tables = { template: "templates", project: "projects" } as const;

type EntryRow = {
  id: string;
  name: string;
  description: string;
  project_type: DirectoryFields["projectType"];
  local_path: string;
  archived_at: string | null;
  tech_stack_json: string;
  preview_config_json: string | null;
  source_url: string;
  template_id: string | null;
  template_name_snapshot: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  last_opened_at: string | null;
  last_used_at: string | null;
};

export class DirectoryStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async list(kind: DirectoryKind): Promise<DirectoryEntry[]> {
    const rows = this.db
      .prepare(
        `
      SELECT records.*, paths.local_path,
             ${kind === "template" ? "NULL AS template_id, NULL AS template_name_snapshot" : "'' AS source_url, NULL AS last_used_at"},
             ${kind === "project" ? "records.archived_at" : "NULL"} AS archived_at
      FROM ${tables[kind]} AS records JOIN directory_registrations AS paths USING (id)
      ORDER BY records.name COLLATE NOCASE, records.id
    `,
      )
      .all() as EntryRow[];
    const tagRows = this.db
      .prepare(
        `
      SELECT directory_id, tag FROM directory_tags
      JOIN ${tables[kind]} ON directory_id = id ORDER BY tag COLLATE NOCASE
    `,
      )
      .all() as { directory_id: string; tag: string }[];
    const tags = new Map<string, string[]>();
    for (const row of tagRows) {
      const list = tags.get(row.directory_id) ?? [];
      list.push(row.tag);
      tags.set(row.directory_id, list);
    }

    return Promise.all(
      rows.map(async (row): Promise<DirectoryEntry> => {
        let availability: DirectoryEntry["availability"];
        try {
          availability = (await stat(row.local_path)).isDirectory()
            ? "available"
            : "missing";
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          availability =
            code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
        }
        const checkedAt = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE ${tables[kind]} SET last_checked_at = ? WHERE id = ?`,
          )
          .run(checkedAt, row.id);
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          projectType: row.project_type,
          path: row.local_path,
          archivedAt: row.archived_at,
          tags: tags.get(row.id) ?? [],
          availability,
          techStack: JSON.parse(row.tech_stack_json),
          sourceUrl: row.source_url,
          previewConfig: row.preview_config_json
            ? JSON.parse(row.preview_config_json)
            : null,
          templateId: row.template_id,
          templateName: row.template_name_snapshot,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastCheckedAt: checkedAt,
          lastOpenedAt: row.last_opened_at,
          lastUsedAt: row.last_used_at,
        };
      }),
    );
  }

  add(
    kind: DirectoryKind,
    directory: { path: string; key: string },
    fields: DirectoryFields,
    creation?: {
      operationId: string;
      templateId: string;
      templateName: string;
    },
  ) {
    const id = randomUUID();
    this.write(() => {
      this.ensureUnique(directory.key, id);
      this.db
        .prepare("INSERT INTO directory_registrations VALUES (?, ?, ?)")
        .run(id, directory.key, directory.path);
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO ${tables[kind]} (id, name, description, project_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, fields.name, fields.description, fields.projectType, now, now);
      this.updateTags(id, fields.tags);
      this.updateMetadata(kind, id, fields);
      if (creation) {
        this.db
          .prepare(
            `UPDATE projects SET template_id = (SELECT id FROM templates WHERE id = ?), template_name_snapshot = ? WHERE id = ?`,
          )
          .run(creation.templateId, creation.templateName, id);
        this.db
          .prepare("UPDATE templates SET last_used_at = ? WHERE id = ?")
          .run(now, creation.templateId);
        this.db
          .prepare(
            "UPDATE creation_operations SET state = 'completed', message = '' WHERE id = ?",
          )
          .run(creation.operationId);
      }
    });
    return id;
  }

  edit(kind: DirectoryKind, id: string, fields: DirectoryFields) {
    this.write(() => {
      this.require(kind, id);
      this.db
        .prepare(
          `UPDATE ${tables[kind]} SET name = ?, description = ?, project_type = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          fields.name,
          fields.description,
          fields.projectType,
          new Date().toISOString(),
          id,
        );
      this.updateTags(id, fields.tags);
      this.updateMetadata(kind, id, fields);
    });
  }

  relink(
    kind: DirectoryKind,
    id: string,
    directory: { path: string; key: string },
  ) {
    this.write(() => {
      this.require(kind, id);
      this.ensureUnique(directory.key, id);
      this.db
        .prepare(
          "UPDATE directory_registrations SET local_path = ?, path_key = ? WHERE id = ?",
        )
        .run(directory.path, directory.key, id);
      this.db
        .prepare(`UPDATE ${tables[kind]} SET updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
    });
  }

  archive(id: string, archived: boolean) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(archived ? now : null, now, id);
    if (!result.changes) throw new DirectoryError("项目记录已不存在。");
  }

  remove(kind: DirectoryKind, id: string) {
    this.write(() => {
      this.require(kind, id);
      this.db
        .prepare("DELETE FROM directory_registrations WHERE id = ?")
        .run(id);
    });
  }

  require(kind: DirectoryKind, id: string) {
    const row = this.db
      .prepare(
        `SELECT local_path, path_key FROM ${tables[kind]} JOIN directory_registrations USING (id) WHERE id = ?`,
      )
      .get(id);
    if (!row) throw new DirectoryError("登记记录已不存在。");
    return { path: String(row.local_path), key: String(row.path_key) };
  }

  markOpened(kind: DirectoryKind, id: string) {
    this.db
      .prepare(`UPDATE ${tables[kind]} SET last_opened_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  registeredPaths() {
    return this.db
      .prepare("SELECT id, local_path FROM directory_registrations")
      .all() as { id: string; local_path: string }[];
  }

  private updateMetadata(
    kind: DirectoryKind,
    id: string,
    fields: DirectoryFields,
  ) {
    if (fields.techStack !== undefined)
      this.db
        .prepare(`UPDATE ${tables[kind]} SET tech_stack_json = ? WHERE id = ?`)
        .run(JSON.stringify([...new Set(fields.techStack)]), id);
    if (fields.previewConfig !== undefined)
      this.db
        .prepare(
          `UPDATE ${tables[kind]} SET preview_config_json = ? WHERE id = ?`,
        )
        .run(
          fields.previewConfig ? JSON.stringify(fields.previewConfig) : null,
          id,
        );
    if (kind === "template" && fields.sourceUrl !== undefined)
      this.db
        .prepare(
          "UPDATE templates SET source_url = ?, source_type = ? WHERE id = ?",
        )
        .run(fields.sourceUrl, fields.sourceUrl ? "git" : "local", id);
  }

  private ensureUnique(key: string, id: string) {
    if (
      this.db
        .prepare(
          "SELECT 1 FROM directory_registrations WHERE path_key = ? AND id <> ?",
        )
        .get(key, id)
    ) {
      throw new DirectoryError("此目录已登记为模板或项目。");
    }
  }

  private updateTags(id: string, tags: string[]) {
    this.db
      .prepare("DELETE FROM directory_tags WHERE directory_id = ?")
      .run(id);
    const insertTag = this.db.prepare("INSERT OR IGNORE INTO tags VALUES (?)");
    const attachTag = this.db.prepare(
      "INSERT OR IGNORE INTO directory_tags SELECT ?, name FROM tags WHERE name = ?",
    );
    for (const tag of tags) {
      insertTag.run(tag);
      attachTag.run(id, tag);
    }
  }

  private write(operation: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
