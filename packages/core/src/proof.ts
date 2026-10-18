import type { AttemptId, Unit } from "./domain.js";
import { listAttempts, type Db } from "./store.js";

export interface ProofRun {
  id: number;
  attemptNo: number;
  agentNo: number;
  role: "worker" | "judge";
  at: "base" | "head";
  exit: number | null;
  timedOut: boolean;
}

// Why a named page does or does not stand behind the unit, from the judge's own recorded runs of it.
//   pending: no judge has looked yet · missing: the judge ran nothing for it · failed: its runs do not show it holds · held: they do
export type ProofStatus = "pending" | "missing" | "failed" | "held";

export interface ProofRow {
  page: string;
  isNew: boolean;
  lines: number;
  status: ProofStatus;
  // For a new page: it failed on the base and passes on the head.
  failsOnBase: boolean;
  runs: ProofRun[];
}

export function proofRows(db: Db, unit: Unit): ProofRow[] {
  const named = new Map<string, { isNew: boolean; lines: number }>();
  unit.proof.forEach((p) => {
    for (const page of p?.pages ?? []) {
      const row = named.get(page) ?? { isNew: false, lines: 0 };
      named.set(page, { isNew: row.isNew || p!.isNew, lines: row.lines + 1 });
    }
  });
  if (!named.size) return [];

  const attempts = listAttempts(db, unit.id).filter((a) => a.role === "worker" || a.role === "judge");
  const latestJudge = attempts.filter((a) => a.role === "judge").at(-1);
  const runs = db
    .prepare(
      `SELECT r.id, r.attempt_id, r.page, r.at, r.exit_code, r.timed_out, r.tampered FROM evidence_runs r
       WHERE r.page IS NOT NULL AND r.attempt_id IN (${attempts.map(() => "?").join(",") || "NULL"}) ORDER BY r.id`,
    )
    .all(...attempts.map((a) => a.id)) as {
    id: number;
    attempt_id: number;
    page: string;
    at: "base" | "head";
    exit_code: number | null;
    timed_out: number;
    tampered: number;
  }[];

  return [...named].map(([page, info]) => {
    const mine = runs.filter((r) => r.page === page);
    const judged = latestJudge ? mine.filter((r) => r.attempt_id === latestJudge.id) : [];
    const headOk = judged.some((r) => r.at === "head" && r.exit_code === 0 && !r.timed_out && !r.tampered);
    const failsOnBase = judged.some((r) => r.at === "base" && r.exit_code !== null && r.exit_code !== 0 && !r.timed_out);
    const status: ProofStatus = !latestJudge ? "pending" : !judged.length ? "missing" : headOk && (!info.isNew || failsOnBase) ? "held" : "failed";
    return {
      page,
      isNew: info.isNew,
      lines: info.lines,
      status,
      failsOnBase,
      runs: mine.map((r) => {
        const a = attempts.find((x) => x.id === r.attempt_id)!;
        return { id: r.id, attemptNo: a.n, agentNo: a.agentNo, role: a.role as "worker" | "judge", at: r.at, exit: r.exit_code, timedOut: r.timed_out === 1 };
      }),
    };
  });
}

// What stops an approval: a named page the judge has not shown, with the command that would show it.
export function approvalProblem(db: Db, unit: Unit, judgeAttemptId: AttemptId): string | null {
  const rows = proofRows(db, unit);
  if (!rows.length) return null;
  const mine = db
    .prepare("SELECT page, at, exit_code, timed_out, tampered FROM evidence_runs WHERE attempt_id = ? AND page IS NOT NULL")
    .all(judgeAttemptId) as {
    page: string;
    at: string;
    exit_code: number | null;
    timed_out: number;
    tampered: number;
  }[];
  const problems: string[] = [];
  for (const row of rows) {
    const runs = mine.filter((r) => r.page === row.page);
    if (!runs.length) {
      problems.push(`page ${row.page} has no run of yours: drive it with \`yagura evidence run --page ${row.page} -- <its command>\``);
      continue;
    }
    if (!runs.some((r) => r.at === "head" && r.exit_code === 0 && !r.timed_out && !r.tampered))
      problems.push(`none of your runs of page ${row.page} on the head passed: fix the run, or record \`changes\` if the page or the code is wrong`);
    if (row.isNew && !runs.some((r) => r.at === "base" && r.exit_code !== null && r.exit_code !== 0 && !r.timed_out))
      problems.push(`page ${row.page} is new, so it must fail on the base: run it again with \`--at base\``);
  }
  return problems.length ? `an approval needs each page the unit names, driven by you: ${problems.join("; ")}` : null;
}
