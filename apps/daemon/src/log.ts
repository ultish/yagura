import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_DAEMON_LOG_BYTES = 5_000_000;

// The engine's log lines go to the console and, with the date, to a file under the yagura home, so everything yagura writes is in one place.
// A file already past the cap is moved to <file>.1 when the daemon starts, so it cannot grow without bound.
export function daemonLog(file: string, now: () => Date = () => new Date()): (line: string) => void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && statSync(file).size > MAX_DAEMON_LOG_BYTES) renameSync(file, `${file}.1`);
  return (line) => {
    const stamp = now().toISOString();
    console.log(`${stamp.slice(11, 19)} ${line}`);
    appendFileSync(file, `${stamp.slice(0, 10)} ${stamp.slice(11, 19)}Z ${line}\n`);
  };
}
