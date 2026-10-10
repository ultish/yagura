import { useMemo } from "react";
import type { DoctorRun as Run } from "@yagura/core";
import { api, useApi, useNow } from "../api";
import { clock, duration, modelName } from "../lib/format";
import { Inline } from "../lib/markdown";
import { buildTimeline } from "../lib/timeline";
import { Link } from "../ui/Link";
import { RunningDot } from "../ui/Running";
import { useAction } from "../ui/rows";
import { StepRow, useLog } from "./Agent";

const TRIGGER: Record<Run["trigger"], string> = { setup: "a project was set up", asked: "you asked", broken: "an action broke" };

export function DoctorReportList({ report }: { report: NonNullable<Run["report"]> }) {
  return (
    <ul className="env-report">
      {report.works.map((t) => (
        <li key={`w${t}`}>
          <span className="s-pine">works</span> <Inline text={t} />
        </li>
      ))}
      {report.fails.map((t) => (
        <li key={`f${t}`}>
          <span className="s-bell">fails</span> <Inline text={t} />
        </li>
      ))}
      {report.unknown.map((t) => (
        <li key={`u${t}`}>
          <span className="story-amber">can't tell</span> <Inline text={t} />
        </li>
      ))}
    </ul>
  );
}

// One doctor run: why it was woken, what it reported, and every step of its session.
export function DoctorRun({ id }: { id: number }) {
  const { data: run, error, reload } = useApi<Run>(`/api/doctor-runs/${id}`);
  const live = run?.state === "running";
  const lines = useLog(run ? `/api/doctor-runs/${id}` : null, !!live);
  const timeline = useMemo(() => buildTimeline(lines), [lines]);
  const now = useNow(5000);
  const stop = useAction();
  if (error) return <main className="story s-bell">{error}</main>;
  if (!run) return <main className="story muted">Loading…</main>;
  const start = run.startedAt ? Date.parse(run.startedAt) : null;
  const took = duration((run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt));
  return (
    <main className="story">
      <div className="story-crumb mono">
        <Link to="/environments">Environments</Link> / <Link to={`/e/${run.environmentId}?tab=doctor`}>{run.environmentId}</Link> / D{run.id}
      </div>
      <h1 className="serif story-title">
        Doctor D{run.id} · {run.repoId}
      </h1>
      <dl className="unit-facts">
        <div>
          <dt>Woken because</dt>
          <dd>{TRIGGER[run.trigger]}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            {live && <RunningDot />}
            {run.state}
          </dd>
        </div>
        <div>
          <dt>Ran</dt>
          <dd className="mono">
            {clock(run.startedAt)} · {took}
          </dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>
            ${run.costUsd.toFixed(2)}
            {run.model ? ` · ${modelName(run.model)}` : ""}
          </dd>
        </div>
        {run.projectId && (
          <div>
            <dt>Set up by</dt>
            <dd>
              <Link to={`/p/${run.projectId}`}>{run.projectId}</Link>
            </dd>
          </div>
        )}
      </dl>
      <section className={`unit-now tone-${live ? "lamp" : run.report?.fails.length || !run.report ? "bell" : "pine"}`} aria-label="Report">
        <div className="env-now">
          <div style={{ minWidth: 0, flex: "1 1 420px" }}>
            <h2>{live ? "Looking now." : run.report ? "Report" : "Ended without a report."}</h2>
            <p>
              <Inline text={run.detail} />
            </p>
            {run.report && <DoctorReportList report={run.report} />}
          </div>
          {live && (
            <button
              className="btn"
              type="button"
              disabled={stop.busy}
              onClick={() => void stop.run(() => api(`/api/doctor-runs/${id}/stop`, { body: {} }).then(reload))}
            >
              Stop
            </button>
          )}
        </div>
      </section>
      <div className="timeline-head">
        <h2 className="serif">Session</h2>
        <span className="mono muted hub-small">
          {live ? "live · " : ""}
          {timeline.steps.length} steps
        </span>
      </div>
      {!timeline.steps.length && <div className="empty">{live ? "Waiting for the doctor's first words…" : "No log was recorded."}</div>}
      {timeline.steps.map((s) => (
        <StepRow key={s.id} step={s} start={start} live={!!live} />
      ))}
    </main>
  );
}
