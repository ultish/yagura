import type { HarnessEvent } from "../domain.js";

export interface HarnessRun {
  prompt: string;
  bin: string | null;
  model: string | null;
  permissionMode: string;
  pluginDirs: string[];
  addDirs: string[];
  extraArgs: string[];
  resume?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface HarnessAdapter {
  id: string;
  canResume: boolean;
  command(run: HarnessRun): { argv: string[]; stdin: string };
  // Present when the harness keeps reading stdin: encodes a message the developer sends mid-run. The session must close stdin itself.
  message?(text: string): string;
  parse(line: string): HarnessEvent[];
}
