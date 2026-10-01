import { useEffect, useMemo, useState } from "react";
import { api, streamUrl, useApi, useNow, type Attempt, type AttemptDetail, type EvidenceRun, type LogLine, type ProjectDetail } from "../api";
import { slotLine } from "./environment-values";
import { roleOf } from "../lib/units";
import { clock, duration, modelName, tokens } from "../lib/format";
import { Inline, Markdown } from "../lib/markdown";
import { buildTimeline, type Step } from "../lib/timeline";
import { Link } from "../ui/Link";
import { DiffView, RunView } from "../ui/evidence";
import { NoteForm, useAction } from "../ui/rows";

function useLog(attemptId: number, live: boolean): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    setLines([]);
    let source: EventSource | null = null;
    let cancelled = false;
    api<{ lines: LogLine[]; next: number }>(`/api/attempts/${attemptId}/log`).then((r) => {
      if (cancelled) return;
      setLines(r.lines);
      if (!live) return;
      source = new EventSource(streamUrl(`/api/attempts/${attemptId}/stream?from=${r.next}`));
      source.addEventListener("line", (e) => setLines((ls) => [...ls, JSON.parse((e as MessageEvent<string>).data) as LogLine]));
      source.addEventListener("end", () => source?.close());
    });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [attemptId, live]);
  return lines;
}

