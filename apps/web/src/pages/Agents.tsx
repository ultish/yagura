import { useState } from "react";
import { api, useApi, useNow, type AgentRow, type WatchmanTurnRow } from "../api";
import { roleOf } from "../lib/units";
import { clock, duration, modelName, tokens, usd } from "../lib/format";
import { Link } from "../ui/Link";
import { Inline } from "../lib/markdown";
import { Row, useAction } from "../ui/rows";

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
  const turnRow = (t: WatchmanTurnRow) => {
    const took = duration((t.endedAt ? Date.parse(t.endedAt) : now) - Date.parse(t.startedAt));
    return (
      <Row
        key={`w${t.id}`}
        seq={<Link to={`/talk/${t.threadId}`}>thread {t.threadId}</Link>}
        goal={t.threadTitle}
        status={
          t.state === "running"
            ? `Watchman answering for ${took}.`
            : t.state === "done"
              ? `Answered in ${took}.`
              : t.state === "stopped"
                ? "Stopped by an operator."
                : `Ended without a reply after ${took}.`
        }
        tone={t.state === "running" ? "lamp" : t.state === "failed" ? "bell" : t.state === "done" ? "pine" : "muted"}
        facts={
          <>
            <span>
              <b>watchman</b>
            </span>
            <span>{modelName(t.model)}</span>
            <span>{usd(t.costUsd)}</span>
            {t.contextPeak > 0 && <span>ctx {tokens(t.contextPeak)}</span>}
            <span>started {clock(t.startedAt)}</span>
          </>
        }
        actions={
          t.state === "running" ? (
            <button
              className="btn sm"
              type="button"
              disabled={stop.busy}
              onClick={() => void stop.run(async () => (await api(`/api/watchman-turns/${t.id}/stop`, { body: {} }), reload()))}
            >
              Stop
            </button>
          ) : undefined
        }
      />
    );
  };
  const [project, setProject] = useState("");
  const [role, setRole] = useState("");
  const [outcome, setOutcome] = useState("");
  const outcomeOf = (a: AgentRow) => (a.state === "handed_off" ? "handed off" : a.state);
  const shown = (a: AgentRow) =>
    (!project || a.unit.projectId === project) && (!role || roleOf(a.unit.type, a.harness) === role) && (!outcome || outcomeOf(a) === outcome);
  const projects = [...new Set(all.map((a) => a.unit.projectId))].sort();
  const roles = [...new Set(all.map((a) => roleOf(a.unit.type, a.harness)))].sort();
  const outcomes = [...new Set(all.map(outcomeOf))].sort();
  const past = all.filter((a) => a.state !== "running" && shown(a));
  const row = (a: AgentRow) => {
    const took = a.startedAt ? duration((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.startedAt)) : "";
    const outcome =
      a.state === "running"
        ? `Running for ${took}.`
        : a.state === "handed_off"
          ? `Handed off${a.handoffStatus ? `: ${a.handoffStatus}` : ""} in ${took}.`
          : a.state === "failed"
            ? `Failed${a.failureMode ? ` (${a.failureMode})` : ""} after ${took}.`
            : a.state === "stopped"
              ? "Stopped by an operator."
              : "Queued.";
    return (
      <Row
        key={a.id}
        seq={
          <Link to={`/a/${a.id}`}>
            {a.unit.projectId} · {roleOf(a.unit.type, a.harness)} U{a.unit.seq}.{a.n}
          </Link>
        }
        goal={<Inline text={a.target?.goal ?? a.unit.goal} />}
        status={outcome + (a.missingSkills.length ? ` Skipped ${a.missingSkills.join(", ")}.` : "")}
        tone={a.state === "running" ? "lamp" : a.state === "failed" || a.missingSkills.length ? "bell" : a.handoffStatus === "success" ? "pine" : "muted"}
        facts={
          <>
            {a.unit.type !== "plan" && (
              <span>
                for <Link to={`/p/${a.unit.projectId}/u/${a.target?.seq ?? a.unit.seq}`}>U{a.target?.seq ?? a.unit.seq}</Link>
              </span>
            )}
            <span>{modelName(a.model)}</span>
            <span>{usd(a.costUsd)}</span>
            {a.contextPeak > 0 && <span>ctx {tokens(a.contextPeak)}</span>}
            <span>started {clock(a.startedAt)}</span>
          </>
        }
      />
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
        {turns.filter((t) => t.state === "running").map(turnRow)}
        {running.length || turns.some((t) => t.state === "running") ? running.filter(shown).map(row) : <div className="empty">No agents at work.</div>}
      </section>
      {turns.some((t) => t.state !== "running") && (
        <section>
          <div className="gh">
            <h2 className="h2">Watchman turns</h2>
            <span className="n">{turns.filter((t) => t.state !== "running").length}</span>
          </div>
          {turns.filter((t) => t.state !== "running").map(turnRow)}
        </section>
      )}
      <section>
        <div className="gh">
          <h2 className="h2">Recent</h2>
          <span className="n">{past.length}</span>
        </div>
        {past.map(row)}
        {past.length >= limit - running.length && (
          <button className="btn sm" type="button" onClick={() => setLimit((l) => l + 100)} style={{ marginTop: 12 }}>
            Show more
          </button>
        )}
      </section>
    </main>
  );
}
