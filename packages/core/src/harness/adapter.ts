import type { HarnessEvent } from "../domain.js";

export interface HarnessRun {
  prompt: string;
  bin: string | null;
  model: string | null;
  permissionMode: string;
  pluginDirs: string[];
  extraArgs: string[];
}

export interface HarnessAdapter {
  id: string;
  command(run: HarnessRun): { argv: string[]; stdin: string };
  parse(line: string): HarnessEvent[];
}
