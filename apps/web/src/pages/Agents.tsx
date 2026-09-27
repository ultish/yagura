import { useState } from "react";
import { useApi, useNow, type AgentRow } from "../api";
import { clock, duration, modelName, tokens } from "../lib/format";
import { Link } from "../ui/Link";
import { Row } from "../ui/rows";

const ROLE: Record<string, string> = { plan: "planner", work: "worker", verify: "verifier" };

export function Agents() {
  const now = useNow(1000);
  const [limit, setLimit] = useState(50);
  const { data, error } = useApi<{ attempts: AgentRow[]; caps: { maxParallelAgents: number; running: number } }>(`/api/agents?recent=${limit}`);
  const all = data?.attempts ?? [];
  const running = all.filter((a) => a.state === "running");
  const past = all.filter((a) => a.state !== "running");
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
            {a.unit.projectId} · {a.unit.type === "plan" ? "plan" : `U${a.unit.seq}`}
          </Link>
        }
        goal={a.unit.goal}
        status={outcome + (a.missingSkills.length ? ` Skipped ${a.missingSkills.join(", ")}.` : "")}
        tone={a.state === "running" ? "lamp" : a.state === "failed" || a.missingSkills.length ? "bell" : a.handoffStatus === "success" ? "pine" : "muted"}
        facts={
          <>
            <span>
              <b>{ROLE[a.unit.type] ?? a.unit.type}</b> · try {a.n}
            </span>
            <span>{modelName(a.model)}</span>
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
      <section>
        <div className="gh">
          <h2 className="h2">Lanterns lit</h2>
          <span className="n">{data ? `${data.caps.running} of ${data.caps.maxParallelAgents} agent slots` : ""}</span>
        </div>
        {running.length ? running.map(row) : <div className="empty">No agents at work.</div>}
      </section>
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