const rel = (at: number | null, start: number | null) => {
  if (!at || !start) return "";
  const s = Math.max(0, Math.round((at - start) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function StepRow({ step, start, live }: { step: Step; start: number | null; live: boolean }) {
  const time = (
    <span className="mono muted" style={{ fontSize: 11.5, width: 52, flexShrink: 0, paddingTop: 3 }}>
      {rel(step.at, start)}
    </span>
  );
  const wrap = (inner: React.ReactNode) => (
    <div style={{ display: "flex", gap: 14, padding: "9px 0", borderTop: "1px solid var(--line)" }}>
      {time}
      <div style={{ flexGrow: 1, minWidth: 0 }}>{inner}</div>
    </div>
  );
  switch (step.kind) {
    case "skill":
      return wrap(
        <span className={`run ${step.ok ? "ok" : "bad"}`}>
          skill {step.ok ? "✓" : "✕"} {step.skill}
        </span>,
      );
    case "text":
      return wrap(<Markdown text={step.text} />);
    case "final":
      return wrap(
        <details
          open
          style={{
            border: `1px solid ${step.isError ? "var(--bad-border)" : "var(--ok-border)"}`,
            borderRadius: 6,
            padding: "10px 14px",
            background: "var(--bg)",
          }}
        >
          <summary style={{ cursor: "pointer" }} className="mono">
            <span className={step.isError ? "s-bell" : "s-pine"}>{step.isError ? "ended with an error" : "handoff"}</span>
          </summary>
          <div style={{ marginTop: 8 }}>
            <Markdown text={step.text} />
          </div>
        </details>,
      );
    case "tool": {
      const running = live && step.output === null;
      return wrap(
        <details>
          <summary className="mono" style={{ cursor: "pointer", fontSize: 13, display: "flex", gap: 10, alignItems: "center", listStyle: "none" }}>
            {running && (
              <span
                className="flame"
                style={{ width: 9, height: 13, borderRadius: "5px 5px 3px 3px", background: "var(--lamp)", display: "inline-block", flexShrink: 0 }}
              />
            )}
            <span style={{ color: step.isError ? "var(--bell-text)" : "var(--info)" }}>{step.name}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{step.summary}</span>
            {step.children.length > 0 && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                {step.children.length} steps
              </span>
            )}
            {step.isError && (
              <span className="s-bell" style={{ fontSize: 11.5 }}>
                error
              </span>
            )}
          </summary>
          {step.diff && (
            <div
              className="mono"
              style={{
                fontSize: 12,
                marginTop: 6,
                borderLeft: "2px solid var(--btnline)",
                padding: "4px 10px",
                background: "var(--bg)",
                whiteSpace: "pre-wrap",
                overflowX: "auto",
              }}
            >
              {step.diff.old
                .split("\n")
                .slice(0, 12)
                .map((l, i) => (
                  <div key={`o${i}`} className="s-bell">
                    - {l}
                  </div>
                ))}
              {step.diff.new
                .split("\n")
                .slice(0, 12)
                .map((l, i) => (
                  <div key={`n${i}`} className="s-pine">
                    + {l}
                  </div>
                ))}
            </div>
          )}
          {step.children.length > 0 && (
            <div style={{ marginLeft: 12, borderLeft: "1px solid var(--line2)", paddingLeft: 12 }}>
              {step.children.map((c) => (
                <StepRow key={c.id} step={c} start={start} live={live} />
              ))}
            </div>
          )}
          {step.output !== null && (
            <pre
              className="mono"
              style={{
                fontSize: 12,
                margin: "6px 0 0",
                padding: "8px 10px",
                background: "var(--bg)",
                border: "1px solid var(--line2)",
                borderRadius: 4,
                maxHeight: 320,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {step.output.length > 6000 ? `${step.output.slice(0, 6000)}\n… (${step.output.length - 6000} more characters)` : step.output || "(no output)"}
            </pre>
          )}
        </details>,
      );
    }
  }
}

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const pct = Math.min(100, (value / Math.max(max, 1)) * 100);
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span className="muted">{label}</span>
        <span>{text}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        style={{ height: 6, background: "var(--line2)", borderRadius: 3, marginTop: 6 }}
      >
        <div style={{ width: `${pct}%`, height: 6, background: pct > 85 ? "var(--bell)" : "var(--lamp)", borderRadius: 3 }} />
      </div>
    </div>
  );
}

function EvidenceGrid({ runs, selected, onPick }: { runs: EvidenceRun[]; selected: number | null; onPick: (runId: number) => void }) {
  const labels = [...new Set(runs.map((r) => r.label))];
  if (!labels.length)
    return (
      <div className="muted" style={{ fontSize: 12.5 }}>
        No evidence captured yet.
      </div>
    );
  const cell = (label: string, at: "base" | "head") => {
    const r = runs.filter((x) => x.label === label && x.at === at).at(-1);
    if (!r) return <span className="run wait">—</span>;
    const ok = r.exitCode === 0 && !r.timedOut && !r.tampered;
    return (
      <button
        type="button"
        className={`run ${ok ? "ok" : "bad"}`}
        title={r.command}
        aria-label={`r${r.id} ${label} on ${at === "base" ? "trunk" : "head"}: ${r.tampered ? "tampered" : r.timedOut ? "timed out" : ok ? "passed" : `exit ${r.exitCode}`}. Show evidence`}
        aria-pressed={selected === r.id}
        onClick={() => onPick(r.id)}
        style={{ cursor: "pointer", background: selected === r.id ? "var(--panel)" : "transparent" }}
      >
        r{r.id} {r.tampered ? "tampered" : r.timedOut ? "timed out" : ok ? "✓" : `exit ${r.exitCode}`}
      </button>
    );
  };
  const shaOf = (at: "base" | "head") => runs.find((r) => r.at === at)?.sha.slice(0, 7) ?? "";
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "JetBrains Mono, monospace", fontSize: 12.5 }}>
      <thead>
        <tr>
          {["check / scenario", `trunk ${shaOf("base")}`, `head ${shaOf("head")}`].map((h) => (
            <th key={h} scope="col" style={{ textAlign: "left", color: "var(--muted)", fontWeight: 400, padding: "4px 0" }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((l) => (
          <tr key={l} style={{ borderTop: "1px solid var(--line2)" }}>
            <td style={{ padding: "7px 8px 7px 0", wordBreak: "break-all" }}>{l}</td>
            <td>{cell(l, "base")}</td>
            <td>{cell(l, "head")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function statusOf(d: AttemptDetail, now: number, lastActivity: string | null): { text: string; tone: string } {
  const a = d.attempt;
  const lower = roleOf(d.unit.type, d.attempt.harness);
  const role = lower[0]!.toUpperCase() + lower.slice(1);
  const took = a.startedAt && a.endedAt ? duration(Date.parse(a.endedAt) - Date.parse(a.startedAt)) : "";
  switch (a.state) {
    case "running":
      return {
        text: `${role} running for ${a.startedAt ? duration(now - Date.parse(a.startedAt)) : "a moment"}.${lastActivity ? ` Now: ${lastActivity}` : ""}`,
        tone: "lamp",
      };
    case "queued":
      return { text: `Queued${d.waiting ? `: ${d.waiting}` : ""}.`, tone: "muted" };
    case "handed_off":
      return {
        text: `Handed off${a.handoffStatus ? `: ${a.handoffStatus}` : ""} after ${took}.${a.missingSkills.length ? ` Skipped ${a.missingSkills.join(", ")}, so yagura rejected it.` : a.rejection ? ` Sent back: ${REJECTION_LABEL[a.rejection]}.` : ""}`,
        tone: a.missingSkills.length || a.rejection ? "bell" : a.handoffStatus === "success" ? "pine" : "info",
      };
    case "failed":
      if (a.resumesAttemptId && !a.sessionId)
        return { text: "Could not resume the earlier session, so yagura started a fresh try. This one did not count as a try.", tone: "muted" };
      return { text: `Failed${a.failureMode ? ` (${a.failureMode})` : ""} after ${took}.`, tone: "bell" };
    case "stopped":
      return { text: `Stopped by an operator${a.stopNote ? `: ${a.stopNote}` : ""}.`, tone: "muted" };
  }
}

const REJECTION_LABEL: Record<NonNullable<Attempt["rejection"]>, string> = {
  "code-fault": "verification failed",
  literals: "hard-coded values",
  scope: "out of scope",
  skills: "skipped skills",
  conflict: "trunk conflict",
};

export function Agent({ attemptId }: { attemptId: number }) {
  const now = useNow(1000);
  const { data: d, error } = useApi<AttemptDetail>(`/api/attempts/${attemptId}`);
  const live = d?.attempt.state === "running" || d?.attempt.state === "queued";
  const lines = useLog(attemptId, !!live);
  const timeline = useMemo(() => buildTimeline(lines), [lines]);
  const [stopping, setStopping] = useState(false);
  const [view, setView] = useState<"log" | "diff" | "run">("log");
  const [picked, setPicked] = useState<number | null>(null);
  const action = useAction();
  if (error)
    return (
      <main style={{ padding: 36 }} className="s-bell">
        {error}
      </main>
    );
  if (!d)
    return (
      <main style={{ padding: 36 }} className="muted">
        Loading…
      </main>
    );
  const a = d.attempt;
  const u = d.unit;
  const role = roleOf(u.type, d.attempt.harness);
  const byYagura =
    a.harness === "yagura-proof"
      ? "yagura ran this proof itself, with no agent: the pack's doctor, deploy, checks, and teardown on the pack's own head. Its runs are in the grid."
      : a.harness === "yagura-rebase"
        ? "yagura rebased the verified head onto the moved trunk; the patch changed, so this head is verified again. No agent ran."
        : null;
  const status = statusOf(d, now, timeline.lastActivity);
  const start = a.startedAt ? Date.parse(a.startedAt) : timeline.startedAt;
  const elapsed = a.startedAt ? (a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt) : 0;
  const ctxPeak = Math.max(a.contextPeak, timeline.contextPeak);
  const window = /1m|\[1m\]/.test(a.model ?? "") ? 1_000_000 : 200_000;
  const verifierRuns = u.type === "verify" ? d.runs : (d.verifications.at(-1)?.attempts.at(-1)?.runs ?? []);
  const lastVerification = d.verifications.at(-1);
  const tabs: { key: "log" | "diff" | "run"; label: string }[] = [
    { key: "log", label: "Log" },
    ...(u.type !== "plan" ? [{ key: "diff" as const, label: "Diff" }] : []),
    ...(picked !== null ? [{ key: "run" as const, label: `Evidence r${picked}` }] : []),
  ];
  const briefGoal = d.brief ? /## GOAL\n([\s\S]*?)\n##/.exec(d.brief)?.[1]?.trim() : null;
  const acceptCount = d.brief
    ? (/## ACCEPTANCE\n([\s\S]*?)\n##/
        .exec(d.brief)?.[1]
        ?.split("\n")
        .filter((l) => l.startsWith("- ")).length ?? 0)
    : 0;
  return (
    <main>
      <section style={{ padding: "22px 36px 14px", display: "flex", flexDirection: "column", gap: 8, borderBottom: "1px solid var(--line)" }}>
        <div className="mono muted" style={{ fontSize: 12.5 }}>
          <Link to={`/p/${u.projectId}`} style={{ textDecoration: "none" }}>
            {u.projectId}
          </Link>{" "}
          / <Link to={`/p/${u.projectId}/u/${u.seq}`}>U{u.seq}</Link> / {role} U{u.seq}.{a.n}
          {a.resumesAttemptId && (
            <>
              {" "}
              · resumes <Link to={`/a/${a.resumesAttemptId}`}>try {u.attempts.find((x) => x.id === a.resumesAttemptId)?.n ?? "?"}</Link>
            </>
          )}
          {d.target && (
            <>
              {" "}
              · for <Link to={`/p/${u.projectId}/u/${d.target.seq}`}>U{d.target.seq}</Link>
            </>
          )}
          {u.type !== "plan" && (
            <>
              {" "}
              · <Link to={`/p/${u.projectId}/u/${d.target?.seq ?? u.seq}?tab=code`}>the code it changed →</Link>
            </>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
          <h1 className="serif" style={{ margin: 0, fontSize: 28, fontWeight: 600, maxWidth: 900, lineHeight: 1.3 }}>
            <Inline text={u.goal} />
          </h1>
          {a.state === "running" && !stopping && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn" type="button" disabled={action.busy} onClick={() => action.run(() => api(`/api/attempts/${a.id}/stop`, { body: {} }))}>
                Stop
              </button>
              <button className="btn" type="button" onClick={() => setStopping(true)}>
                Stop with a note
              </button>
            </div>
          )}
        </div>
        {stopping && (
          <NoteForm
            label="Stop"
            placeholder="What should the next attempt do differently?"
            submit={(note) => api(`/api/attempts/${a.id}/stop`, { body: { note } })}
            onDone={() => setStopping(false)}
          />
        )}
        <div className={`s-${status.tone}`} style={{ fontSize: 14 }}>
          {status.text}
        </div>
        <div className="facts">
          <span>
            <b>{byYagura ? "run by yagura, no agent" : modelName(a.model ?? timeline.model)}</b>
            {a.pluginVersions.pstack ? ` · pstack ${a.pluginVersions.pstack}` : ""}
          </span>
          <span>
            try {a.n} of {u.maxAttempts}
          </span>
          {a.branch && <span>{a.branch}</span>}
          {u.writeScope.length > 0 && <span>write: {u.writeScope.join(", ")}</span>}
          {a.skills.length > 0 && <span>skills: {a.skills.join(", ")}</span>}
        </div>
        {action.error && <div className="s-bell">{action.error}</div>}
      </section>
      <div style={{ display: "flex", flexWrap: "wrap", background: "var(--bg2)", minHeight: "70vh" }}>
        <section aria-labelledby="log" style={{ flex: "1 1 600px", minWidth: 0, padding: "10px 36px 48px" }}>
          <div role="tablist" aria-label="What to show" style={{ display: "flex", gap: 22, alignItems: "baseline", padding: "6px 0 8px" }}>
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={t.key === "log" ? "log" : undefined}
                aria-selected={view === t.key}
                onClick={() => setView(t.key)}
                className="h2"
                style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: view === t.key ? "var(--text)" : "var(--muted)" }}
              >
                {t.label}
              </button>
            ))}
            {view === "log" && (
              <span className="mono muted" style={{ fontSize: 12 }}>
                {live ? "live · " : ""}
                {timeline.steps.length} steps
              </span>
            )}
          </div>
          {view === "log" && (
            <>
              {!timeline.steps.length && (
                <div className="empty">{live ? "Waiting for the agent's first words…" : byYagura ? byYagura : "No log was recorded."}</div>
              )}
              {timeline.steps.map((s) => (
                <StepRow key={s.id} step={s} start={start} live={!!live} />
              ))}
            </>
          )}
          {view === "diff" && <DiffView attemptId={a.id} />}
          {view === "run" && picked !== null && <RunView runId={picked} />}
        </section>
        <aside
          style={{
            flex: "0 1 400px",
            minWidth: 300,
            borderLeft: "1px solid var(--line)",
            padding: "18px 24px 48px",
            display: "flex",
            flexDirection: "column",
            gap: 22,
            background: "var(--bg)",
          }}
        >
          <div>
            <Meter label="context" value={ctxPeak} max={window} text={`${tokens(ctxPeak)} of ${tokens(window)}`} />
            <Meter label="timebox" value={elapsed} max={d.timeboxSeconds * 1000} text={`${duration(elapsed)} of ${duration(d.timeboxSeconds * 1000)}`} />
          </div>
          {d.kept.map((k) => (
            <div key={k.leaseId}>
              <h2 className="h2">Kept slot</h2>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {k.reason}. Deleted at {clock(k.until)} unless you delete it first.
              </div>
              {slotLine(k) && (
                <div className="mono" style={{ fontSize: 12, marginTop: 4, wordBreak: "break-all" }}>
                  {slotLine(k)}
                </div>
              )}
              <button
                className="btn sm"
                type="button"
                style={{ marginTop: 6 }}
                disabled={action.busy}
                onClick={() => void action.run(() => api(`/api/leases/${k.leaseId}/delete-kept`, { body: {} }))}
              >
                Delete now
              </button>
            </div>
          ))}
          <div>
            <h2 className="h2">{a.resumesAttemptId ? "Resumed" : "Brief"}</h2>
            {a.resumesAttemptId ? (
              <div style={{ fontSize: 13.5, marginTop: 6 }}>
                Same session, worktree, and branch as try {u.attempts.find((x) => x.id === a.resumesAttemptId)?.n ?? "?"}; yagura sent the rejection and its
                findings instead of a new brief.
              </div>
            ) : (
              <>
                {briefGoal && <div style={{ fontSize: 13.5, marginTop: 6 }}>{briefGoal.split("\n")[0]}</div>}
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {acceptCount ? `${acceptCount} acceptance lines · ` : ""}verify <span className="mono">{u.verify ?? "—"}</span>
                </div>
                {u.notes.length > 0 && (
                  <div style={{ fontSize: 13, marginTop: 4 }} className="s-lamp">
                    Notes: {u.notes.join(" / ")}
                  </div>
                )}
              </>
            )}
            {d.brief && (
              <details style={{ marginTop: 6 }}>
                <summary className="mono" style={{ fontSize: 12, cursor: "pointer", color: "var(--amber)" }}>
                  {a.resumesAttemptId ? "what yagura sent" : "the whole brief"}
                </summary>
                <pre
                  className="mono"
                  style={{ fontSize: 11.5, whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", background: "var(--bg2)", padding: 10, borderRadius: 4 }}
                >
                  {d.brief}
                </pre>
              </details>
            )}
          </div>
          {u.type !== "plan" && (
            <div>
              <h2 className="h2">Trunk vs head</h2>
              <div className="muted" style={{ fontSize: 12.5, margin: "4px 0 6px" }}>
                {u.type === "verify"
                  ? "runs this verifier captured"
                  : lastVerification
                    ? `captured by the verifier, U${lastVerification.unit.seq} (${lastVerification.unit.state})`
                    : "filled in by the verifier after hand-off"}
                {u.verdict ? ` · verdict ${u.verdict.tier}` : ""}
              </div>
              <EvidenceGrid
                runs={verifierRuns}
                selected={view === "run" ? picked : null}
                onPick={(id) => {
                  setPicked(id);
                  setView("run");
                }}
              />
            </div>
          )}
          <div>
            <h2 className="h2">History of U{u.seq}</h2>
            <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.9, marginTop: 6 }}>
              {u.attempts.map((x) => (
                <div key={x.id}>
                  {x.id === a.id ? (
                    <span className={x.state === "running" ? "s-lamp" : undefined}>
                      try {x.n} · {x.state} (this one)
                    </span>
                  ) : (
                    <Link to={`/a/${x.id}`}>
                      try {x.n} · {x.state}
                      {x.resumesAttemptId ? " · resumed" : ""}
                      {x.rejection
                        ? ` · rejected: ${REJECTION_LABEL[x.rejection]}`
                        : x.missingSkills.length
                          ? ` · skipped ${x.missingSkills.join(", ")}`
                          : x.failureMode
                            ? ` · ${x.failureMode}`
                            : ""}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

export function UnitAgent({ projectId, seq, n }: { projectId: string; seq: number; n: number | null }) {
  const { data, error } = useApi<ProjectDetail>(`/api/projects/${projectId}`);
  if (error)
    return (
      <main style={{ padding: 36 }} className="s-bell">
        {error}
      </main>
    );
  if (!data)
    return (
      <main style={{ padding: 36 }} className="muted">
        Loading…
      </main>
    );
  const unit = data.units.find((u) => u.seq === seq);
  const attempt = unit && (n ? unit.attempts.find((a) => a.n === n) : (unit.attempts.find((a) => a.state === "running") ?? unit.attempts.at(-1)));
  if (!unit)
    return (
      <main style={{ padding: 36 }}>
        No U{seq} in {projectId}.
      </main>
    );
  if (!attempt)
    return (
      <main style={{ padding: 36 }}>
        <h1 className="serif">
          U{seq}: <Inline text={unit.goal} />
        </h1>
        <p className="muted">No agent has run for this unit yet ({unit.state}).</p>
        <Link to={`/p/${projectId}`}>Back to {projectId}</Link>
      </main>
    );
  return <Agent key={attempt.id} attemptId={attempt.id} />;
}
