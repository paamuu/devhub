import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  open,
  lstat,
} from "node:fs/promises";
import {
  join,
  resolve,
  dirname,
  basename,
  isAbsolute,
  relative,
} from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { z } from "zod";
import { currentSchemaVersion, openDatabase } from "./database.ts";
import { envFile } from "./environment-store.ts";
import { directoryFields } from "../../shared/contracts.ts";
import { ideConfigSchema } from "../../shared/runtime.ts";
import type { BackupPreview } from "../../shared/backup.ts";

const limit = 64 * 1024 * 1024;
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const entrySchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    data: z.string().max(limit),
  })
  .strict();
const packageSchema = z
  .object({
    format: z.literal("devhub-backup"),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    appVersion: z.string().max(100),
    schemaVersion: z.number().int().min(1).max(currentSchemaVersion),
    database: entrySchema,
    environment: entrySchema,
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["prepared", "switching", "committed"]),
    databaseHash: z.string().regex(/^[a-f0-9]{64}$/),
    environmentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Environment = z.infer<typeof envFile>;
export interface PreparedBackup {
  path: string;
  preview: BackupPreview;
  databaseHash: string;
  environmentHash: string;
}
export class BackupError extends Error {}
export async function atomicWrite(path: string, data: Buffer | string) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}-${randomUUID()}.tmp`,
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
async function readLimited(path: string) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size > limit || size === 0)
      throw new BackupError("备份文件为空或超过 64 MiB 上限。");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function checkPlainDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BackupError("恢复目录类型无效，请检查本地数据目录。");
}
export class BackupStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private transactionPath() {
    return join(this.directory, "restore-transaction");
  }
  async lastResult() {
    try {
      const value = z
        .object({ message: z.string().max(500), time: z.iso.datetime() })
        .parse(
          JSON.parse(
            await readFile(join(this.directory, "last-restore.json"), "utf8"),
          ),
        );
      return `${value.message} (${new Date(value.time).toLocaleString()})`;
    } catch {
      return "";
    }
  }
  async discard(prepared: PreparedBackup) {
    if (
      dirname(prepared.path) !== this.directory ||
      !/^\.restore-stage-[a-f0-9-]{36}$/.test(basename(prepared.path))
    )
      throw new BackupError("临时目录不属于此次恢复。");
    await checkPlainDirectory(prepared.path);
    await rm(prepared.path, { recursive: true, force: true });
  }
  private async inspectDatabase(path: string, expectedVersion?: number) {
    const db = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      db.exec("PRAGMA trusted_schema=OFF");
      const version = Number(
        db.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (
        version < 1 ||
        version > currentSchemaVersion ||
        (expectedVersion && version !== expectedVersion)
      )
        throw new BackupError("数据库版本与备份清单不一致或当前版本不支持。");
      const allowed = new Set([
        "schema_migrations",
        "app_settings",
        "directory_registrations",
        "templates",
        "projects",
        "tags",
        "directory_tags",
        "creation_operations",
      ]);
      for (const row of db
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all()) {
        if (
          !["table", "index"].includes(String(row.type)) ||
          (row.type === "table" &&
            (!allowed.has(String(row.name)) ||
              /VIRTUAL/i.test(String(row.sql))))
        )
          throw new BackupError("备份包含不支持的数据库结构。");
      }
      if (
        db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw new BackupError("备份数据库完整性检查失败。");
      return version;
    } finally {
      db.close();
    }
  }
  private validateRows(db: DatabaseSync, environment: Environment) {
    const ids = new Set<string>();
    for (const table of ["templates", "projects"] as const) {
      for (const row of db
        .prepare(
          `SELECT records.*, paths.local_path FROM ${table} AS records JOIN directory_registrations AS paths USING(id)`,
        )
        .all()) {
        z.uuid().parse(row.id);
        const path = String(row.local_path);
        if (!isAbsolute(path) || path.includes("\0"))
          throw new BackupError("备份含无效的登记路径。");
        directoryFields.parse({
          name: row.name,
          description: row.description,
          projectType: row.project_type,
          tags: db
            .prepare("SELECT tag FROM directory_tags WHERE directory_id=?")
            .all(String(row.id))
            .map((item) => item.tag),
          techStack: JSON.parse(String(row.tech_stack_json)),
          previewConfig: row.preview_config_json
            ? JSON.parse(String(row.preview_config_json))
            : null,
          ...(table === "templates" ? { sourceUrl: row.source_url } : {}),
        });
        if (table === "projects") {
          ids.add(String(row.id));
          if (row.ide_config_json)
            ideConfigSchema.parse(JSON.parse(String(row.ide_config_json)));
        }
      }
    }
    for (const id of Object.keys(environment.projects))
      if (!ids.has(id))
        throw new BackupError("环境配置引用了备份中不存在的项目。");
    for (const row of db
      .prepare("SELECT key,value_json FROM app_settings")
      .all()) {
      const value = JSON.parse(String(row.value_json));
      if (row.key === "ide.default") ideConfigSchema.parse(value);
    }
  }
  async export(
    db: DatabaseSync,
    environment: Environment,
    destination: string,
    appVersion = "0.1.0",
  ) {
    environment = envFile.parse(environment);
    const within = relative(this.directory, resolve(destination));
    if (
      !within ||
      (!within.startsWith("..") &&
        !isAbsolute(within) &&
        !within.startsWith(
          `backups${process.platform === "win32" ? "\\" : "/"}`,
        ))
    )
      throw new BackupError(
        "请将备份保存到数据目录之外，或其 backups 子目录。",
      );
    const stage = join(this.directory, `.backup-stage-${randomUUID()}`);
    await mkdir(stage);
    try {
      const snapshot = join(stage, "devhub.sqlite");
      await backup(db, snapshot);
      const clean = new DatabaseSync(snapshot);
      try {
        clean.exec(
          "PRAGMA trusted_schema=OFF; DELETE FROM creation_operations; VACUUM;",
        );
        this.validateRows(clean, environment);
      } finally {
        clean.close();
      }
      const database = await readLimited(snapshot),
        env = Buffer.from(JSON.stringify(environment));
      const payload = JSON.stringify({
        format: "devhub-backup",
        version: 1,
        appVersion,
        createdAt: new Date().toISOString(),
        schemaVersion: currentSchemaVersion,
        database: {
          sha256: digest(database),
          data: database.toString("base64"),
        },
        environment: { sha256: digest(env), data: env.toString("base64") },
      });
      if (Buffer.byteLength(payload) > limit)
        throw new BackupError("备份超过 64 MiB 上限。");
      // Decode and check the exact bytes that will be exported.
      this.decode(Buffer.from(payload));
      await atomicWrite(destination, payload);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  private decode(data: Buffer) {
    const parsed = packageSchema.safeParse(JSON.parse(data.toString("utf8")));
    if (!parsed.success) throw new BackupError("备份格式或版本不受支持。");
    const value = parsed.data;
    const decode = (entry: z.infer<typeof entrySchema>) => {
      const bytes = Buffer.from(entry.data, "base64");
      if (
        bytes.toString("base64") !== entry.data ||
        digest(bytes) !== entry.sha256
      )
        throw new BackupError("备份校验失败，文件可能损坏。");
      return bytes;
    };
    return {
      manifest: value,
      database: decode(value.database),
      environment: envFile.parse(
        JSON.parse(decode(value.environment).toString("utf8")),
      ),
    };
  }
  async prepare(source: string): Promise<PreparedBackup> {
    let decoded: ReturnType<BackupStore["decode"]>;
    try {
      decoded = this.decode(await readLimited(source));
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError("无法读取备份，请检查文件格式和完整性。");
    }
    const path = join(this.directory, `.restore-stage-${randomUUID()}`);
    await mkdir(path);
    try {
      const file = join(path, "devhub.sqlite");
      await writeFile(file, decoded.database, { mode: 0o600 });
      await this.inspectDatabase(file, decoded.manifest.schemaVersion);
      const migrated = openDatabase(path);
      let projects: number, templates: number, paths: string[];
      try {
        this.validateRows(migrated.database, decoded.environment);
        migrated.database.exec("DELETE FROM creation_operations; VACUUM;");
        projects = Number(
          migrated.database.prepare("SELECT COUNT(*) AS n FROM projects").get()
            ?.n,
        );
        templates = Number(
          migrated.database.prepare("SELECT COUNT(*) AS n FROM templates").get()
            ?.n,
        );
        paths = migrated.database
          .prepare("SELECT local_path FROM directory_registrations")
          .all()
          .map((row) => String(row.local_path));
      } finally {
        migrated.database.close();
      }
      await atomicWrite(
        join(path, "env.json"),
        JSON.stringify(decoded.environment),
      );
      let missingPaths = 0;
      for (const target of paths) {
        try {
          if (!(await stat(target)).isDirectory()) missingPaths++;
        } catch {
          missingPaths++;
        }
      }
      return {
        path,
        databaseHash: digest(await readLimited(file)),
        environmentHash: digest(await readLimited(join(path, "env.json"))),
        preview: {
          token: randomUUID(),
          createdAt: decoded.manifest.createdAt,
          schemaVersion: currentSchemaVersion,
          projects,
          templates,
          missingPaths,
          secretReferences: Object.values(decoded.environment.projects).reduce(
            (sum, project) => sum + Object.keys(project.secretRefs).length,
            0,
          ),
        },
      };
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      if (error instanceof BackupError) throw error;
      throw new BackupError("备份数据库、迁移或配置验证失败，当前数据未改变。");
    }
  }
  async restore(
    prepared: PreparedBackup,
    db: DatabaseSync,
    environment: Environment,
    close: () => Promise<void>,
    fault?: (step: string) => Promise<void>,
  ) {
    if (
      dirname(prepared.path) !== this.directory ||
      !/^\.restore-stage-[a-f0-9-]{36}$/.test(basename(prepared.path))
    )
      throw new BackupError("恢复令牌无效。");
    await checkPlainDirectory(prepared.path);
    const incomingDb = await readLimited(join(prepared.path, "devhub.sqlite")),
      incomingEnv = await readLimited(join(prepared.path, "env.json"));
    if (
      digest(incomingDb) !== prepared.databaseHash ||
      digest(incomingEnv) !== prepared.environmentHash
    )
      throw new BackupError("暂存备份已发生变化，请重新选择文件。");
    const transaction = this.transactionPath();
    await mkdir(transaction);
    let switching = false;
    try {
      await backup(db, join(transaction, "old.sqlite"));
      const oldEnv = Buffer.from(JSON.stringify(envFile.parse(environment)));
      await atomicWrite(join(transaction, "old-env.json"), oldEnv);
      const journal = {
        version: 1 as const,
        phase: "prepared" as "prepared" | "switching" | "committed",
        databaseHash: digest(
          await readLimited(join(transaction, "old.sqlite")),
        ),
        environmentHash: digest(oldEnv),
      };
      const backups = join(this.directory, "backups");
      await mkdir(backups, { recursive: true });
      const recoveryPath = join(
        backups,
        `before-restore-${Date.now()}-${randomUUID()}.devhub-backup`,
      );
      await this.export(db, environment, recoveryPath);
      await atomicWrite(
        join(transaction, "journal.json"),
        JSON.stringify(journal),
      );
      await close();
      journal.phase = "switching";
      await atomicWrite(
        join(transaction, "journal.json"),
        JSON.stringify(journal),
      );
      switching = true;
      await fault?.("before-switch");
      await atomicWrite(join(this.directory, "devhub.sqlite"), incomingDb);
      await fault?.("after-database");
      await atomicWrite(join(this.directory, "env.json"), incomingEnv);
      await fault?.("after-environment");
      await this.inspectDatabase(
        join(this.directory, "devhub.sqlite"),
        currentSchemaVersion,
      );
      journal.phase = "committed";
      await atomicWrite(
        join(transaction, "journal.json"),
        JSON.stringify(journal),
      );
      await this.recover().catch(() => {});
      return recoveryPath;
    } catch (error) {
      if (switching) {
        await this.recover();
        throw new BackupError(
          "恢复失败，已回滚原数据库和环境配置。请重启 DevHub。",
        );
      }
      await rm(transaction, { recursive: true, force: true });
      throw error;
    }
  }
  async recover(): Promise<string | null> {
    const transaction = this.transactionPath();
    try {
      await checkPlainDirectory(transaction);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let journal: z.infer<typeof journalSchema>;
    try {
      journal = journalSchema.parse(
        JSON.parse(await readFile(join(transaction, "journal.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await rm(transaction, { recursive: true, force: true });
        return "未开始的数据恢复已取消。";
      }
      throw new BackupError(
        "恢复日志损坏，已停止打开数据库。请保留 restore-transaction 目录以便检查。",
      );
    }
    if (journal.phase === "switching") {
      const database = await readLimited(join(transaction, "old.sqlite")),
        environment = await readLimited(join(transaction, "old-env.json"));
      if (
        digest(database) !== journal.databaseHash ||
        digest(environment) !== journal.environmentHash
      )
        throw new BackupError(
          "恢复回滚文件校验失败，当前文件已保留，请检查本地数据目录。",
        );
      await atomicWrite(join(this.directory, "devhub.sqlite"), database);
      await atomicWrite(join(this.directory, "env.json"), environment);
    }
    const message =
      journal.phase === "committed"
        ? "数据恢复已完成。项目路径已重新检查，缺失密钥需要重新配置。"
        : "检测到未完成的恢复，已保留或回滚到原数据。";
    await atomicWrite(
      join(this.directory, "last-restore.json"),
      JSON.stringify({ message, time: new Date().toISOString() }),
    );
    await rm(transaction, { recursive: true, force: true });
    return message;
  }
}
