import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";
import { BackupStore } from "../electron/main/backup-store.ts";
import { EnvironmentStore } from "../electron/main/environment-store.ts";
import { MaintenanceGate } from "../electron/main/maintenance.ts";

test("backup restores metadata and environment together, retains local secrets and rejects damaged packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-backup-"));
  const data = join(root, "data");
  let workspace = openDatabase(data);
  let closed = false;
  t.after(async () => {
    if (!closed) workspace.database.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = new DirectoryStore(workspace.database);
  const id = store.add("project", await resolveDirectory(root), {
    name: "original",
    description: "",
    projectType: "web",
    tags: [],
  });
  const env = new EnvironmentStore(data, {
    encrypt: async () => Buffer.from("ciphertext"),
    decrypt: async () => "secret-value",
  });
  await env.save(id, { MODE: "original" });
  await env.setSecret(id, "TOKEN", "secret-value");
  const backups = new BackupStore(data),
    destination = join(root, "export.devhub-backup");
  await backups.export(workspace.database, await env.snapshot(), destination);
  const contents = await readFile(destination, "utf8");
  assert.ok(
    !contents.includes("secret-value") && !contents.includes("ciphertext"),
  );
  const prepared = await backups.prepare(destination);
  assert.equal(prepared.preview.projects, 1);
  assert.equal(prepared.preview.secretReferences, 1);
  workspace.database.prepare("UPDATE projects SET name='changed'").run();
  await env.save(id, { MODE: "changed" });
  const secretBefore = await readFile(join(data, "secrets.enc"));
  const rollback = await backups.restore(
    prepared,
    workspace.database,
    await env.snapshot(),
    async () => {
      workspace.database.close();
      closed = true;
    },
  );
  assert.ok(rollback.includes("before-restore"));
  workspace = openDatabase(data);
  closed = false;
  assert.equal(
    workspace.database.prepare("SELECT name FROM projects").get()?.name,
    "original",
  );
  assert.equal((await env.resolve(id)).values.MODE, "original");
  assert.deepEqual(await readFile(join(data, "secrets.enc")), secretBefore);
  await backups.discard(prepared);
  const damaged = JSON.parse(contents);
  damaged.database.sha256 = "0".repeat(64);
  await writeFile(destination, JSON.stringify(damaged));
  await assert.rejects(backups.prepare(destination), /校验/);
  damaged.version = 99;
  await writeFile(destination, JSON.stringify(damaged));
  await assert.rejects(backups.prepare(destination), /版本/);
});

test("restore rolls back failures at every switch boundary and startup recovers interrupted switching", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-rollback-"));
  const data = join(root, "data");
  let current = openDatabase(data);
  let closed = false;
  t.after(async () => {
    if (!closed) current.database.close();
    await rm(root, { recursive: true, force: true });
  });
  const env = { version: 1 as const, projects: {} };
  const backups = new BackupStore(data);
  const file = join(root, "state.devhub-backup");
  await backups.export(current.database, env, file);
  const prepared = await backups.prepare(file);
  current.database
    .prepare("INSERT INTO app_settings VALUES('marker','123','today')")
    .run();
  for (const stage of [
    "before-switch",
    "after-database",
    "after-environment",
  ]) {
    await assert.rejects(
      backups.restore(
        prepared,
        current.database,
        env,
        async () => {
          current.database.close();
          closed = true;
        },
        async (step) => {
          if (step === stage) throw new Error("injected disk failure");
        },
      ),
      /回滚/,
    );
    current = openDatabase(data);
    closed = false;
    assert.equal(
      current.database
        .prepare("SELECT value_json FROM app_settings WHERE key='marker'")
        .get()?.value_json,
      "123",
    );
  }
  current.database.close();
  closed = true;
  const transaction = join(data, "restore-transaction");
  await mkdir(transaction);
  await copyFile(join(data, "devhub.sqlite"), join(transaction, "old.sqlite"));
  const bytes = Buffer.from(JSON.stringify(env));
  await writeFile(join(transaction, "old-env.json"), bytes);
  const hash = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  await writeFile(
    join(transaction, "journal.json"),
    JSON.stringify({
      version: 1,
      phase: "switching",
      databaseHash: hash(await readFile(join(transaction, "old.sqlite"))),
      environmentHash: hash(bytes),
    }),
  );
  await copyFile(
    join(prepared.path, "devhub.sqlite"),
    join(data, "devhub.sqlite"),
  );
  await writeFile(join(data, "env.json"), "broken");
  assert.match((await backups.recover())!, /回滚/);
  current = openDatabase(data);
  closed = false;
  assert.equal(
    current.database
      .prepare("SELECT value_json FROM app_settings WHERE key='marker'")
      .get()?.value_json,
    "123",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(data, "env.json"), "utf8")),
    env,
  );
  await backups.discard(prepared);
});

test("maintenance drains existing operations, refuses new mutations and preserves shutdown barrier", async () => {
  const gate = new MaintenanceGate();
  let release!: () => void;
  const active = gate.request(() => new Promise<void>((r) => (release = r)));
  let entered = false;
  const maintenance = gate.exclusive(async () => {
    entered = true;
    gate.seal();
  });
  assert.equal(entered, false);
  assert.equal(((await gate.request(() => 123)) as { ok: boolean }).ok, false);
  release();
  await active;
  await maintenance;
  assert.equal(entered, true);
  assert.equal(((await gate.request(() => 123)) as { ok: boolean }).ok, false);
});

test("missing secret references remain visible after restoring a backup on a different local store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-secret-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentStore(root, {
    encrypt: async () => Buffer.alloc(0),
    decrypt: async () => "",
  });
  const id = randomUUID();
  await writeFile(
    join(root, "env.json"),
    JSON.stringify({
      version: 1,
      projects: { [id]: { values: {}, secretRefs: { TOKEN: randomUUID() } } },
    }),
  );
  assert.equal((await store.view(id)).secrets[0].configured, false);
  await assert.rejects(store.resolve(id), /密钥缺失/);
});
