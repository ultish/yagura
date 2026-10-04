import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { daemonLog, MAX_DAEMON_LOG_BYTES } from "./log.js";

const fixed = () => new Date("2026-10-04T06:52:12.848Z");

describe("daemonLog", () => {
  it("prints the time and appends the date and time to a file under the home", () => {
    const file = join(mkdtempSync(join(tmpdir(), "yagura-log-")), "logs", "daemon.log");
    const print = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = daemonLog(file, fixed);
    log("\u25b6 work U2");
    log("  gate: land U1?");
    expect(print.mock.calls).toEqual([["06:52:12 \u25b6 work U2"], ["06:52:12   gate: land U1?"]]);
    expect(readFileSync(file, "utf8")).toBe("2026-10-04 06:52:12Z \u25b6 work U2\n2026-10-04 06:52:12Z   gate: land U1?\n");
    print.mockRestore();
  });

  it("moves a file past the cap aside when the daemon starts, and keeps a small one", () => {
    const dir = mkdtempSync(join(tmpdir(), "yagura-log-"));
    const file = join(dir, "daemon.log");
    const print = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeFileSync(file, "x".repeat(MAX_DAEMON_LOG_BYTES + 1));
    daemonLog(file, fixed)("fresh");
    expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(MAX_DAEMON_LOG_BYTES + 1);
    expect(readFileSync(file, "utf8")).toBe("2026-10-04 06:52:12Z fresh\n");
    daemonLog(file, fixed)("again");
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("2026-10-04 06:52:12Z fresh\n2026-10-04 06:52:12Z again\n");
    print.mockRestore();
  });
});
