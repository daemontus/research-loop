/**
 * Docker helpers for launching the two long-lived agent containers.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function imageExists(image) {
  const proc = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  return proc.status === 0;
}

/**
 * Launch a long-lived agent container. The job JSON is piped on stdin; the
 * process then stays alive for the whole session.
 *
 * @returns {import("node:child_process").ChildProcess}
 */
export function runContainer({
  image,
  name,
  job,
  env = {},
  mounts = [],
  logFile = null,
  platform = null,
  cpu = null,
  memory = null,
}) {
  const args = ["run", "--rm", "-i", "--name", name, "--add-host=host.docker.internal:host-gateway"];
  if (platform) args.push("--platform", platform);
  if (cpu) args.push("--cpus", String(cpu));
  if (memory) args.push("--memory", memory);
  for (const m of mounts) {
    args.push("-v", `${m.source}:${m.target}${m.ro ? ":ro" : ""}`);
  }
  const mergedEnv = { ...env };
  if (typeof process.getuid === "function" && mergedEnv.HOST_UID === undefined) {
    mergedEnv.HOST_UID = String(process.getuid());
    mergedEnv.HOST_GID = String(process.getgid());
  }
  for (const [k, v] of Object.entries(mergedEnv)) {
    if (v === undefined || v === null) continue;
    args.push("-e", `${k}=${v}`);
  }
  args.push(image);

  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  } catch {
    // If the container exits immediately the pipe may be closed; the caller's
    // error/close handler will take care of aborting the run.
  }

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on("close", () => stream.end());
  }
  return child;
}

export function stopContainer(name) {
  spawnSync("docker", ["stop", "-t", "5", name], { stdio: "ignore" });
}

export function removeContainer(name) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}
