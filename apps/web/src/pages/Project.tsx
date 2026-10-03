import { useState } from "react";
import { api, navigate, useApi, useNow, type ProjectDetail, type UnitView } from "../api";
import { modelName, sha, spend, tokens } from "../lib/format";
import { type Group, groupOf, isBuild, jobName, latestAttempt, openGateFor, statusLine, verifiersOf } from "../lib/units";
import { Inline } from "../lib/markdown";
import { Beacons } from "../scene/Beacons";
import { Link } from "../ui/Link";
import { NoteForm, Row, useAction } from "../ui/rows";
import { ScopedSettings } from "../ui/settings";

const GROUPS: { key: Group; title: string; bell?: boolean; collapsed?: boolean }[] = [
  { key: "bell", title: "The bell · needs you", bell: true },
  { key: "lit", title: "Lanterns lit" },
  { key: "waiting", title: "Waiting for a signal" },
  { key: "landed", title: "Landed", collapsed: true },
  { key: "cancelled", title: "Cancelled", collapsed: true },
];

function Runs({ d, u }: { d: ProjectDetail; u: UnitView }) {
  const v = verifiersOf(d, u).at(-1);
  if (!v || !u.verdict) return null;
  return (
    <span className="run ok">
      verified {u.verdict.tier} by {jobName(v)}
    </span>
  );
}

