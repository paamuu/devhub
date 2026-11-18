const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [mode, portText, marker] = process.argv.slice(2);
const port = Number(portText);
if (mode === "orphan") {
  const child = spawn(
    process.execPath,
    [__filename, "server", portText, marker],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  const timer = setInterval(() => {
    if (fs.existsSync(marker)) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 50);
} else if (mode === "idle") {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((_request, response) => {
    response.writeHead(mode === "unready" ? 503 : 200);
    response.end("fixture");
  });
  server.listen(port, "127.0.0.1", () => {
    if (marker) fs.writeFileSync(marker, String(process.pid));
    process.stdout.write("fixture-ready\n");
    const secret = process.env.TEST_SECRET;
    if (secret) {
      const middle = Math.floor(secret.length / 2);
      process.stdout.write(secret.slice(0, middle));
      setTimeout(() => {
        process.stdout.write(
          secret.slice(middle) + "\n" + "ordinary-output-".repeat(4),
        );
      }, 100);
    }
  });
}
