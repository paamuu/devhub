const { spawn } = require("node:child_process");
const [host, launcher, server, port] = process.argv.slice(2);
spawn(host, [process.execPath, launcher], {
  windowsHide: true,
  stdio: ["pipe", "ignore", "ignore"],
  env: {
    ...process.env,
    DEVHUB_LAUNCH_SPEC: JSON.stringify({
      command: process.execPath,
      args: [server, "server", port],
      cwd: process.cwd(),
    }),
  },
});
setInterval(() => {}, 1000);
