import { useState } from "react";
import type { DoctorReport } from "@yagura/core";
import { ANSWER_KEYS, ANSWER_QUESTIONS, type Action, type ActionRun, type Answers } from "@yagura/core/domain";
import { api, useApi, useQuery, type EnvironmentDetail, type RepoView } from "../api";
import { clock } from "../lib/format";
import { Inline } from "../lib/markdown";
import { Link } from "../ui/Link";
import { RunningDot } from "../ui/Running";
import { useAction } from "../ui/rows";
import { ScopedSettings } from "../ui/settings";
import { EnvironmentValues } from "./environment-values";

type ActionView = Action & { runs: ActionRun[] };
type Tab = "answers" | "actions" | "doctor" | "values" | "settings";
const CONTRACT = new Set(["version", "publish-snapshot", "snapshot-available"]);
const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "8px 10px", font: "inherit" } as const;

const proofOf = (a: ActionView) => {
  const run = a.runs[0];
  if (a.state === "edited") return "not run since your edit";
  if (a.state === "unproven") return "not run yet";
  if (!run) return a.reason ?? "";
  const when = `${run.repoId}@${run.sha.slice(0, 7)} · ${clock(run.createdAt)}`;
  return a.state === "broken" ? `${a.reason ?? "failed"} · ${clock(run.createdAt)}` : `exit 0 · ${when}`;
};

function AnswersTab({ id, answers, reload }: { id: string; answers: Answers; reload: () => void }) {
  const [draft, setDraft] = useState<Answers>(answers);
  const save = useAction();
  const changed = ANSWER_KEYS.some((k) => draft[k] !== answers[k]);
  const submit = (doctor: boolean) =>
    save.run(async () => {
      await api(`/api/environments/${id}/answers`, { body: { answers: draft } });
      if (doctor) await api(`/api/environments/${id}/doctor`, { body: { note: "the answers changed" } });
      reload();
    });
  return (
    <div className="env-answers">
      <p className="muted hub-small">In your own words. The doctor turns these into actions, and every agent reads them.</p>
      <div className="env-answer-grid">
        {ANSWER_KEYS.map((k) => (
          <label key={k} className="env-answer">
            {ANSWER_QUESTIONS[k]}
            <textarea
              rows={k === "never" || k === "other" ? 2 : 3}
              value={draft[k]}
              placeholder={k === "publish" ? "e.g. maven publish to my nexus at localhost:8801; use gradle, not gradlew" : "Not answered"}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              style={{ ...field, resize: "vertical" }}
            />
          </label>
        ))}
      </div>
      <div className="hub-ask-buttons">
        <button className="btn lamp" type="button" disabled={!changed || save.busy} onClick={() => void submit(false)}>
          Save answers
        </button>
        <button className="btn" type="button" disabled={save.busy} onClick={() => void submit(true)}>
          Save and run the doctor
        </button>
        {save.error && <span className="s-bell">{save.error}</span>}
      </div>
    </div>
  );
}

