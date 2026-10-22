import { useState } from "react";
import { api, useApi, useNow, type AgentRow, type WatchmanTurnRow } from "../api";
import { roleOf } from "../lib/units";
import { RoleLabel } from "../ui/RoleIcon";
import { duration, modelName, tokens, usd, when } from "../lib/format";
import { Link } from "../ui/Link";
import { RunningDot } from "../ui/Running";
import { Inline } from "../lib/markdown";
import { useAction } from "../ui/rows";
import { ClampCell, StatusCell, Table, TableRow, type Col, type Tone } from "../ui/Table";

const COLS: Col[] = [
  { label: "Who", width: 250 },
  { label: "What it was for" },
  { label: "Result", width: 230 },
  { label: "Model", width: 110 },
  { label: "Cost", width: 76, num: true },
  { label: "Context", width: 84, num: true },
  { label: "When", width: 170, num: true },
];

export function Agents() {
  const now = useNow(1000);
  const [limit, setLimit] = useState(50);
  const { data, error, reload } = useApi<{ attempts: AgentRow[]; watchman: WatchmanTurnRow[]; caps: { maxParallelAgents: number; running: number } }>(
    `/api/agents?recent=${limit}`,
  );
  const stop = useAction();
  const all = data?.attempts ?? [];
  const running = all.filter((a) => a.state === "running");
  const turns = data?.watchman ?? [];
  const turnRow = (t: WatchmanTurnRow, withStop = false) => {
    const took = duration((t.endedAt ? Date.parse(t.endedAt) : now) - Date.parse(t.startedAt));
    const result =
      t.state === "running"
        ? `Answering for ${took}`
        : t.state === "done"
          ? `Answered in ${took}`
          : t.state === "stopped"
            ? "Stopped by an operator"
            : `No reply after ${took}`;
    const tone: Tone = t.state === "running" ? "lamp" : t.state === "failed" ? "bell" : t.state === "done" ? "pine" : "muted";
    return (
      <TableRow key={`w${t.id}`} to={`/talk/${t.threadId}`}>
        <td className="tbl-name">
          <Link to={`/talk/${t.threadId}`} onClick={(e) => e.stopPropagation()}>
            thread {t.threadId}
          </Link>
        </td>
        <ClampCell title={t.threadTitle}>{t.threadTitle}</ClampCell>
        <StatusCell tone={tone}>{result}</StatusCell>
        <td className="tbl-dim">{modelName(t.model)}</td>
        <td className="tbl-num">{usd(t.costUsd)}</td>
        <td className="tbl-num">{t.contextPeak > 0 ? tokens(t.contextPeak) : "–"}</td>
        <td className="tbl-num">{when(t.startedAt, t.endedAt, false)}</td>
        {withStop && (
          <td className="tbl-num">
            {t.state === "running" && (
              <button
                className="btn sm"
                type="button"
                disabled={stop.busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void stop.run(async () => (await api(`/api/watchman-turns/${t.id}/stop`, { body: {} }), reload()));
                }}
              >
                Stop
              </button>
            )}
          </td>
        )}
      </TableRow>
    );
  };
  const [project, setProject] = useState("");
  const [role, setRole] = useState("");
  const [outcome, setOutcome] = useState("");
  const outcomeOf = (a: AgentRow) => (a.state === "handed_off" ? "handed off" : a.state);
  const shown = (a: AgentRow) =>
    (!project || a.unit.projectId === project) && (!role || roleOf(a.unit.type, a.harness, a.n, a.role) === role) && (!outcome || outcomeOf(a) === outcome);
  const projects = [...new Set(all.map((a) => a.unit.projectId))].sort();
  const roles = [...new Set(all.map((a) => roleOf(a.unit.type, a.harness, a.n, a.role)))].sort();
  const outcomes = [...new Set(all.map(outcomeOf))].sort();
  const past = all.filter((a) => a.state !== "running" && shown(a));
  const row = (a: AgentRow) => {
    const took = a.startedAt ? duration((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt)) : "";
    const outcome =
      a.state === "running"
        ? `Running for ${took}`
        : a.state === "handed_off"
          ? `Handed off${a.handoffStatus ? `: ${a.handoffStatus}` : ""} in ${took}`
          : a.state === "failed"
            ? `Failed${a.failureMode ? ` (${a.failureMode})` : ""} after ${took}`
            : a.state === "stopped"
              ? "Stopped by an operator"
              : "Queued";
    const tone: Tone = a.state === "running" ? "lamp" : a.state === "failed" || a.missingSkills.length ? "bell" : a.handoffStatus === "done" ? "pine" : "muted";
    return (
      <TableRow key={a.id} to={`/a/${a.id}`}>
        <td className="tbl-name wrap">
          <Link to={`/a/${a.id}`} onClick={(e) => e.stopPropagation()}>
            {a.unit.projectId} · <RoleLabel role={roleOf(a.unit.type, a.harness, a.n, a.role)} /> A{a.agentNo}
          </Link>
        </td>
        <ClampCell title={a.unit.title}>
          {a.unit.type !== "plan" && <span className="tbl-ref">U{a.unit.seq}</span>}
          <Inline text={a.unit.title} />
        </ClampCell>
        <StatusCell tone={tone}>
          {a.state === "running" && <RunningDot />}
          {outcome}
          {a.missingSkills.length ? `; skipped ${a.missingSkills.join(", ")}` : ""}
        </StatusCell>
        <td className="tbl-dim">{modelName(a.model)}</td>
        <td className="tbl-num">{usd(a.costUsd)}</td>
        <td className="tbl-num">{a.contextPeak > 0 ? tokens(a.contextPeak) : "–"}</td>
        <td className="tbl-num">{when(a.startedAt, a.endedAt, false)}</td>
      </TableRow>
    );
  };
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Agents
      </h1>
      {error && <div className="s-bell">{error}</div>}
      <div className="agents-filters">
        {(
          [
            ["agents-project", "Project", project, setProject, projects],
            ["agents-role", "Role", role, setRole, roles],
            ["agents-outcome", "Outcome", outcome, setOutcome, outcomes],
          ] as const
        ).map(([id, label, value, set, options]) => (
          <label key={id} htmlFor={id}>
            {label}
            <select id={id} value={value} onChange={(e) => set(e.target.value)}>
              <option value="">all</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        ))}
        {(project || role || outcome) && (
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              setProject("");
              setRole("");
              setOutcome("");
            }}
          >
            Clear
          </button>
        )}
      </div>
      <section>
        <div className="gh">
          <h2 className="h2">Lanterns lit</h2>
          <span className="n">{data ? `${data.caps.running} of ${data.caps.maxParallelAgents} agent slots` : ""}</span>
        </div>
        {running.length || turns.some((t) => t.state === "running") ? (
          <Table cols={[...COLS, { label: "", width: 80 }]}>
            {turns.filter((t) => t.state === "running").map((t) => turnRow(t, true))}
            {running.filter(shown).map(row)}
          </Table>
        ) : (
          <div className="empty">No agents at work.</div>
        )}
      </section>
      <section>
        <div className="gh">
          <h2 className="h2">Recent</h2>
          <span className="n">{past.length}</span>
        </div>
        <Table cols={COLS}>{past.map(row)}</Table>
        {past.length >= limit - running.length && (
          <button className="btn sm" type="button" onClick={() => setLimit((l) => l + 100)} style={{ marginTop: 12 }}>
            Show more
          </button>
        )}
      </section>
      {turns.some((t) => t.state !== "running") && (
        <section>
          <div className="gh">
            <h2 className="h2">Watchman turns</h2>
            <span className="n">{turns.filter((t) => t.state !== "running").length}</span>
          </div>
          <Table cols={COLS}>{turns.filter((t) => t.state !== "running").map((t) => turnRow(t))}</Table>
        </section>
      )}
    </main>
  );
}
