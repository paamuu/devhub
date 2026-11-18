import spawn from "cross-spawn";

const plan = JSON.parse(process.env.DEVHUB_LAUNCH_SPEC ?? "null") as {
  command: string;
  args: string[];
  cwd: string;
} | null;
delete process.env.DEVHUB_LAUNCH_SPEC;
delete process.env.ELECTRON_RUN_AS_NODE;
if (!plan) process.exit(64);
const child = spawn(plan.command, plan.args, {
  cwd: plan.cwd,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
child.once("error", () => {
  process.stderr.write(
    "DevHub could not find or start the configured executable.\n",
  );
  process.exit(127);
});
child.once("exit", (code) => process.exit(code ?? 1));
