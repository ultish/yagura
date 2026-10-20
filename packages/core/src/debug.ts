type Sink = (line: string) => void;

// `yagura daemon --debug` points this at the daemon's log; with no sink every call is free, and a lazy line is never built.
let sink: Sink | null = null;

export function setDebug(next: Sink | null): void {
  sink = next;
}

export const debugOn = (): boolean => sink !== null;

export function debug(line: string | (() => string)): void {
  if (sink) sink(`· ${typeof line === "string" ? line : line()}`);
}

const clip = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const shellLine = (bin: string, args: string[]): string => clip(`${bin} ${args.join(" ")}`.replace(/\s+/g, " "));

export const SLOW_MS = 150;

// A quiet call is only worth a line when it fails or runs slowly: read-only git calls come by the hundred.
export async function timed<T>(label: () => string, work: () => Promise<T>, opts: { quiet?: boolean } = {}): Promise<T> {
  if (!sink) return work();
  const start = Date.now();
  try {
    const result = await work();
    const ms = Date.now() - start;
    if (!opts.quiet || ms >= SLOW_MS) debug(() => `${label()} (${ms} ms)`);
    return result;
  } catch (e) {
    debug(() => `${label()} failed (${Date.now() - start} ms): ${clip((e instanceof Error ? e.message : String(e)).split("\n")[0]!)}`);
    throw e;
  }
}
