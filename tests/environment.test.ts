import assert from "node:assert/strict";
import { test } from "node:test";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentStore } from "../electron/main/environment-store.ts";
import {
  PreviewJournal,
  SecretRedactor,
} from "../electron/main/preview-log.ts";
import { runtimeRequest } from "../shared/runtime.ts";

export function testEncryption() {
  const key = randomBytes(32);
  return {
    async encrypt(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const result = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), result]);
    },
    async decrypt(value: Buffer) {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([
        cipher.update(value.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
}
test("project environments isolate encrypted secrets, reject conflicts and prune deleted project references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const encryption = testEncryption();
  const store = new EnvironmentStore(root, encryption);
  const first = randomUUID(),
    second = randomUUID();
  const secret = "test-secret-密钥-" + randomUUID();
  await store.save(first, { NORMAL: "plain-value" });
  await Promise.all([
    store.setSecret(first, "TOKEN", secret),
    store.save(second, { OTHER: "isolated" }),
  ]);
  assert.deepEqual(await store.view(first), {
    values: { NORMAL: "plain-value" },
    secrets: [{ name: "TOKEN", configured: true }],
  });
  assert.deepEqual((await store.resolve(first)).values, {
    NORMAL: "plain-value",
    TOKEN: secret,
  });
  assert.deepEqual((await store.resolve(second)).values, { OTHER: "isolated" });
  assert.ok(!(await readFile(join(root, "env.json"), "utf8")).includes(secret));
  const before = await readFile(join(root, "secrets.enc"), "utf8");
  assert.ok(!before.includes(secret));
  await assert.rejects(store.save(first, { token: "conflict" }), /重名/);
  await assert.rejects(store.setSecret(first, "normal", "conflict"), /已存在/);
  const unavailable = new EnvironmentStore(root, {
    async encrypt() {
      throw new Error(secret);
    },
    async decrypt() {
      throw new Error(secret);
    },
  });
  await assert.rejects(
    unavailable.setSecret(first, "TOKEN", "replacement"),
    /密钥未保存/,
  );
  await assert.rejects(unavailable.resolve(first), /无法解密/);
  assert.equal(await readFile(join(root, "secrets.enc"), "utf8"), before);
  await store.setSecret(first, "TOKEN", "replacement");
  assert.equal((await store.resolve(first)).values.TOKEN, "replacement");
  await store.prune([second]);
  assert.deepEqual(await store.view(first), { values: {}, secrets: [] });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "secrets.enc"), "utf8")).entries,
    {},
  );
  assert.deepEqual((await store.resolve(second)).values, { OTHER: "isolated" });
  await writeFile(join(root, "env.json"), "invalid JSON");
  await assert.rejects(store.save(second, {}), /无法读取/);
  assert.equal(await readFile(join(root, "env.json"), "utf8"), "invalid JSON");
});
test("runtime validation forbids reserved environment keys and malformed launch requests", () => {
  for (const name of [
    "DEVHUB_LAUNCH_SPEC",
    "devhub_test",
    "ELECTRON_RUN_AS_NODE",
    "bad-name",
    "__proto__",
  ]) {
    assert.equal(
      runtimeRequest.safeParse({
        action: "set-secret",
        projectId: randomUUID(),
        name,
        value: "x",
      }).success,
      false,
    );
  }
  assert.equal(
    runtimeRequest.safeParse({
      action: "save-ide",
      config: { command: "code", args: ["x\nwhoami"] },
    }).success,
    false,
  );
});
test("redaction handles every split position, adjacent matches, regex characters and multibyte secrets", () => {
  const long = new SecretRedactor(["long-secret-prefix-" + "x".repeat(8000)]);
  assert.equal(long.push("ordinary log\n"), "ordinary log\n");
  const values = ["abc123", "密钥💡value", "a.*[b]$", "short"];
  const text = `prefix:${values.join("|")}:${values.join("")}:end`;
  const expected = `prefix:${values.map(() => "[REDACTED]").join("|")}:${values.map(() => "[REDACTED]").join("")}:end`;
  for (let split = 0; split <= text.length; split++) {
    const filter = new SecretRedactor(values);
    assert.equal(
      filter.push(text.slice(0, split)) +
        filter.push(text.slice(split)) +
        filter.push("", true),
      expected,
    );
  }
  const filter = new SecretRedactor(values);
  assert.equal(
    [...text].map((char) => filter.push(char)).join("") + filter.push("", true),
    expected,
  );
});
test("preview journal rotates within a fixed disk budget and reports backpressure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devhub-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new PreviewJournal(root, 1024);
  for (let sequence = 0; sequence < 30; sequence++) {
    journal.record("project", "session", {
      sequence,
      time: "now",
      stream: "stdout",
      text: "a".repeat(200),
    });
    await journal.flush();
  }
  const files = await readdir(root);
  assert.equal(files.length, 3);
  for (const file of files)
    assert.ok((await stat(join(root, file))).size <= 1024);
  for (let sequence = 0; sequence < 30; sequence++)
    journal.record("p", "s", {
      sequence,
      time: "now",
      stream: "stdout",
      text: "a".repeat(200),
    });
  assert.equal(journal.failed, true);
  await journal.flush();
});
