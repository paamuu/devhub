import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../electron/main/database.ts";
import {
  DirectoryStore,
  resolveDirectory,
} from "../electron/main/directory-store.ts";
import {
  GitService,
  type GitConfirmation,
} from "../electron/main/git-service.ts";
import { createGitRunner } from "../electron/main/git-runner.ts";
import { gitRequest, githubUrl, type GitRequest } from "../shared/git.ts";
import { parseGitStatus } from "../electron/main/git-status.ts";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devhub-git-"));
  const path = join(root, "project with spaces");
  await mkdir(path);
  const workspace = openDatabase(join(root, "data"));
  const store = new DirectoryStore(workspace.database);
  const register = async (path: string) =>
    store.add("project", await resolveDirectory(path), {
      name: "Git fixture",
      description: "",
      projectType: "other",
      tags: [],
    });
  const id = await register(path);
  let accept = true;
  let hook = async (_plan: GitConfirmation) => {};
  let opened = "";
  const confirmations: GitConfirmation[] = [];
  const service = new GitService({
    store,
    directoryBusy: () => false,
    confirm: async (plan) => {
      confirmations.push(plan);
      await hook(plan);
      return accept;
    },
    openBrowser: async (url) => {
      opened = url;
    },
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_") && key !== "DEBUG",
    ),
  );
  const git = async (args: string[], cwd = path) =>
    (
      await promisify(execFile)(
        "git",
        [
          "-c",
          "init.templateDir=",
          "-c",
          `core.hooksPath=${join(root, "empty-hooks")}`,
          "-c",
          "user.name=DevHub Test",
          "-c",
          "user.email=devhub-test@example.invalid",
          ...args,
        ],
        { cwd, env, windowsHide: true },
      )
    ).stdout;
  const init = async () => {
    await git(["init", "--initial-branch=main"]);
  };
  const inspect = async (projectId = id) =>
    (
      await service.execute({
        action: "inspect",
        projectId,
        requestId: randomUUID(),
      })
    ).repository!;
  const call = (
    request:
      | Omit<Extract<GitRequest, { action: "add" }>, "projectId" | "requestId">
      | Omit<
          Extract<GitRequest, { action: "update" }>,
          "projectId" | "requestId"
        >
      | Omit<
          Extract<GitRequest, { action: "remove" | "open" }>,
          "projectId" | "requestId"
        >,
    projectId = id,
  ) =>
    service.execute({
      ...request,
      projectId,
      requestId: randomUUID(),
    } as GitRequest);
  t.after(async () => {
    await service.shutdown();
    workspace.database.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    root,
    path,
    store,
    id,
    register,
    service,
    git,
    init,
    inspect,
    call,
    confirmations,
    accept: (value: boolean) => {
      accept = value;
    },
    hook: (value: typeof hook) => {
      hook = value;
    },
    opened: () => opened,
  };
}
test("Git detects non-repositories, bare repos, unborn branches and system Git without inheriting GIT_DIR", async (t) => {
  const f = await setup(t);
  assert.equal((await f.inspect()).kind, "none");
  await f.init();
  const initial = await f.inspect();
  assert.equal(initial.kind, "repository");
  assert.equal(initial.status?.branch, "main");
  assert.equal(initial.status?.unborn, true);
  assert.equal(initial.status?.total, 0);
  assert.match(
    (await f.service.execute({ action: "tools", requestId: randomUUID() }))
      .version!,
    /^git version /,
  );
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, "does-not-exist");
  try {
    assert.equal((await f.inspect()).kind, "repository");
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  const bare = join(f.root, "bare.git");
  await f.git(["init", "--bare", bare]);
  const bareId = await f.register(bare);
  assert.equal((await f.inspect(bareId)).kind, "bare");
  const runner = createGitRunner({ binary: "devhub-missing-git-12345" });
  await assert.rejects(
    runner(f.path, ["--version"], new AbortController().signal),
    { code: "GIT_MISSING" },
  );
});
test("Remote CRUD confirms, preserves other URLs and push overrides, refreshes external edits and sanitizes credentials", async (t) => {
  const f = await setup(t);
  await f.init();
  let repo = await f.inspect();
  f.accept(false);
  await f.call({
    action: "add",
    name: "origin",
    url: "https://github.com/example/first.git",
    revision: repo.revision,
  });
  assert.equal((await f.inspect()).remotes.length, 0);
  f.accept(true);
  repo = (
    await f.call({
      action: "add",
      name: "origin",
      url: "https://github.com/example/first.git",
      revision: repo.revision,
    })
  ).repository!;
  assert.equal(repo.remotes[0].browserUrl, "https://github.com/example/first");
  await f.call({ action: "open", name: "origin", revision: repo.revision });
  assert.equal(f.opened(), "https://github.com/example/first");
  await f.git([
    "remote",
    "set-url",
    "--add",
    "origin",
    "https://github.com/example/extra.git",
  ]);
  await assert.rejects(
    f.call({
      action: "update",
      name: "origin",
      target: "fetch",
      url: "git@github.com:example/changed.git",
      revision: repo.revision,
    }),
    { code: "STALE" },
  );
  repo = await f.inspect();
  repo = (
    await f.call({
      action: "update",
      name: "origin",
      target: "fetch",
      url: "git@github.com:example/changed.git",
      revision: repo.revision,
    })
  ).repository!;
  assert.deepEqual(repo.remotes[0].fetch, [
    "git@github.com:example/changed.git",
    "https://github.com/example/extra.git",
  ]);
  repo = (
    await f.call({
      action: "update",
      name: "origin",
      target: "push",
      url: "ssh://git@github.com/example/push.git",
      revision: repo.revision,
    })
  ).repository!;
  assert.equal(repo.remotes[0].explicitPush, true);
  assert.deepEqual(repo.remotes[0].push, [
    "ssh://git@github.com/example/push.git",
  ]);
  f.hook(async () => {
    await f.git([
      "config",
      "--local",
      "--replace-all",
      "remote.origin.url",
      "https://github.com/example/external.git",
    ]);
  });
  await assert.rejects(
    f.call({ action: "remove", name: "origin", revision: repo.revision }),
    { code: "STALE" },
  );
  f.hook(async () => {});
  await f.git([
    "remote",
    "add",
    "private",
    "https://user:super-secret@example.com/owner/repo.git",
  ]);
  repo = await f.inspect();
  assert.ok(!JSON.stringify(repo).includes("super-secret"));
  assert.equal(
    repo.remotes.find((item) => item.name === "private")?.browserUrl,
    null,
  );
  await assert.rejects(
    f.call({ action: "open", name: "private", revision: repo.revision }),
    { code: "UNSUPPORTED_URL" },
  );
  await f.call({ action: "remove", name: "private", revision: repo.revision });
  assert.ok(!JSON.stringify(f.confirmations).includes("super-secret"));
  repo = await f.inspect();
  await f.call({ action: "remove", name: "origin", revision: repo.revision });
  assert.equal((await f.inspect()).remotes.length, 0);
});
test("Git status reflects staged, unstaged, renamed, untracked, detached and conflict states", async (t) => {
  const f = await setup(t);
  await f.init();
  await writeFile(join(f.path, "tracked.txt"), "base\n");
  await writeFile(join(f.path, "rename old.txt"), "rename\n");
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "base"]);
  await writeFile(join(f.path, "tracked.txt"), "staged\n");
  await f.git(["add", "tracked.txt"]);
  await writeFile(join(f.path, "tracked.txt"), "unstaged\n");
  await f.git(["mv", "rename old.txt", "重命名 file.txt"]);
  await writeFile(join(f.path, "untracked 中文.txt"), "new");
  let repo = await f.inspect();
  assert.equal(repo.status?.staged, 2);
  assert.equal(repo.status?.modified, 1);
  assert.equal(repo.status?.untracked, 1);
  assert.equal(
    repo.status?.files.find((item) => item.path === "重命名 file.txt")
      ?.originalPath,
    "rename old.txt",
  );
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "changes"]);
  await f.git(["checkout", "--detach"]);
  repo = await f.inspect();
  assert.equal(repo.status?.detached, true);
  assert.equal(repo.status?.branch, null);
  assert.equal(repo.status?.total, 0);
  await f.git(["checkout", "-b", "other"]);
  await writeFile(join(f.path, "tracked.txt"), "other branch\n");
  await f.git(["commit", "-am", "other"]);
  await f.git(["checkout", "main"]);
  await writeFile(join(f.path, "tracked.txt"), "main branch\n");
  await f.git(["commit", "-am", "main"]);
  await assert.rejects(f.git(["merge", "other"]));
  repo = await f.inspect();
  assert.equal(repo.status?.conflicted, 1);
  assert.equal(repo.status?.files[0].conflict, true);
});
test("nested registrations are read-only while linked worktrees share serialized Remote writes", async (t) => {
  const f = await setup(t);
  await f.init();
  await writeFile(join(f.path, "file.txt"), "base");
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "base"]);
  const nested = join(f.path, "nested");
  await mkdir(nested);
  const nestedId = await f.register(nested);
  const child = await f.inspect(nestedId);
  assert.equal(child.kind, "nested");
  assert.equal(child.root, (await resolveDirectory(f.path)).path);
  assert.equal(child.writable, false);
  await assert.rejects(
    f.call(
      {
        action: "add",
        name: "origin",
        url: "https://github.com/example/repo.git",
        revision: child.revision,
      },
      nestedId,
    ),
    { code: "NESTED_WORKTREE" },
  );
  const linked = join(f.root, "linked worktree");
  await f.git(["worktree", "add", "-b", "linked", linked]);
  const linkedId = await f.register(linked);
  const a = await f.inspect(),
    b = await f.inspect(linkedId);
  assert.equal(b.kind, "repository");
  assert.equal(b.status?.branch, "linked");
  assert.equal(b.writable, true);
  let confirming = 0,
    maximum = 0;
  f.hook(async () => {
    confirming++;
    maximum = Math.max(maximum, confirming);
    await delay(100);
    confirming--;
  });
  const writes = await Promise.allSettled([
    f.call({
      action: "add",
      name: "origin",
      url: "https://github.com/example/one.git",
      revision: a.revision,
    }),
    f.call(
      {
        action: "add",
        name: "upstream",
        url: "https://github.com/example/two.git",
        revision: b.revision,
      },
      linkedId,
    ),
  ]);
  assert.equal(
    writes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(maximum, 1);
  assert.deepEqual(
    (await f.inspect()).remotes,
    (await f.inspect(linkedId)).remotes,
  );
});
test("cancellation releases pending confirmation without writing, and repository identity changes invalidate consent", async (t) => {
  const f = await setup(t);
  await f.init();
  let repo = await f.inspect();
  let waiting = false;
  f.hook(async () => {
    waiting = true;
    await new Promise<void>(() => {});
  });
  const requestId = randomUUID();
  const pending = f.service.execute({
    action: "add",
    projectId: f.id,
    requestId,
    name: "origin",
    url: "https://github.com/example/repo.git",
    revision: repo.revision,
  });
  const rejection = assert.rejects(pending, { code: "CANCELLED" });
  for (let i = 0; i < 100 && !waiting; i++) await delay(20);
  assert.equal(f.service.busy(f.id), true);
  await f.service.execute({ action: "cancel", requestId });
  await rejection;
  assert.equal(f.service.busy(f.id), false);
  assert.equal((await f.inspect()).remotes.length, 0);
  f.hook(async () => {
    await rename(join(f.path, ".git"), join(f.root, "old-git"));
    await f.init();
  });
  repo = await f.inspect();
  await assert.rejects(
    f.call({
      action: "add",
      name: "origin",
      url: "https://github.com/example/repo.git",
      revision: repo.revision,
    }),
    { code: "STALE" },
  );
  assert.equal((await f.inspect()).remotes.length, 0);
});
test("Git runner terminates timed out and cancelled commands, bounds output and never returns raw credential errors", async (t) => {
  const f = await setup(t);
  const binary: [string, string] = [
    process.execPath,
    resolve("tests/fixtures/git-command.cjs"),
  ];
  const timeout = createGitRunner({ binary, timeoutMs: 250 });
  await assert.rejects(
    timeout(f.path, ["slow"], new AbortController().signal),
    { code: "TIMEOUT" },
  );
  const pid = Number(await readFile(join(f.path, "fake-git.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0));
  const bounded = createGitRunner({ binary, maxBytes: 32768 });
  await assert.rejects(
    bounded(f.path, ["flood"], new AbortController().signal),
    { code: "OUTPUT_LIMIT" },
  );
  const controller = new AbortController();
  const pending = bounded(f.path, ["slow"], controller.signal);
  const rejection = assert.rejects(pending, { code: "CANCELLED" });
  await delay(150);
  controller.abort();
  await rejection;
  await assert.rejects(
    bounded(f.path, ["failure"], new AbortController().signal),
    (error: Error) =>
      !error.message.includes("secret-token") &&
      !error.message.includes("https:"),
  );
});
test("Git URL mapping and request validation reject credentials, shell protocols and option-shaped names", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ])
    assert.equal(githubUrl(url), "https://github.com/owner/repo");
  for (const url of [
    "https://github.com.evil.test/owner/repo",
    "https://user:secret@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "file:///tmp/repo",
    "ext::malicious",
    "git@enterprise.test:owner/repo",
    "https://github.com/owner/../other",
    "https://github.com/owner/repo/issues",
  ])
    assert.equal(githubUrl(url), null);
  for (const name of ["--upload-pack", "name\nother", "bad name", "a..b"])
    assert.equal(
      gitRequest.safeParse({
        action: "add",
        projectId: randomUUID(),
        requestId: randomUUID(),
        name,
        url: "https://github.com/owner/repo",
        revision: "a".repeat(64),
      }).success,
      false,
    );
  const records = Array.from(
    { length: 250 },
    (_, index) => `? path ${index}.txt\0`,
  ).join("");
  const status = parseGitStatus(records);
  assert.equal(status.total, 250);
  assert.equal(status.files.length, 200);
  assert.equal(status.truncated, true);
});
