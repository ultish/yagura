export interface Started {
  projects: string[];
  environments: string[];
  repos: string[];
  units: { project: string; seq: number }[];
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// What an applied proposal made, from the result yagura recorded when it applied it.
export function startedBy(result: unknown): Started {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const units = r.units && typeof r.units === "object" ? Object.entries(r.units as Record<string, unknown>) : [];
  return {
    projects: list(r.projects),
    environments: list(r.environments),
    repos: list(r.repos),
    units: units.flatMap(([project, labels]) =>
      list(labels).flatMap((l) => {
        const n = /^U(\d+)$/.exec(l);
        return n ? [{ project, seq: Number(n[1]) }] : [];
      }),
    ),
  };
}

export const hasStarted = (s: Started): boolean => s.projects.length + s.environments.length + s.repos.length + s.units.length > 0;
