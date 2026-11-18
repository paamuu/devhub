import { mkdir, appendFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { PreviewLog } from "../../shared/runtime.ts";

/** Retain enough original input to match secrets split across pipe chunks. */
export class SecretRedactor {
  private pending = "";
  private readonly pattern?: RegExp;
  private readonly values: string[];
  constructor(secrets: string[]) {
    const values = [...new Set(secrets.filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    );
    this.values = values;
    if (values.length)
      this.pattern = new RegExp(
        values
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|"),
        "g",
      );
  }
  push(text: string, final = false) {
    this.pending += text;
    let limit = this.pending.length;
    // Hold only a suffix that could still become a secret. Ordinary short log
    // lines must not wait for a configured long secret's full length.
    if (!final)
      for (const value of this.values) {
        let from = Math.max(0, this.pending.length - value.length + 1);
        while (from < limit) {
          const candidate = this.pending.indexOf(value[0], from);
          if (candidate < 0 || candidate >= limit) break;
          if (value.startsWith(this.pending.slice(candidate))) {
            limit = candidate;
            break;
          }
          from = candidate + 1;
        }
      }
    let consumed = 0;
    let result = "";
    if (this.pattern) {
      this.pattern.lastIndex = 0;
      for (
        let match = this.pattern.exec(this.pending);
        match && match.index < limit;
        match = this.pattern.exec(this.pending)
      ) {
        result += this.pending.slice(consumed, match.index) + "[REDACTED]";
        consumed = match.index + match[0].length;
      }
    }
    if (consumed < limit) {
      result += this.pending.slice(consumed, limit);
      consumed = limit;
    }
    this.pending = this.pending.slice(consumed);
    return result;
  }
}

/** A global, bounded JSONL journal. Only already-redacted text may enter. */
export class PreviewJournal {
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private readonly logger;
  private readonly directory: string;
  private readonly maxBytes: number;
  failed = false;
  constructor(directory: string, maxBytes = 1024 * 1024) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.logger = pino(
      { base: undefined, timestamp: false },
      { write: (line: string) => this.enqueue(line) },
    );
  }
  record(projectId: string, sessionId: string, entry: PreviewLog) {
    this.logger.info({ projectId, sessionId, ...entry });
  }
  private enqueue(line: string) {
    const size = Buffer.byteLength(line);
    if (this.pendingBytes + size > this.maxBytes) {
      this.failed = true;
      return;
    }
    this.pendingBytes += size;
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = join(this.directory, "preview.log");
        const current = await stat(path).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (current && current.size + size > this.maxBytes) {
          await rm(`${path}.2`, { force: true });
          await rename(`${path}.1`, `${path}.2`).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
          await rename(path, `${path}.1`);
        }
        await appendFile(path, line, { mode: 0o600 });
      })
      .catch(() => {
        this.failed = true;
      })
      .finally(() => {
        this.pendingBytes -= size;
      });
  }
  flush() {
    return this.queue;
  }
}
