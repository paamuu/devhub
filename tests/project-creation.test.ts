import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";
import { ProjectCreation } from "../electron/main/project-creation.ts";

test(
  "copies isolated projects, cancels, refuses existing destinations and recovers registration",
  { skip: process.platform !== "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "devhub-creation-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "template");
    const destination = join(root, "projects");
    const data = join(root, "data");
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(source, "index.html"), "hello");
    await writeFile(join(source, ".env"), "PRIVATE=true");
    await writeFile(join(source, ".env.example"), "PUBLIC=sample");
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "ignore.txt"), "generated");
    await simpleGit(source).init();
    await simpleGit(source).addRemote(
      "origin",
      "https://github.com/example/template.git",
    );
    const workspace = openDatabase(data);
    const store = new DirectoryStore(workspace.database);
    const service = new ProjectCreation(workspace.database, data);
    try {
      const template = store.add("template", await resolveDirectory(source), {
        name: "Template",
        description: "Description",
        projectType: "web",
        tags: ["demo"],
        techStack: ["Lit", "TypeScript"],
        sourceUrl: "https://github.com/example/template.git",
        previewConfig: {
          adapter: "web-command",
          command: "npm.cmd",
          args: ["run", "dev"],
          cwd: ".",
        },
      });
      const payload = await service.prepare(
        template,
        "Created",
        destination,
        true,
      );
      const id = service.start(payload);
      await service.wait(id);
      assert.equal(
        service.list().find((operation) => operation.id === id)?.state,
        "completed",
      );
      assert.deepEqual(
        (await readdir(payload.target)).sort(),
        [".env.example", ".git", "index.html"].sort(),
      );
      assert.deepEqual(await simpleGit(payload.target).getRemotes(), []);
      const [project] = await store.list("project");
      assert.equal(project.name, "Created");
      assert.deepEqual(project.techStack, ["Lit", "TypeScript"]);
      assert.equal(project.previewConfig?.command, "npm.cmd");
      assert.equal(project.templateName, "Template");
      assert.equal(
        workspace.database
          .prepare("SELECT template_id FROM projects WHERE id = ?")
          .get(project.id)?.template_id,
        template,
      );
      assert.equal(
        await readFile(join(source, ".env"), "utf8"),
        "PRIVATE=true",
      );
      await assert.rejects(
        service.prepare(template, "Created", destination, false),
        /已存在/,
      );
      await assert.rejects(
        service.prepare(template, "Nested", source, false),
        /模板和应用数据目录之外/,
      );

      const cancelled = await service.prepare(
        template,
        "Cancelled",
        destination,
        false,
      );
      const cancelId = service.start(cancelled);
      service.cancel(cancelId);
      await service.wait(cancelId);
      assert.equal(
        service.list().find((operation) => operation.id === cancelId)?.state,
        "cancelled",
      );
      assert.equal((await readdir(destination)).includes("Cancelled"), false);

      const conflict = await service.prepare(
        template,
        "Conflict",
        destination,
        false,
      );
      await mkdir(conflict.target);
      await writeFile(join(conflict.target, "owned.txt"), "existing");
      const conflictId = service.start(conflict);
      await service.wait(conflictId);
      assert.equal(
        service.list().find((operation) => operation.id === conflictId)?.state,
        "failed",
      );
      assert.equal(
        await readFile(join(conflict.target, "owned.txt"), "utf8"),
        "existing",
      );

      workspace.database.exec(
        "CREATE TRIGGER fail_project BEFORE INSERT ON projects BEGIN SELECT RAISE(FAIL, 'simulated storage failure'); END",
      );
      const recovery = await service.prepare(
        template,
        "Recovered",
        destination,
        false,
      );
      const recoveryId = service.start(recovery);
      await service.wait(recoveryId);
      assert.equal(
        service.list().find((operation) => operation.id === recoveryId)?.state,
        "failed",
      );
      assert.equal(
        await readFile(join(recovery.target, "index.html"), "utf8"),
        "hello",
      );
      workspace.database.exec("DROP TRIGGER fail_project");
      workspace.database
        .prepare(
          "UPDATE creation_operations SET state = 'registering' WHERE id = ?",
        )
        .run(recoveryId);
      const resumed = new ProjectCreation(workspace.database, data);
      assert.equal(
        resumed.list().find((operation) => operation.id === recoveryId)?.state,
        "interrupted",
      );
      await resumed.resume(recoveryId);
      await resumed.resume(recoveryId);
      assert.equal((await store.list("project")).length, 2);
      assert.equal(
        resumed.list().find((operation) => operation.id === recoveryId)?.state,
        "completed",
      );
      const partial = await service.prepare(
        template,
        "Restarted",
        destination,
        false,
      );
      const partialId = randomUUID();
      await mkdir(partial.temporary);
      await writeFile(join(partial.temporary, partial.marker), partialId);
      await writeFile(join(partial.temporary, "partial.txt"), "unfinished");
      workspace.database
        .prepare(
          "INSERT INTO creation_operations (id, payload, state, created_at) VALUES (?, ?, 'copying', ?)",
        )
        .run(partialId, JSON.stringify(partial), new Date().toISOString());
      const afterCrash = new ProjectCreation(workspace.database, data);
      await afterCrash.resume(partialId);
      await afterCrash.wait(partialId);
      assert.equal(
        afterCrash.list().find((operation) => operation.id === partialId)
          ?.state,
        "completed",
      );
      assert.deepEqual(
        (await readdir(partial.target)).sort(),
        [".env.example", "index.html"].sort(),
      );
      store.edit("template", template, {
        name: "Changed template",
        description: "",
        projectType: "web",
        tags: [],
        previewConfig: null,
      });
      assert.equal(
        (await store.list("project")).find((entry) => entry.id === project.id)
          ?.previewConfig?.command,
        "npm.cmd",
      );
      store.remove("template", template);
      const retained = (await store.list("project")).find(
        (entry) => entry.id === project.id,
      )!;
      assert.equal(retained.templateId, null);
      assert.equal(retained.templateName, "Template");
      assert.equal(retained.previewConfig?.command, "npm.cmd");
    } finally {
      await service.shutdown();
      workspace.database.close();
    }
  },
);