function ActionForm({ envId, repos, action, onDone }: { envId: string; repos: string[]; action: ActionView | null; onDone: () => void }) {
  const [name, setName] = useState(action?.name ?? "");
  const [repoId, setRepoId] = useState(action?.repoId ?? "");
  const [use, setUse] = useState(action?.use ?? "");
  const [command, setCommand] = useState(action?.command ?? "");
  const [runOn, setRunOn] = useState(action?.repoId ?? repos[0] ?? "");
  const save = useAction();
  const submit = (run: boolean) =>
    save.run(async () => {
      const saved = await api<Action>(`/api/environments/${envId}/actions`, { body: { id: action?.id, repoId: repoId || null, name, use, command } });
      if (run) await api(`/api/actions/${saved.id}/run`, { body: { repoId: repoId || runOn } });
      onDone();
    });
  return (
    <form
      className="env-action-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <div className="env-form-note">
        {action ? `Editing ${action.name}` : "A new action"} · saved when you press Save, proven when it next runs
        {action && action.author !== "you" ? ` · from then on it is yours, and the doctor only suggests` : ""}
      </div>
      <label>
        Name
        <input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="publish-snapshot" style={field} />
      </label>
      <label>
        Applies to
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)} style={field}>
          <option value="">every repo here</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        When to use it
        <input value={use} onChange={(e) => setUse(e.target.value)} placeholder="Publishes this library under $YAGURA_VERSION" style={field} />
      </label>
      <label className="wide">
        Command
        <input
          className="mono"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="gradle publish -Pversion=$YAGURA_VERSION"
          style={field}
        />
      </label>
      <div className="wide hub-ask-buttons">
        <button className="btn lamp" type="submit" disabled={save.busy}>
          Save
        </button>
        <button className="btn" type="button" disabled={save.busy || !(repoId || runOn)} onClick={() => void submit(true)}>
          Save and run on
        </button>
        {!repoId && (
          <select aria-label="Repo to run it on" value={runOn} onChange={(e) => setRunOn(e.target.value)} style={field}>
            {repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        )}
        {repoId && <span className="mono">{repoId}</span>}
        <button className="btn" type="button" onClick={onDone}>
          Cancel
        </button>
        {action && (
          <button
            className="btn story-disagree"
            type="button"
            style={{ marginLeft: "auto" }}
            disabled={save.busy}
            onClick={() =>
              void save.run(async () => {
                await api(`/api/actions/${action.id}/delete`, { body: {} });
                onDone();
              })
            }
          >
            Delete
          </button>
        )}
        {save.error && <span className="s-bell">{save.error}</span>}
      </div>
    </form>
  );
}

