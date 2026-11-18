import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { simpleGit } from "simple-git";
import type { DirectoryFields } from "../../shared/contracts";
import {
  environmentExamples,
  excludedNames,
  folderName,
  type CreationOperation,
  type CreationState,
} from "../../shared/creation.ts";
import {
  DirectoryError,
  DirectoryStore,
  resolveDirectory,
} from "./directory-store.ts";

interface Payload {
  source: string;
  parent: string;
  target: string;
  temporary: string;
  templateId: string;
  templateName: string;
  fields: DirectoryFields;
  initializeGit: boolean;
  marker: string;
}
type Row = {
  id: string;
  payload: string;
  state: CreationState;
  message: string;
  copied: number;
};

export function isWithin(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

export function shouldCopy(name: string) {
  const normalized = name.toLowerCase();
  if (excludedNames.includes(normalized)) return false;
  return (
    environmentExamples.includes(normalized) ||
    (normalized !== ".env" && !normalized.startsWith(".env."))
  );
}

export class ProjectCreation {
  private readonly db: DatabaseSync;
  private readonly store: DirectoryStore;
  private readonly dataDirectory: string;
  private readonly running = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  private readonly recovering = new Set<string>();

  constructor(db: DatabaseSync, dataDirectory: string) {
    this.db = db;
    this.store = new DirectoryStore(db);
    this.dataDirectory = dataDirectory;
    db.prepare(
      "UPDATE creation_operations SET state = 'interrupted', message = '应用退出时任务尚未结束。可尝试恢复登记，临时目录会保留。' WHERE state IN ('copying', 'publishing', 'registering')",
    ).run();
  }

  list(): CreationOperation[] {
    return (
      this.db
        .prepare("SELECT * FROM creation_operations ORDER BY created_at DESC")
        .all() as Row[]
    ).map((row) => {
      const payload = JSON.parse(row.payload) as Payload;
      return {
        id: row.id,
        state: row.state,
        copied: row.copied,
        message: row.message,
        name: payload.fields.name,
        target: payload.target,
        temporary: payload.temporary,
      };
    });
  }

  get active() {
    return this.running.size > 0 || this.recovering.size > 0;
  }

  async prepare(
    templateId: string,
    name: string,
    parentPath: string,
    initializeGit: boolean,
  ): Promise<Payload> {
    const parsedName = folderName.parse(name);
    const template = (await this.store.list("template")).find(
      (entry) => entry.id === templateId,
    );
    if (!template) throw new DirectoryError("模板记录已不存在。");
    const source = await resolveDirectory(template.path);
    const parent = await resolveDirectory(parentPath);
    const data = await resolveDirectory(this.dataDirectory);
    if (
      isWithin(source.path, parent.path) ||
      isWithin(data.path, parent.path) ||
      isWithin(source.path, data.path)
    ) {
      throw new DirectoryError(
        "目标父目录须在模板和应用数据目录之外，模板也不能包含应用数据目录。",
      );
    }
    const target = join(parent.path, parsedName);
    await this.ensureAbsent(target);
    const id = randomUUID();
    return {
      source: source.path,
      parent: parent.path,
      target,
      temporary: join(parent.path, `.devhub-${id}`),
      templateId,
      templateName: template.name,
      fields: {
        name: parsedName,
        description: template.description,
        projectType: template.projectType,
        tags: template.tags,
        techStack: template.techStack,
        previewConfig: template.previewConfig,
      },
      initializeGit,
      marker: `.devhub-owner-${id}`,
    };
  }

  start(payload: Payload) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO creation_operations (id, payload, state, created_at) VALUES (?, ?, 'copying', ?)",
      )
      .run(id, JSON.stringify(payload), new Date().toISOString());
    const abort = new AbortController();
    const promise = this.execute(id, payload, abort.signal).finally(() =>
      this.running.delete(id),
    );
    this.running.set(id, { abort, promise });
    return id;
  }

  cancel(id: string) {
    const row = this.get(id);
    if (row.state !== "copying")
      throw new DirectoryError("目录开始落位后，请等待登记完成。");
    this.running.get(id)?.abort.abort();
  }

  async wait(id: string) {
    await this.running.get(id)?.promise;
  }
  async shutdown() {
    for (const [id, task] of this.running) {
      if (this.get(id).state === "copying") task.abort.abort();
    }
    await Promise.all([...this.running.values()].map((task) => task.promise));
  }

  async resume(id: string) {
    const row = this.get(id);
    if (row.state === "completed") return;
    if (this.running.has(id) || this.recovering.has(id))
      throw new DirectoryError("任务正在运行。");
    this.recovering.add(id);
    try {
      const payload = JSON.parse(row.payload) as Payload;
      if (!(await this.owns(payload.target, payload, id))) {
        if (await this.owns(payload.temporary, payload, id)) {
          await this.ensureAbsent(payload.target);
          await rm(payload.temporary, { recursive: true });
          this.db
            .prepare(
              "UPDATE creation_operations SET state = 'copying', message = '', copied = 0 WHERE id = ?",
            )
            .run(id);
          const abort = new AbortController();
          const promise = this.execute(id, payload, abort.signal).finally(() =>
            this.running.delete(id),
          );
          this.running.set(id, { abort, promise });
          return;
        }
        throw new DirectoryError(
          `无法验证最终目录归属。请保留并检查目录。临时目录为 ${payload.temporary}`,
        );
      }
      await this.register(id, payload);
    } finally {
      this.recovering.delete(id);
    }
  }

  private get(id: string) {
    const row = this.db
      .prepare("SELECT * FROM creation_operations WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new DirectoryError("创建任务已不存在。");
    return row;
  }
  private state(id: string, state: CreationState, message = "") {
    this.db
      .prepare(
        "UPDATE creation_operations SET state = ?, message = ? WHERE id = ?",
      )
      .run(state, message, id);
  }
  private async ensureAbsent(path: string) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new DirectoryError("目标目录已存在，请使用其他名称。");
  }
  private async owns(path: string, payload: Payload, id: string) {
    try {
      const info = await lstat(path);
      return (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        (await readFile(join(path, payload.marker), "utf8")) === id
      );
    } catch {
      return false;
    }
  }
  private async copy(
    source: string,
    target: string,
    signal: AbortSignal,
    id: string,
  ) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (!shouldCopy(entry.name) || entry.isSymbolicLink()) continue;
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      const actual = await lstat(from);
      if (actual.isSymbolicLink()) continue;
      if (actual.isDirectory()) {
        await mkdir(to);
        await this.copy(from, to, signal, id);
      } else if (actual.isFile()) {
        await copyFile(from, to, constants.COPYFILE_EXCL);
        this.db
          .prepare(
            "UPDATE creation_operations SET copied = copied + 1 WHERE id = ?",
          )
          .run(id);
      }
    }
  }
  private async register(id: string, payload: Payload) {
    const directory = await resolveDirectory(payload.target);
    this.store.add("project", directory, payload.fields, {
      operationId: id,
      templateId: payload.templateId,
      templateName: payload.templateName,
    });
    try {
      await rm(join(payload.target, payload.marker));
    } catch {
      this.state(id, "completed", "项目已创建，目录中保留了创建归属标记。");
    }
  }
  private async execute(id: string, payload: Payload, signal: AbortSignal) {
    let published = false;
    try {
      const parent = await resolveDirectory(payload.parent);
      const source = await resolveDirectory(payload.source);
      if (parent.path !== payload.parent || source.path !== payload.source)
        throw new DirectoryError("模板或目标父目录已变化，请重新创建。");
      signal.throwIfAborted();
      await mkdir(payload.temporary);
      await writeFile(join(payload.temporary, payload.marker), id, {
        flag: "wx",
      });
      await this.copy(payload.source, payload.temporary, signal, id);
      signal.throwIfAborted();
      if (payload.initializeGit) {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            [
              "PATH",
              "SYSTEMROOT",
              "WINDIR",
              "COMSPEC",
              "TEMP",
              "TMP",
              "HOME",
              "USERPROFILE",
              "HOMEDRIVE",
              "HOMEPATH",
              "PATHEXT",
            ].includes(key.toUpperCase()),
          ),
        );
        await simpleGit(payload.temporary, {
          timeout: { block: 15000 },
          allowConfig: ["init.templatedir"],
        })
          .env(env)
          .raw(["-c", "init.templateDir=", "init"]);
      }
      signal.throwIfAborted();
      await this.ensureAbsent(payload.target);
      signal.throwIfAborted();
      if ((await resolveDirectory(payload.parent)).path !== payload.parent)
        throw new DirectoryError("目标父目录已变化，请检查临时目录。");
      // Windows directory rename refuses an existing destination, including an empty directory.
      if (process.platform !== "win32")
        throw new DirectoryError("创建项目目前支持 Windows。");
      this.state(id, "publishing");
      await rename(payload.temporary, payload.target);
      published = true;
      this.state(id, "registering");
      await this.register(id, payload);
    } catch (error) {
      let message =
        error instanceof DirectoryError
          ? error.message
          : "创建失败，请检查磁盘空间、目录权限或 Git 安装。";
      if (published) message = "项目文件已保留，请使用恢复登记完成创建。";
      else if (await this.owns(payload.temporary, payload, id)) {
        try {
          await rm(payload.temporary, { recursive: true });
        } catch {
          message += ` 临时目录保留在 ${payload.temporary}`;
        }
      }
      this.state(id, signal.aborted ? "cancelled" : "failed", message);
    }
  }
}
