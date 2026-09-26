import picomatch from "picomatch";

export interface ScopeViolation {
  path: string;
  reason: "outside-write-scope" | "forbidden";
}

export function checkScope(paths: string[], write: string[], forbid: string[]): ScopeViolation[] {
  const allowed = picomatch(write, { dot: true });
  const denied = forbid.length ? picomatch(forbid, { dot: true }) : () => false;
  return paths.flatMap((path): ScopeViolation[] => {
    if (denied(path)) return [{ path, reason: "forbidden" }];
    if (!allowed(path)) return [{ path, reason: "outside-write-scope" }];
    return [];
  });
}
