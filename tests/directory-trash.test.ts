import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";
import {
  recycleDirectory,
  inspectTrashTarget,
} from "../electron/main/directory-trash.ts";

test("recycle confirms the same directory and retains records on success, cancellation and failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-trash-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "project");
  const data = join(root, "data");
  await mkdir(path);
  await writeFile(join(path, "owned.txt"), "keep");
  const workspace = openDatabase(data);
  try {
    const store = new DirectoryStore(workspace.database);
    const id = store.add("project", await resolveDirectory(path), {
      name: "Project",
      description: "",
      projectType: "other",
      tags: [],
    });
    let calls = 0;
    const trash = async (actual: string) => {
      calls++;
      await rename(actual, join(root, "simulated-recycle-bin"));
    };
    const options = {
      store,
      kind: "project" as const,
      id,
      protectedPaths: [data],
      trash,
    };
    await recycleDirectory({ ...options, confirm: async () => false });
    assert.equal(calls, 0);
    await assert.rejects(
      recycleDirectory({
        ...options,
        confirm: async () => true,
        trash: async () => {
          throw new Error("locked");
        },
      }),
      /回收站失败/,
    );
    assert.equal(await readFile(join(path, "owned.txt"), "utf8"), "keep");
    assert.equal((await store.list("project")).length, 1);
    await assert.rejects(
      recycleDirectory({
        ...options,
        confirm: async () => {
          await rename(path, join(root, "previous"));
          await mkdir(path);
          return true;
        },
      }),
      /确认期间目录已变化/,
    );
    assert.equal(calls, 0);
    await recycleDirectory({
      ...options,
      confirm: async (actual) => {
        assert.equal(actual, (await resolveDirectory(path)).path);
        return true;
      },
    });
    assert.equal(calls, 1);
    const [record] = await store.list("project");
    assert.equal(record.id, id);
    assert.equal(record.availability, "missing");
    assert.equal(
      await readFile(join(root, "previous", "owned.txt"), "utf8"),
      "keep",
    );
  } finally {
    workspace.database.close();
  }
});

test("recycle refuses registered ancestors, descendants, application data and home", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-trash-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  const child = join(parent, "child");
  const data = join(root, "data");
  await mkdir(child, { recursive: true });
  const workspace = openDatabase(data);
  try {
    const store = new DirectoryStore(workspace.database);
    const fields = {
      name: "Item",
      description: "",
      projectType: "other" as const,
      tags: [],
    };
    const parentId = store.add(
      "template",
      await resolveDirectory(parent),
      fields,
    );
    const childId = store.add("project", await resolveDirectory(child), fields);
    await assert.rejects(
      inspectTrashTarget(store, "template", parentId, [data]),
      /包含关系/,
    );
    await assert.rejects(
      inspectTrashTarget(store, "project", childId, [data]),
      /包含关系/,
    );
    const dataId = store.add("project", await resolveDirectory(data), fields);
    await assert.rejects(
      inspectTrashTarget(store, "project", dataId, [data]),
      /应用/,
    );
    const homeId = store.add(
      "project",
      await resolveDirectory(homedir()),
      fields,
    );
    await assert.rejects(
      inspectTrashTarget(store, "project", homeId, [data]),
      /主目录/,
    );
  } finally {
    workspace.database.close();
  }
});