function UnitRow({ d, u, now }: { d: ProjectDetail; u: UnitView; now: number }) {
  const action = useAction();
  const [retrying, setRetrying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const status = statusLine(d, u, now);
  const gate = openGateFor(d, u);
  const last = latestAttempt(u);
  const running = u.attempts.find((a) => a.state === "running");
  const verifying = verifiersOf(d, u)
    .flatMap((v) => v.attempts)
    .find((a) => a.state === "running");
  const base = `/api/projects/${d.project.id}/units/${u.seq}`;
  const facts = last && (
    <>
      <span>
        <b>{modelName(last.model)}</b> · try {u.attempts.length} of {u.maxAttempts}
        {last.skills.length ? (last.missingSkills.length ? ` · skills ✕ ${last.missingSkills.join(", ")}` : " · skills ✓") : ""}
      </span>
      {last.contextPeak > 0 && <span>ctx {tokens(last.contextPeak)}</span>}
      <Runs d={d} u={u} />
      {last.branch && <span>{last.branch}</span>}
      {u.landedSha && <span>landed {sha(u.landedSha, 10)}</span>}
    </>
  );
  return (
    <Row
      seq={<Link to={`/p/${d.project.id}/u/${u.seq}`}>U{u.seq}</Link>}
      goal={<Inline text={u.goal} />}
      status={<Inline text={status.text} />}
      tone={status.tone}
      facts={facts}
      extra={
        <>
          {retrying && (
            <NoteForm
              label="Retry"
              placeholder="What should the next try do differently? (optional)"
              submit={(note) => api(`${base}/retry`, { body: { note } })}
              onDone={() => setRetrying(false)}
            />
          )}
          {stopping && running && (
            <NoteForm
              label="Stop"
              placeholder="Note for the next attempt (optional)"
              submit={(note) => api(`/api/attempts/${running.id}/stop`, { body: { note: note || null } })}
              onDone={() => setStopping(false)}
            />
          )}
          {action.error && (
            <span className="s-bell" style={{ fontSize: 13 }}>
              {action.error}
            </span>
          )}
        </>
      }
      actions={
        !retrying &&
        !stopping && (
          <>
            {gate &&
              gate.options.map((o, i) => (
                <button
                  key={o}
                  className={`btn${i === 0 ? " bell" : ""}`}
                  type="button"
                  disabled={action.busy}
                  onClick={() => action.run(() => api(`/api/gates/${gate.id}/answer`, { body: { answer: o } }))}
                >
                  {o === "land" ? "Land" : o === "hold" ? "Hold" : o}
                </button>
              ))}
            {u.state === "blocked" && (
              <button className="btn" type="button" onClick={() => setRetrying(true)}>
                Retry with a note
              </button>
            )}
            {(running || verifying) && (
              <button className="btn" type="button" onClick={() => navigate(`/a/${(running ?? verifying)!.id}`)}>
                Watch
              </button>
            )}
            {running && (
              <button className="btn" type="button" onClick={() => setStopping(true)}>
                Stop
              </button>
            )}
            {["blocked", "ready", "draft"].includes(u.state) && (
              <button className="btn" type="button" disabled={action.busy} onClick={() => action.run(() => api(`${base}/cancel`, { body: {} }))}>
                Cancel
              </button>
            )}
          </>
        )
      }
    />
  );
}

function ProjectGates({ d }: { d: ProjectDetail }) {
  const action = useAction();
  const gates = d.gates.filter((g) => g.state === "open" && !g.unitId);
  return (
    <>
      {gates.map((g) => (
        <Row
          key={g.id}
          seq="project"
          goal={<Inline text={g.question} />}
          status={g.defaultOption ? `Default if nobody answers: ${g.defaultOption}.` : undefined}
          tone={g.kind === "report" ? "pine" : "bell"}
          actions={g.options.map((o, i) => (
            <button
              key={o}
              className={`btn${i === 0 && g.kind !== "report" ? " bell" : ""}`}
              type="button"
              disabled={action.busy}
              onClick={() => action.run(() => api(`/api/gates/${g.id}/answer`, { body: { answer: o } }))}
            >
              {o}
            </button>
          ))}
        />
      ))}
    </>
  );
}

export function Project({ id }: { id: string }) {
  const now = useNow(1000);
  const { data: d, error } = useApi<ProjectDetail>(`/api/projects/${id}`);
  const action = useAction();
  const [andon, setAndon] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (error)
    return (
      <main style={{ padding: 36 }} className="s-bell">
        {error}
      </main>
    );
  if (!d)
    return (
      <main style={{ padding: 36 }} className="muted">
        Loading {id}…
      </main>
    );
  const p = d.project;
  const work = d.units.filter(isBuild);
  const byGroup = (g: Group) => work.filter((u) => groupOf(d, u) === g);
  const facts = [
    d.repos.map((r) => `${r.id}@${r.defaultBranch}`).join(", "),
    p.environmentId ? `env ${p.environmentId}` : "no environment",
    p.mergePolicy === "auto" ? "merges automatically" : "merge by hand",
    `≥ ${p.minTier}`,
    `${d.maxInFlight} agent slots`,
    spend(d.costUsd, d.budgetUsd),
    ...p.refs,
    p.after.length ? `after ${p.after.join(", ")}` : "",
    p.state !== "active" ? p.state : "",
  ].filter(Boolean);
  return (
    <main>
      <section style={{ padding: "26px 36px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="mono muted" style={{ fontSize: 12.5 }}>
          {facts.join(" · ")}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
          <h1 className="serif" style={{ margin: 0, fontSize: 42, fontWeight: 600 }}>
            {p.id}
          </h1>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            {p.andonReason ? (
              <button
                className="btn"
                type="button"
                disabled={action.busy}
                onClick={() => action.run(() => api(`/api/projects/${p.id}/andon`, { body: { reason: null } }))}
              >
                Clear andon
              </button>
            ) : (
              <button className="btn" type="button" onClick={() => setAndon(true)}>
                Ring andon
              </button>
            )}
            <button
              className="btn lamp"
              type="button"
              onClick={() =>
                navigate(d.threads.length ? `/talk/${d.threads.at(-1)}?say=${encodeURIComponent(`@${p.id} `)}` : `/talk?say=${encodeURIComponent(`@${p.id} `)}`)
              }
            >
              Add work
            </button>
          </div>
        </div>
        {andon && (
          <NoteForm
            label="Ring andon"
            placeholder="Why stop new work on this project?"
            submit={(reason) => api(`/api/projects/${p.id}/andon`, { body: { reason: reason || "stopped by operator" } })}
            onDone={() => setAndon(false)}
          />
        )}
        {p.andonReason && <div className="s-bell">Andon: {p.andonReason}. No new agents start until it is cleared.</div>}
        <p style={{ margin: 0, fontSize: 16.5, lineHeight: 1.6, color: "var(--soft)", maxWidth: 820 }}>
          <Inline text={p.goal} />{" "}
          <span className="muted">
            Done when: <Inline text={p.predicate} />
          </span>
        </p>
        {d.summary && (
          <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: 820 }}>
            Planner: <Inline text={d.summary} />
          </p>
        )}
        <div className="mono" style={{ fontSize: 12 }}>
          {d.threads.length > 0 && (
            <>
              conversations:{" "}
              {d.threads.map((t) => (
                <Link key={t} to={`/talk/${t}`} style={{ marginRight: 10 }}>
                  thread {t}
                </Link>
              ))}
              {" · "}
            </>
          )}
          <Link to={`/p/${d.project.id}/spec`}>spec →</Link>
          {" · "}
          <Link to={`/p/${d.project.id}/prompts`}>prompts: what its agents are told →</Link>
        </div>
      </section>
      <Beacons d={d} now={now} />
      <section
        style={{ padding: "20px 36px 48px", display: "flex", flexDirection: "column", gap: 24, background: "var(--bg2)", borderTop: "1px solid var(--line)" }}
      >
        {!work.length && (
          <div className="empty">
            {d.planning
              ? "The planner is thinking about the first units."
              : p.state === "framing"
                ? `Dark until ${p.after.join(", ")} closes.`
                : "No units yet."}
          </div>
        )}
        {GROUPS.map((g) => {
          const units = byGroup(g.key);
          const extras = g.key === "bell" ? d.gates.filter((x) => x.state === "open" && !x.unitId).length : 0;
          if (!units.length && !extras) return null;
          const shown = !g.collapsed || open[g.key];
          return (
            <div key={g.key}>
              <div className="gh">
                <h2 className="h2" style={g.bell ? { color: "var(--bell-text)" } : undefined}>
                  {g.title}
                </h2>
                <span className="n">{units.length + extras}</span>
                {g.collapsed && (
                  <button
                    type="button"
                    className="mono"
                    onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
                    style={{ fontSize: 12, background: "none", border: 0, color: "var(--amber)", cursor: "pointer" }}
                    aria-expanded={shown}
                  >
                    {shown ? "hide" : "show"}
                  </button>
                )}
              </div>
              {g.key === "bell" && <ProjectGates d={d} />}
              {shown && units.map((u) => <UnitRow key={u.id} d={d} u={u} now={now} />)}
            </div>
          );
        })}
        {d.skills.length > 0 && (
          <div>
            <h2 className="h2">Project skills</h2>
            <div className="facts" style={{ marginTop: 6 }}>
              {d.skills.map((k) => (
                <span key={k.skill} className={k.installed ? undefined : "s-bell"}>
                  <span className="mono">{k.skill}</span> {k.purposes.join(", ")}
                  {k.installed ? "" : " · not installed where agents run"}
                </span>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="gh">
            <h2 className="h2">Settings</h2>
            <button
              type="button"
              className="mono"
              onClick={() => setOpen((o) => ({ ...o, settings: !o.settings }))}
              style={{ fontSize: 12, background: "none", border: 0, color: "var(--amber)", cursor: "pointer" }}
              aria-expanded={!!open.settings}
            >
              {open.settings ? "hide" : "show"}
            </button>
          </div>
          {open.settings && <ScopedSettings scope="project" id={p.id} />}
        </div>
      </section>
    </main>
  );
}
