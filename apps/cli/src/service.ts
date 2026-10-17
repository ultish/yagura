import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonPid, type Bootstrap } from "@yagura/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logPath = (boot: Bootstrap) => join(boot.home, "daemon.log");
const urlOf = (boot: Bootstrap) => `http://${boot.bind === "0.0.0.0" || boot.bind === "::" ? "127.0.0.1" : boot.bind}:${boot.port}`;

async function answering(boot: Bootstrap): Promise<boolean> {
  try {
    await fetch(urlOf(boot), { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

function tail(path: string, lines: number): string {
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "";
}

export async function startInBackground(boot: Bootstrap, cli: string[]): Promise<number> {
  const running = daemonPid(boot);
  if (running) {
    console.log(`already running (pid ${running}) at ${urlOf(boot)}`);
    return 0;
  }
  mkdirSync(boot.home, { recursive: true });
  const out = openSync(logPath(boot), "a");
  const child = spawn(cli[0]!, [...cli.slice(1), "daemon"], { detached: true, stdio: ["ignore", out, out], env: process.env });
  closeSync(out);
  child.unref();
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (exited) break;
    if (await answering(boot)) {
      console.log(`started (pid ${child.pid}) at ${urlOf(boot)}\nlog: ${logPath(boot)}`);
      return 0;
    }
  }
  console.error(`the daemon did not come up${exited ? " (it exited)" : " within 10 seconds"}. Last of ${logPath(boot)}:\n${tail(logPath(boot), 8)}`);
  return 1;
}

export async function stopDaemon(boot: Bootstrap): Promise<number> {
  const pid = daemonPid(boot);
  if (!pid) {
    console.log("not running");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (!daemonPid(boot)) {
      console.log(`stopped (pid ${pid})`);
      return 0;
    }
  }
  console.error(`pid ${pid} is still shutting down after 10 seconds. Look at ${logPath(boot)}, or force it with: kill -9 ${pid}`);
  return 1;
}

export async function daemonStatus(boot: Bootstrap): Promise<number> {
  const pid = daemonPid(boot);
  if (!pid) {
    console.log(`not running. Start it with: yagura start\nhome: ${boot.home}`);
    return 1;
  }
  console.log(`running (pid ${pid}) at ${urlOf(boot)}${(await answering(boot)) ? "" : " (not answering yet)"}\nhome: ${boot.home}\nlog: ${logPath(boot)}`);
  return 0;
}
