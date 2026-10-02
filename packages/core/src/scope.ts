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

export interface ScopeAssessment {
  // yagura's own walls (the verify pack): never allowed.
  hard: ScopeViolation[];
  // outside the planner's estimate, and said so in the handoff's "Outside scope" section.
  justified: ScopeViolation[];
  // outside the planner's estimate with no reason given.
  unjustified: ScopeViolation[];
}

const mentions = (text: string, path: string) => {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return text.includes(path) || (dir !== "" && text.includes(dir));
};

// The planner's write scope and forbid list are an estimate made before the work exists. A worker may go past them if
// it says why; the verifier and reviewer judge the reasons. Only yagura's own paths (the verify pack) are a wall.
export function assessScope(paths: string[], write: string[], estimateForbid: string[], hardForbid: string[], outsideScope: string): ScopeAssessment {
  const wall = hardForbid.length ? picomatch(hardForbid, { dot: true }) : () => false;
  const hard = paths.filter((p) => wall(p)).map((path): ScopeViolation => ({ path, reason: "forbidden" }));
  const rest = checkScope(
    paths.filter((p) => !wall(p)),
    write,
    estimateForbid,
  );
  return {
    hard,
    justified: rest.filter((v) => mentions(outsideScope, v.path)),
    unjustified: rest.filter((v) => !mentions(outsideScope, v.path)),
  };
}
