import type { GitStatus, GitFile } from "../../shared/git.ts";
import { GitServiceError } from "./git-runner.ts";

export function parseGitStatus(output: string): GitStatus {
  const result: GitStatus = {
    branch: null,
    detached: false,
    unborn: false,
    oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    total: 0,
    files: [],
    truncated: false,
  };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const line = records[index];
    if (!line) continue;
    if (line.startsWith("# ")) {
      if (line.startsWith("# branch.head ")) {
        const head = line.slice(14);
        result.detached = head === "(detached)";
        result.branch = result.detached ? null : head;
      }
      if (line.startsWith("# branch.oid ")) {
        const oid = line.slice(13);
        result.unborn = oid === "(initial)";
        result.oid = result.unborn ? null : oid;
      }
      if (line.startsWith("# branch.upstream "))
        result.upstream = line.slice(18);
      const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (ab) {
        result.ahead = Number(ab[1]);
        result.behind = Number(ab[2]);
      }
      continue;
    }
    let file: GitFile;
    if (line.startsWith("? ")) {
      file = {
        path: line.slice(2),
        index: "?",
        worktree: "?",
        conflict: false,
      };
      result.untracked++;
    } else if (["1", "2", "u"].includes(line[0])) {
      const fields = line[0] === "1" ? 8 : line[0] === "2" ? 9 : 10;
      let offset = 0;
      for (let count = 0; count < fields; count++) {
        const space = line.indexOf(" ", offset);
        if (space < 0)
          throw new GitServiceError(
            "STATUS_FORMAT",
            "Git 状态格式无法识别，请检查 Git 版本。",
          );
        offset = space + 1;
      }
      const xy = line.split(" ", 3)[1];
      file = {
        path: line.slice(offset),
        index: xy[0],
        worktree: xy[1],
        conflict: line[0] === "u",
      };
      if (line[0] === "2") file.originalPath = records[++index];
      if (file.conflict) result.conflicted++;
      else {
        if (file.index !== ".") result.staged++;
        if (file.worktree !== ".") result.modified++;
      }
    } else if (line.startsWith("! ")) continue;
    else
      throw new GitServiceError(
        "STATUS_FORMAT",
        "Git 状态格式无法识别，请检查 Git 版本。",
      );
    result.total++;
    if (result.files.length < 200) result.files.push(file);
  }
  result.truncated = result.total > result.files.length;
  return result;
}
