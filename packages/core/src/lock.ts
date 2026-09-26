import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bootstrap } from "./config.js";

const lockPath = (boot: Bootstrap) => join(boot.home, "daemon.pid");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonPid(boot: Bootstrap): number | null {
  if (!existsSync(lockPath(boot))) return null;
  const pid = Number(readFileSync(lockPath(boot), "utf8").trim());
  return pid && alive(pid) ? pid : null;
}

export function acquireDaemonLock(boot: Bootstrap): () => void {
  const running = daemonPid(boot);
  if (running && running !== process.pid) throw new Error(`a yagura daemon is already running (pid ${running})`);
  writeFileSync(lockPath(boot), String(process.pid));
  return () => {
    if (daemonPid(boot) === process.pid) rmSync(lockPath(boot), { force: true });
  };
}
