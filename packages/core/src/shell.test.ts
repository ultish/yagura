import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { commandFromArgv } from "./shell.js";

const run = (command: string) => execFileSync("sh", ["-c", command], { encoding: "utf8" });

describe("commandFromArgv", () => {
  it("uses a single word as the command it is", () => {
    expect(commandFromArgv(["cargo test --workspace 2>&1 | tail -3"])).toBe("cargo test --workspace 2>&1 | tail -3");
    expect(run(commandFromArgv(['printf %s "$HOME" | wc -c'])).trim()).toBe(String(process.env.HOME!.length));
  });

  it("leaves plain words alone", () => {
    expect(commandFromArgv(["python3", "-m", "unittest", "test_orders.py"])).toBe("python3 -m unittest test_orders.py");
  });

  it("keeps a quoted script whole, so bash -c runs the script and not its first word", () => {
    const argv = ["bash", "-c", 'PORT=8000; echo "a b" "$PORT"; echo "it\'s fine"'];
    expect(run(commandFromArgv(argv))).toBe(execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8" }));
    expect(run(commandFromArgv(argv))).toBe("a b 8000\nit's fine\n");
  });

  it("keeps awk programs and arguments with spaces or dollar signs intact", () => {
    const argv = ["awk", "-F:", '{ print $1 " has " NF }', "/dev/stdin"];
    const out = execFileSync("sh", ["-c", `printf 'x:y:z\\n' | ${commandFromArgv(argv)}`], { encoding: "utf8" });
    expect(out).toBe("x has 3\n");
  });
});
