import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  environmentName,
  plainEnvironment,
  type EnvironmentView,
} from "../../shared/runtime.ts";

export const envFile = z.object({
  version: z.literal(1),
  projects: z.record(
    z.uuid(),
    z.object({
      values: plainEnvironment,
      secretRefs: z.record(environmentName, z.uuid()),
    }),
  ),
});
const secretFile = z.object({
  version: z.literal(1),
  entries: z.record(
    z.uuid(),
    z.object({ projectId: z.uuid(), encrypted: z.string() }),
  ),
});
interface Encryption {
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}
export class EnvironmentError extends Error {}

export class EnvironmentStore {
  private readonly directory: string;
  private readonly encryption: Encryption;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string, encryption: Encryption) {
    this.directory = directory;
    this.encryption = encryption;
  }
  private async load<T>(
    name: string,
    schema: z.ZodType<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return schema.parse(
        JSON.parse(await readFile(join(this.directory, name), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw new EnvironmentError(
        "本地环境配置无法读取，请检查文件格式或权限。",
      );
    }
  }
  private files() {
    return Promise.all([
      this.load("env.json", envFile, { version: 1, projects: {} }),
      this.load("secrets.enc", secretFile, { version: 1, entries: {} }),
    ]);
  }
  snapshot() {
    return this.exclusive(async () =>
      this.load("env.json", envFile, { version: 1, projects: {} }),
    );
  }
  private async write(name: string, value: unknown) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${name}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, join(this.directory, name));
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  view(projectId: string): Promise<EnvironmentView> {
    return this.exclusive(async () => {
      const [env, secrets] = await this.files();
      const project = env.projects[projectId] ?? { values: {}, secretRefs: {} };
      return {
        values: project.values,
        secrets: Object.entries(project.secretRefs).map(([name, id]) => ({
          name,
          configured: secrets.entries[id]?.projectId === projectId,
        })),
      };
    });
  }
  save(projectId: string, values: Record<string, string>) {
    return this.exclusive(async () => {
      const [env] = await this.files();
      const project = env.projects[projectId] ?? { values: {}, secretRefs: {} };
      const names = Object.keys(values).map((name) => name.toUpperCase());
      if (
        new Set(names).size !== names.length ||
        Object.keys(project.secretRefs).some((name) =>
          names.includes(name.toUpperCase()),
        )
      )
        throw new EnvironmentError("变量名不能重复，也不能与密钥变量重名。");
      env.projects[projectId] = {
        values: plainEnvironment.parse(values),
        secretRefs: project.secretRefs,
      };
      await this.write("env.json", env);
    });
  }
  setSecret(projectId: string, name: string, value: string) {
    return this.exclusive(async () => {
      const [env, secrets] = await this.files();
      const project = env.projects[projectId] ?? { values: {}, secretRefs: {} };
      const conflict = [
        ...Object.keys(project.values),
        ...Object.keys(project.secretRefs).filter((key) => key !== name),
      ].some((key) => key.toUpperCase() === name.toUpperCase());
      if (conflict)
        throw new EnvironmentError("变量名已存在，请先移除同名变量。");
      if (
        !project.secretRefs[name] &&
        Object.keys(project.secretRefs).length >= 100
      )
        throw new EnvironmentError("每个项目最多保存 100 个密钥。");
      const previous = project.secretRefs[name];
      const id = randomUUID();
      let encrypted: Buffer;
      try {
        encrypted = await this.encryption.encrypt(value);
      } catch {
        throw new EnvironmentError("系统密钥保护不可用，密钥未保存。");
      }
      secrets.entries[id] = {
        projectId,
        encrypted: encrypted.toString("base64"),
      };
      await this.write("secrets.enc", secrets);
      project.secretRefs[name] = id;
      env.projects[projectId] = project;
      await this.write("env.json", env);
      if (previous) {
        delete secrets.entries[previous];
        await this.write("secrets.enc", secrets);
      }
    });
  }
  removeSecret(projectId: string, name: string) {
    return this.exclusive(async () => {
      const [env, secrets] = await this.files();
      const id = env.projects[projectId]?.secretRefs[name];
      if (!id) return;
      delete env.projects[projectId].secretRefs[name];
      await this.write("env.json", env);
      delete secrets.entries[id];
      await this.write("secrets.enc", secrets);
    });
  }
  resolve(projectId: string) {
    return this.exclusive(async () => {
      const [env, secrets] = await this.files();
      const project = env.projects[projectId] ?? { values: {}, secretRefs: {} };
      const values = { ...project.values };
      const sensitive: string[] = [];
      for (const [name, id] of Object.entries(project.secretRefs)) {
        const entry = secrets.entries[id];
        if (!entry || entry.projectId !== projectId)
          throw new EnvironmentError("项目引用的密钥缺失，请重新配置。");
        let value: string;
        try {
          value = await this.encryption.decrypt(
            Buffer.from(entry.encrypted, "base64"),
          );
        } catch {
          throw new EnvironmentError(
            "系统无法解密项目密钥，请检查当前 Windows 用户。",
          );
        }
        values[name] = value;
        sensitive.push(value);
      }
      return { values, sensitive };
    });
  }
  prune(projectIds: string[]) {
    return this.exclusive(async () => {
      const [env, secrets] = await this.files();
      const valid = new Set(projectIds);
      for (const id of Object.keys(env.projects))
        if (!valid.has(id)) delete env.projects[id];
      await this.write("env.json", env);
      const refs = new Set(
        Object.values(env.projects).flatMap((project) =>
          Object.values(project.secretRefs),
        ),
      );
      for (const [id, entry] of Object.entries(secrets.entries))
        if (!refs.has(id) || !valid.has(entry.projectId))
          delete secrets.entries[id];
      await this.write("secrets.enc", secrets);
    });
  }
}
