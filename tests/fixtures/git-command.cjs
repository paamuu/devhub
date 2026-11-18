const fs = require("node:fs");
const mode = process.argv.at(-1);
if (mode === "flood") {
  setInterval(() => process.stdout.write("x".repeat(65536)), 5);
} else if (mode === "failure") {
  process.stderr.write(
    "fatal: credential https://user:secret-token@example.com/repo",
  );
  process.exit(2);
} else {
  fs.writeFileSync("fake-git.pid", String(process.pid));
  setInterval(() => {}, 1000);
}
