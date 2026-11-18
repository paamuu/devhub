import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";

test("registers, edits, relinks and removes records while preserving directory content", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "devhub-directory-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, "Original");
  const moved = join(root, "Moved");
  const occupied = join(root, "Occupied");
  mkdirSync(original);
  mkdirSync(occupied);
  writeFileSync(join(original, "sentinel.txt"), "preserve directory contents");
  const workspace = openDatabase(root);
  try {
    const store = new DirectoryStore(workspace.database);
    const fields = {
      name: "Example",
      description: "",
      projectType: "web" as const,
      tags: ["Demo", "demo"],
    };
    const resolved = await resolveDirectory(original);
    const id = store.add("template", resolved, fields);
    assert.throws(() => store.add("project", resolved, fields), /已登记/);
    assert.equal((await store.list("template"))[0]?.tags.length, 1);

    const occupiedDirectory = await resolveDirectory(occupied);
    const project = store.add("project", occupiedDirectory, fields);
    store.archive(project, true);
    assert.ok((await store.list("project"))[0]?.archivedAt);
    store.archive(project, false);
    assert.equal((await store.list("project"))[0]?.archivedAt, null);

    renameSync(original, moved);
    assert.equal((await store.list("template"))[0]?.availability, "missing");
    assert.throws(
      () => store.relink("template", id, occupiedDirectory),
      /已登记/,
    );
    store.relink("template", id, await resolveDirectory(moved));
    store.edit("template", id, {
      ...fields,
      name: "Renamed",
      tags: ["Updated"],
    });
    const [updated] = await store.list("template");
    assert.equal(updated.id, id);
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.availability, "available");
    assert.deepEqual(updated.tags, ["Updated"]);

    store.remove("template", id);
    assert.deepEqual(await store.list("template"), []);
    assert.equal(
      readFileSync(join(moved, "sentinel.txt"), "utf8"),
      "preserve directory contents",
    );
  } finally {
    workspace.database.close();
  }
});

test("resolves a directory alias to the same registration key", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "devhub-directory-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const original = join(root, "Original");
  const alias = join(root, "Alias");
  mkdirSync(original);
  try {
    symlinkSync(
      original,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    context.skip(
      "The test environment does not allow creating directory aliases.",
    );
    return;
  }
  assert.equal(
    (await resolveDirectory(alias)).key,
    (await resolveDirectory(original)).key,
  );
});
