import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import { DirectoryStore } from "./directory-store";
import { createGitRunner } from "./git-runner";
import type { GitRequest, GitResult } from "../../shared/git";

export async function smokeGit(window: BrowserWindow, store: DirectoryStore) {
  const entry = (await store.list("project")).find(
    (item) => item.name === "Created smoke project",
  )!;
  const call = async (request: GitRequest) => {
    const result = (await window.webContents.executeJavaScript(
      `window.devhub.git(${JSON.stringify(request)})`,
    )) as GitResult;
    if (!result.ok)
      throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data;
  };
  assert.match(
    (await call({ action: "tools", requestId: randomUUID() })).version!,
    /^git version /,
  );
  const initial = (
    await call({
      action: "inspect",
      projectId: entry.id,
      requestId: randomUUID(),
    })
  ).repository!;
  assert.equal(initial.kind, "repository");
  assert.equal(initial.status?.unborn, true);
  const page = `document.querySelector('devhub-app').shadowRoot.querySelector('devhub-directory-page')`;
  const panel = `${page}.shadowRoot.querySelector('devhub-git-panel')`;
  await window.webContents.executeJavaScript(
    `[...${page}.shadowRoot.querySelectorAll('.detail-tabs button')].find(button=>button.textContent.trim()==='Git').click()`,
  );
  const waitFor = async (expression: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await delay(50);
    }
    throw new Error("Git rendered UI did not reach expected state");
  };
  await waitFor(`${panel}?.shadowRoot?.textContent.includes('尚无提交')`);
  await window.webContents.executeJavaScript(
    `[...${panel}.shadowRoot.querySelectorAll('button')].find(button=>button.textContent.trim()==='添加 Remote').click()`,
  );
  await waitFor(`!!${panel}.shadowRoot.querySelector('form')`);
  await window.webContents.executeJavaScript(
    `(() => { const form=${panel}.shadowRoot.querySelector('form'); form.querySelector('[name=name]').value='smoke-origin'; form.querySelector('[name=url]').value='https://github.com/example/m4-smoke.git'; form.requestSubmit(); })()`,
  );
  await waitFor(
    `${panel}.shadowRoot.querySelector('.remotes')?.textContent.includes('m4-smoke.git') && !${panel}.shadowRoot.querySelector('form')`,
  );
  let repository = (
    await call({
      action: "inspect",
      projectId: entry.id,
      requestId: randomUUID(),
    })
  ).repository!;
  assert.equal(repository.remotes[0].name, "smoke-origin");
  await window.webContents.executeJavaScript(
    `[...${panel}.shadowRoot.querySelectorAll('button')].find(button=>button.textContent.trim()==='修改 Fetch').click()`,
  );
  await waitFor(`!!${panel}.shadowRoot.querySelector('form')`);
  await window.webContents.executeJavaScript(
    `(() => { const form=${panel}.shadowRoot.querySelector('form'); form.querySelector('[name=url]').value='git@github.com:example/m4-updated.git'; form.requestSubmit(); })()`,
  );
  await waitFor(
    `${panel}.shadowRoot.querySelector('.remotes')?.textContent.includes('m4-updated.git') && !${panel}.shadowRoot.querySelector('form')`,
  );
  await writeFile(join(entry.path, "M4 untracked 中文.txt"), "External edit");
  const run = createGitRunner();
  await run(
    entry.path,
    ["remote", "add", "external", "https://github.com/example/external.git"],
    new AbortController().signal,
  );
  await window.webContents.executeJavaScript(
    `[...${panel}.shadowRoot.querySelectorAll('button')].find(button=>button.textContent.trim()==='重新检测').click()`,
  );
  await waitFor(
    `${panel}.shadowRoot.querySelector('.remotes')?.textContent.includes('external.git')`,
  );
  repository = (
    await call({
      action: "inspect",
      projectId: entry.id,
      requestId: randomUUID(),
    })
  ).repository!;
  assert.ok(
    repository.status?.files.some(
      (file) => file.path === "M4 untracked 中文.txt",
    ),
  );
  const invalid = await window.webContents.executeJavaScript(
    `window.devhub.git(${JSON.stringify({ action: "add", projectId: entry.id, requestId: randomUUID(), name: "unsafe", url: "https://user:private-token@github.com/example/repo", revision: repository.revision })})`,
  );
  assert.equal(invalid.ok, false);
  assert.ok(!JSON.stringify(invalid).includes("private-token"));
  if (process.env.DEVHUB_GIT_SMOKE_SCREENSHOT) {
    window.setContentSize(1200, 1100);
    await window.webContents.executeJavaScript(`window.scrollTo(0,0)`);
    await delay(100);
    await writeFile(
      process.env.DEVHUB_GIT_SMOKE_SCREENSHOT,
      (
        await window.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      ).toPNG(),
    );
    window.setContentSize(1200, 800);
  }
  await window.webContents.executeJavaScript(
    `(() => { const row=[...${panel}.shadowRoot.querySelectorAll('.remotes > li')].find(row=>row.textContent.includes('smoke-origin')); [...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='删除 Remote').click(); })()`,
  );
  await waitFor(
    `!${panel}.shadowRoot.querySelector('.remotes')?.textContent.includes('smoke-origin') && ${panel}.shadowRoot.querySelector('.remotes')?.textContent.includes('external')`,
  );
  repository = (
    await call({
      action: "inspect",
      projectId: entry.id,
      requestId: randomUUID(),
    })
  ).repository!;
  assert.deepEqual(
    repository.remotes.map((remote) => remote.name),
    ["external"],
  );
  console.log(
    "DevHub M4 smoke passed: packaged Git CLI, sandbox IPC, Lit Remote CRUD, external refresh, status and credential rejection.",
  );
}
