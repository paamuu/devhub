import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import {
  previewConfigSchema,
  sourceUrlSchema,
} from "../shared/preview-config.ts";
import { detectDirectory } from "../electron/main/directory-detection.ts";

test("preview and source metadata reject directory escapes and credentials", () => {
  const config = {
    adapter: "web-command",
    command: "npm.cmd",
    args: ["run", "dev"],
    cwd: ".",
  };
  assert.ok(previewConfigSchema.safeParse(config).success);
  for (const cwd of [
    "..",
    "../outside",
    "C:\\outside",
    "/outside",
    "nested/../../outside",
  ]) {
    assert.equal(
      previewConfigSchema.safeParse({ ...config, cwd }).success,
      false,
    );
  }
  assert.equal(
    previewConfigSchema.safeParse({
      ...config,
      readyCheck: { type: "http", url: "https://example.com", timeoutMs: 1000 },
    }).success,
    false,
  );
  assert.equal(
    sourceUrlSchema.safeParse("https://token@github.com/owner/repository.git")
      .success,
    false,
  );
  assert.equal(
    sourceUrlSchema.safeParse(
      "https://github.com/owner/repository.git?token=secret",
    ).success,
    false,
  );
  assert.ok(
    sourceUrlSchema.safeParse("git@github.com:owner/repository.git").success,
  );
});

test("import detects local metadata without executing package scripts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-detect-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "sample",
      description: "Example",
      dependencies: { lit: "latest" },
      devDependencies: { typescript: "latest" },
      scripts: { postinstall: "must-never-run" },
    }),
  );
  await simpleGit(root).init();
  await simpleGit(root).addRemote(
    "origin",
    "https://github.com/owner/example.git",
  );
  const detected = await detectDirectory(root);
  assert.equal(detected.name, "sample");
  assert.equal(detected.projectType, "web");
  assert.deepEqual(detected.techStack, ["lit", "typescript"]);
  assert.equal(detected.sourceUrl, "https://github.com/owner/example.git");
  await simpleGit(root).remote([
    "set-url",
    "origin",
    "https://token@github.com/owner/example.git",
  ]);
  assert.equal((await detectDirectory(root)).sourceUrl, undefined);
});