function ActionsTab({ envId, actions, repos, reload }: { envId: string; actions: ActionView[]; repos: string[]; reload: () => void }) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [started, setStarted] = useState<Record<number, number | null>>({});
  const act = useAction();
  const done = () => {
    setEditing(null);
    reload();
  };
  const run = (a: ActionView, repoId: string | null) =>
    act.run(async () => {
      await api(`/api/actions/${a.id}/run`, { body: { repoId } });
      setStarted((s) => ({ ...s, [a.id]: a.lastRunId }));
    });
  return (
    <>
      <div className="env-tab-bar">
        <span className="muted hub-small">Click an action to edit it. yagura itself runs the three marked yagura, after a library unit merges.</span>
        <button className="btn sm" type="button" onClick={() => setEditing("new")}>
          Add an action
        </button>
      </div>
      {editing === "new" && <ActionForm envId={envId} repos={repos} action={null} onDone={done} />}
      {act.error && <div className="s-bell">{act.error}</div>}
      {!actions.length && editing !== "new" && <p className="muted">No actions yet. Answer how this environment works, then run the doctor.</p>}
      {actions.length > 0 && (
        <div className="hub-table-wrap">
          <table className="hub-table env-actions">
            <thead>
              <tr>
                <th>Action</th>
                <th>When to use it</th>
                <th>Applies to</th>
                <th>State</th>
                <th>
                  <span className="sr-only">Run</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => {
                const running = a.id in started && started[a.id] === a.lastRunId;
                return editing === a.id ? (
                  <tr key={a.id}>
                    <td colSpan={5}>
                      <ActionForm envId={envId} repos={repos} action={a} onDone={done} />
                    </td>
                  </tr>
                ) : (
                  <tr key={a.id} className={a.state === "broken" ? "env-broken" : undefined}>
                    <td className="mono">
                      <button type="button" className="env-name" onClick={() => setEditing(a.id)}>
                        {a.name}
                      </button>
                      {CONTRACT.has(a.name) && <div className="env-yagura">yagura</div>}
                    </td>
                    <td>
                      <Inline text={a.use} />
                      <div className="mono env-command">{a.command}</div>
                      {a.suggestion && (
                        <div className="env-suggestion">
                          <b>The doctor suggests</b> <Inline text={a.suggestion.why} />
                          <div className="mono">{a.suggestion.command}</div>
                          <div className="hub-ask-buttons">
                            <button
                              className="btn sm lamp"
                              type="button"
                              onClick={() => void act.run(() => api(`/api/actions/${a.id}/suggestion`, { body: { accept: true } }).then(reload))}
                            >
                              Accept
                            </button>
                            <button
                              className="btn sm"
                              type="button"
                              onClick={() => void act.run(() => api(`/api/actions/${a.id}/suggestion`, { body: { accept: false } }).then(reload))}
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="mono">{a.repoId ?? "every repo"}</td>
                    <td>
                      <span className={`chip story-${a.state === "proven" ? "pine" : a.state === "broken" ? "bell" : "amber"}`}>
                        {running && <RunningDot />}
                        {running ? "running" : a.state}
                      </span>
                      <div className="muted hub-small">{proofOf(a)}</div>
                      <div className="muted hub-small">{a.author === "you" ? "yours" : a.author === "doctor" ? "by the doctor" : "added by an agent"}</div>
                    </td>
                    <td>
                      <button className="btn sm" type="button" disabled={running || act.busy} onClick={() => void run(a, a.repoId ?? repos[0] ?? null)}>
                        Run now
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DoctorTab({ reports }: { reports: DoctorReport[] }) {
  if (!reports.length) return <p className="muted">No doctor has run here yet. It runs when an active project on this environment starts.</p>;
  return (
    <div className="env-doctor">
      {reports.map((r) => (
        <section key={r.repoId}>
          <h3>
            <span className="mono">{r.repoId}</span>
            <span className="muted hub-small">
              {r.running && <RunningDot />}
              {r.running ? "looking now" : r.startedAt ? clock(r.startedAt) : ""} · project <Link to={`/p/${r.projectId}`}>{r.projectId}</Link>
              {r.attemptId !== null && (
                <>
                  {" · "}
                  <Link to={`/a/${r.attemptId}`}>A{r.agentNo}</Link> · ${r.costUsd.toFixed(2)}
                </>
              )}
            </span>
          </h3>
          {!r.report && !r.running && <p className="s-bell">This doctor ended without a report.</p>}
          {r.report && (
            <ul className="env-report">
              {r.report.works.map((t) => (
                <li key={`w${t}`}>
                  <span className="s-pine">works</span> <Inline text={t} />
                </li>
              ))}
              {r.report.fails.map((t) => (
                <li key={`f${t}`}>
                  <span className="s-bell">fails</span> <Inline text={t} />
                </li>
              ))}
              {r.report.unknown.map((t) => (
                <li key={`u${t}`}>
                  <span className="story-amber">can't tell</span> <Inline text={t} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function StatusCard({
  id,
  actions,
  reports,
  active,
  reload,
}: {
  id: string;
  actions: ActionView[];
  reports: DoctorReport[];
  active: boolean;
  reload: () => void;
}) {
  const ask = useAction();
  const broken = actions.filter((a) => a.state === "broken");
  const running = reports.filter((r) => r.running);
  const failing = reports.flatMap((r) => (r.report?.fails ?? []).map((f) => `${r.repoId}: ${f}`));
  const untried = actions.filter((a) => a.state === "unproven" || a.state === "edited");
  const tone = broken.length || failing.length ? "bell" : running.length || untried.length ? "lamp" : actions.length ? "pine" : "muted";
  const headline = running.length
    ? `The doctor is looking at ${running.map((r) => r.repoId).join(", ")}.`
    : broken.length
      ? `${broken.length} action${broken.length === 1 ? " is" : "s are"} broken.`
      : !actions.length
        ? "No actions yet."
        : failing.length
          ? "The doctor could not make everything work."
          : untried.length
            ? `${untried.length} of ${actions.length} actions not run since they were written or edited.`
            : `${actions.length} action${actions.length === 1 ? "" : "s"}, all working.`;
  const detail = [
    ...broken.map((a) => `${a.name}${a.repoId ? ` on ${a.repoId}` : ""}: ${a.reason ?? "no reason recorded"}`),
    ...failing.filter((f) => !broken.some((a) => f.includes(a.name))),
    ...untried.map((a) => `${a.name}: run it to prove it.`),
    ...(!actions.length ? ["Answer how this environment works, then run the doctor."] : []),
    ...(!active ? ["The doctor runs for active projects; no project here is active."] : []),
  ];
  return (
    <section className={`unit-now tone-${tone}`} aria-label="Now">
      <div className="env-now">
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <h2>{headline}</h2>
          {detail.map((d) => (
            <p key={d}>
              <Inline text={d} />
            </p>
          ))}
        </div>
        <button
          className="btn lamp"
          type="button"
          disabled={ask.busy || running.length > 0 || !active}
          onClick={() => void ask.run(() => api(`/api/environments/${id}/doctor`, { body: { note: "" } }).then(reload))}
        >
          Run the doctor
        </button>
      </div>
      {ask.error && <div className="s-bell">{ask.error}</div>}
    </section>
  );
}

export function Environment({ id }: { id: string }) {
  const detail = useApi<EnvironmentDetail>(`/api/environments/${id}`);
  const actions = useApi<ActionView[]>(`/api/environments/${id}/actions`);
  const doctor = useApi<DoctorReport[]>(`/api/environments/${id}/doctor`);
  const repos = useApi<RepoView[]>("/api/repos");
  const query = useQuery();
  const raw = query.get("tab");
  const tab: Tab = raw === "answers" || raw === "doctor" || raw === "values" || raw === "settings" ? raw : "actions";
  const reload = () => {
    detail.reload();
    actions.reload();
    doctor.reload();
  };
  if (detail.error) return <main className="story s-bell">{detail.error}</main>;
  if (!detail.data || !actions.data || !doctor.data) return <main className="story muted">Loading…</main>;
  const env = detail.data.environment;
  const answered = ANSWER_KEYS.filter((k) => env.answers[k]).length;
  const repoIds = (repos.data ?? []).map((r) => r.repo.id);
  const tabs: [Tab, string][] = [
    ["answers", `How it works (${answered} of ${ANSWER_KEYS.length} answered)`],
    ["actions", `Actions (${actions.data.length})`],
    ["doctor", `Doctor reports (${doctor.data.length})`],
    ["values", `Values (${detail.data.values.length})`],
    ["settings", "Settings"],
  ];
  return (
    <main className="story">
      <div className="story-crumb mono">
        <Link to="/environments">Environments</Link> / {env.id}
      </div>
      <h1 className="serif story-title">{env.name}</h1>
      <dl className="unit-facts">
        <div>
          <dt>Runs on</dt>
          <dd className="mono">
            {env.provider} · {env.capacity} slot{env.capacity === 1 ? "" : "s"}
          </dd>
        </div>
        <div className="wide">
          <dt>Projects</dt>
          <dd>
            {detail.data.projects.length
              ? detail.data.projects.map((p, i) => (
                  <span key={p.id}>
                    {i ? ", " : ""}
                    <Link to={`/p/${p.id}`}>{p.id}</Link>
                    {p.state === "closed" ? " (closed)" : ""}
                  </span>
                ))
              : "none"}
          </dd>
        </div>
      </dl>
      <StatusCard id={id} actions={actions.data} reports={doctor.data} active={detail.data.projects.some((p) => p.state === "active")} reload={reload} />
      <div className="hub-tabs" role="tablist" aria-label="Environment">
        {tabs.map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} to={`/e/${id}${k === "actions" ? "" : `?tab=${k}`}`}>
            {label}
          </Link>
        ))}
      </div>
      <div className="env-tab">
        {tab === "answers" && <AnswersTab key={JSON.stringify(env.answers)} id={id} answers={env.answers} reload={reload} />}
        {tab === "actions" && <ActionsTab envId={id} actions={actions.data} repos={repoIds} reload={reload} />}
        {tab === "doctor" && <DoctorTab reports={doctor.data} />}
        {tab === "values" && <EnvironmentValues id={id} onChanged={reload} />}
        {tab === "settings" && <ScopedSettings scope="environment" id={id} />}
      </div>
    </main>
  );
}
