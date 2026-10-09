import { lazy, Suspense, useState } from "react";
import type { RepoAt } from "./Repo";
import type { UnitState } from "@yagura/core";
import { api, useApi, useNow, useQuery, type StoryEntry, type StoryLine, type UnitCode, type UnitStory } from "../api";
import { clip, clock, duration, modelName } from "../lib/format";
import { Inline } from "../lib/markdown";
import { buildTimeline } from "../lib/timeline";
import { unitActions, unitTone } from "../lib/units";
import { StateMap } from "../scene/StateMap";
import { RoleIcon } from "../ui/RoleIcon";
import { Link } from "../ui/Link";
import { RunningDot } from "../ui/Running";
import { DisagreeButton, DisagreeForm as Disagreement } from "../ui/Disagree";
import { NoteForm, useAction } from "../ui/rows";
import { useLog } from "./Agent";

const RepoBrowser = lazy(() => import("./Repo"));

const JUDGMENT: Record<string, string> = { chose: "choice", noted: "note" };

function Line({ l }: { l: StoryLine }) {
  return (
    <li className="story-line">
      <Inline text={l.text} />
      {l.checks.map((c, i) => (
        <span key={i} className={`story-check ${c.ok ? "s-pine" : "s-bell"}`}>
          {c.ok ? "✓" : "✗"} <Inline text={c.text} />
        </span>
      ))}
      {JUDGMENT[l.kind] && <span className="story-check muted">· {JUDGMENT[l.kind]}</span>}
      {l.disagreements.map((d) => (
        <div key={d.id} className="story-disagreed">
          You disagreed: {d.reason}
          {d.state === "open" && " · the project lead will plan a follow-up"}
          {d.state === "noted" && " · later judges on this repo will see it"}
        </div>
      ))}
    </li>
  );
}

export function DisagreeForm({ projectId, seq, entry, onDone }: { projectId: string; seq: number; entry: StoryEntry; onDone: () => void }) {
  const first = entry.lines.find((l) => l.kind === "chose" || l.kind === "noted") ?? entry.lines[0]!;
  return <Disagreement unit={{ projectId, seq }} options={entry.lines.map((l) => ({ ref: l.ref, text: l.text }))} initial={first.ref} onDone={onDone} />;
}

function Entry({
  story,
  entry,
  picked,
  onPick,
  reload,
}: {
  story: UnitStory;
  entry: StoryEntry;
  picked: UnitState | null;
  onPick: (s: UnitState) => void;
  reload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const a = entry.attempt;
  const dot = entry.actor === "person" ? "you" : entry.actor === "yagura" ? "yagura" : "agent";
  const fit = picked ? (entry.state === picked ? " lit" : " dim") : "";
  return (
    <li className={`story-entry ${dot}${fit}`}>
      <button
        type="button"
        className="story-time mono"
        onClick={() => entry.state && onPick(entry.state)}
        title={entry.state ? `Show ${entry.state} on the graph` : undefined}
      >
        {new Date(entry.at).toTimeString().slice(0, 8)}
      </button>
      <div className="story-body">
        <div className="story-head">
          <span className="story-who">
            <RoleIcon role={entry.actor} />
            <b>{entry.who}</b>
            {a && entry.actor !== "person" && (
              <>
                {` · A${a.agentNo}`}
                {a.model && ` · ${modelName(a.model)}`} · ${a.costUsd.toFixed(2)}
              </>
            )}
          </span>
          {entry.status && (
            <span className={`chip story-${entry.status.tone}`}>
              {entry.status.text === "working" && <RunningDot />}
              {entry.status.text}
            </span>
          )}
          {a && (
            <Link className="story-open" to={`/a/${a.id}`}>
              open agent →
            </Link>
          )}
        </div>
        {entry.body && (
          <div className="story-text">
            <Inline text={entry.body} />
          </div>
        )}
        {entry.lines.length > 0 && (
          <ul className="story-lines">
            {entry.lines.map((l) => (
              <Line key={l.ref} l={l} />
            ))}
          </ul>
        )}
        {entry.folded && (
          <details className="story-fold">
            <summary>{entry.folded.summary}</summary>
            <ul>
              {entry.folded.items.map((t) => (
                <li key={t}>
                  <Inline text={t} />
                </li>
              ))}
            </ul>
          </details>
        )}
        {entry.lines.length > 0 && entry.actor !== "yagura" && !open && (
          <div>
            <DisagreeButton onClick={() => setOpen(true)} />
          </div>
        )}
        {open && (
          <DisagreeForm
            projectId={story.projectId}
            seq={story.unit.seq}
            entry={entry}
            onDone={() => {
              setOpen(false);
              reload();
            }}
          />
        )}
      </div>
    </li>
  );
}

function Timeline({
  story,
  picked,
  onPick,
  reload,
}: {
  story: UnitStory;
  picked: UnitState | null;
  onPick: (s: UnitState | null) => void;
  reload: () => void;
}) {
  const items: React.ReactNode[] = [];
  let round = 0;
  for (const [i, e] of story.entries.entries()) {
    if (e.round !== round && e.round > 0) {
      const r = story.rounds[e.round - 1];
      if (r)
        items.push(
          <li key={`r${r.n}`} className="story-round" aria-label={r.text}>
            <span />
            <span>{r.text}</span>
          </li>,
        );
    }
    round = e.round;
    items.push(<Entry key={`${e.id}-${i}`} story={story} entry={e} picked={picked} onPick={onPick} reload={reload} />);
  }
  return (
    <>
      <div className="timeline-head">
        <h2 className="serif">Timeline</h2>
        {picked && (
          <button type="button" className="btn sm" onClick={() => onPick(null)}>
            Showing {picked} · show all
          </button>
        )}
      </div>
      <div className="story-legend">
        <span>
          <span className="s-pine">✓</span> checked by yagura against runs it recorded
        </span>
        <span>· choice / note: judgment nobody checked</span>
      </div>
      {items.length ? <ol className="story-ledger plain-list">{items}</ol> : <div className="muted">Nothing has happened on U{story.unit.seq} yet.</div>}
    </>
  );
}

function AgentsTab({ story }: { story: UnitStory }) {
  if (!story.agents.length) return <div className="muted">No agent has worked on U{story.unit.seq} yet.</div>;
  return (
    <div className="hub-table-wrap">
      <table className="hub-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Role</th>
            <th>Outcome</th>
            <th>Started</th>
            <th>Took</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {story.agents.map((a) => (
            <tr key={a.attemptId} className={a.counted || a.outcome === "running" ? undefined : "dim"}>
              <td>
                <Link to={`/a/${a.attemptId}`}>A{a.agentNo}</Link>
                {a.shared && <div className="muted hub-small">also planned other units</div>}
              </td>
              <td>{a.role}</td>
              <td>
                <span className={`chip story-${a.tone}`}>
                  {a.outcome === "running" && <RunningDot />}
                  {a.counted || a.outcome === "running" ? a.outcome : `${a.outcome} · not counted`}
                </span>
                {a.note && (
                  <div className="muted hub-small">
                    <Inline text={clip(a.note.split("\n")[0]!, 160)} />
                  </div>
                )}
              </td>
              <td className="mono">{a.startedAt ? clock(a.startedAt) : "—"}</td>
              <td className="mono">{a.startedAt && a.endedAt ? duration(Date.parse(a.endedAt) - Date.parse(a.startedAt)) : "—"}</td>
              <td className="num mono">${a.costUsd.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted hub-small">Dimmed rows did not count against the unit's tries.</p>
    </div>
  );
}

function DependenciesTab({ story }: { story: UnitStory }) {
  if (!story.dependencies.length) return <p className="muted">No unit comes before or after this one.</p>;
  return (
    <div className="hub-table-wrap">
      <table className="hub-table">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Direction</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {story.dependencies.map((e) => (
            <tr key={`${e.direction}${e.other.id}`}>
              <td>
                <Link to={`/p/${story.projectId}/u/${e.other.seq}`}>
                  U{e.other.seq}
                  {e.other.repoId ? ` · ${e.other.repoId}` : ""}
                </Link>
                <div className="muted">{clip(e.other.goal, 70)}</div>
              </td>
              <td>{e.direction === "needs" ? `U${story.unit.seq} needs it merged first` : `waits for U${story.unit.seq}`}</td>
              <td>
                <span className={`chip story-${e.state.tone}`}>{e.state.text}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeTab({ story }: { story: UnitStory }) {
  const u = story.unit;
  const { data, error } = useApi<{ code: UnitCode | null }>(u.repoId ? `/api/projects/${story.projectId}/units/${u.seq}/code` : null);
  if (!u.repoId) return <div className="muted">U{u.seq} does not change a repo.</div>;
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const code = data.code;
  if (!code) return <div className="muted">No commits on the branch yet.</div>;
  const at: RepoAt =
    code.source === "merged"
      ? { change: code.commit.sha, from: `${story.projectId}/${u.seq}` }
      : { change: code.commit.sha, ref: code.commit.sha, base: code.base, branch: code.branch ?? undefined, from: `${story.projectId}/${u.seq}` };
  const full = `/r/${u.repoId}?${Object.entries(at)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&")}`;
  return (
    <>
      <div className="hub-actions">
        <span className="muted hub-small">
          {code.source === "merged" ? (
            <>
              The merge, <span className="mono">{code.commit.sha.slice(0, 7)}</span>, against {story.base ?? "its base"} before it.
            </>
          ) : (
            <>
              Not merged yet: branch <span className="mono">{code.branch}</span> at <span className="mono">{code.commit.sha.slice(0, 7)}</span>, against where
              it left {story.base ?? "its base"}.
            </>
          )}
        </span>
        <Link className="btn sm" to={full}>
          Open it full size
        </Link>
      </div>
      <Suspense fallback={<div className="muted">Loading the editor…</div>}>
        <RepoBrowser key={code.commit.sha} id={u.repoId} at={at} embedded />
      </Suspense>
    </>
  );
}

function GateAnswer({ gate, reload }: { gate: UnitStory["gates"][number]; reload: () => void }) {
  const [text, setText] = useState("");
  const action = useAction();
  const answer = (a: string) => action.run(() => api(`/api/gates/${gate.id}/answer`, { body: { answer: a } }).then(reload));
  if (gate.options.length)
    return (
      <>
        {gate.options.map((o, i) => (
          <button key={o} className={`btn${i === 0 ? " lamp" : ""}`} type="button" disabled={action.busy} onClick={() => answer(o)}>
            {o === "land" ? "Merge" : o === "hold" ? "Hold" : o}
          </button>
        ))}
        {action.error && <span className="s-bell">{action.error}</span>}
      </>
    );
  return (
    <form
      className="unit-now-actions"
      style={{ flex: "1 1 100%", marginTop: 0 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) answer(text.trim());
      }}
    >
      <label className="unit-answer">
        Your answer to the unit lead
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say what it should do" />
      </label>
      <button className="btn lamp" type="submit" disabled={action.busy || !text.trim()}>
        Send
      </button>
      {action.error && <span className="s-bell">{action.error}</span>}
    </form>
  );
}

type Form = "retry" | "ask-lead" | "stop" | "drop" | "disagree" | null;

function StatusCard({ story, tone, reload }: { story: UnitStory; tone: string; reload: () => void }) {
  const [form, setForm] = useState<Form>(null);
  const u = story.unit;
  const base = `/api/projects/${story.projectId}/units/${u.seq}`;
  const actions = unitActions(u, story.gates.length, !!story.running);
  const done = () => {
    setForm(null);
    reload();
  };
  const role = story.running?.role.toLowerCase() ?? "agent";
  const lines = story.entries.flatMap((e) => e.lines.map((l) => ({ ref: l.ref, text: l.text })));
  return (
    <section className={`unit-now tone-${tone}`} aria-label="Now">
      <h2>{story.now.headline}</h2>
      {story.now.detail.map((d, i) => (
        <p key={i}>
          <Inline text={d} />
        </p>
      ))}
      {form === "retry" && (
        <NoteForm
          label="Retry"
          placeholder="What should the next try do differently? (optional)"
          submit={(note) => api(`${base}/retry`, { body: { note } })}
          onDone={done}
        />
      )}
      {form === "ask-lead" && (
        <NoteForm
          label="Ask the unit lead"
          placeholder="What should the unit lead look at? (optional)"
          submit={(note) => api(`${base}/wake`, { body: { note } })}
          onDone={done}
        />
      )}
      {form === "stop" && story.running && (
        <NoteForm
          label={`Stop the ${role}`}
          placeholder="Note for whoever picks it up (optional)"
          submit={(note) => api(`/api/attempts/${story.running!.attemptId}/stop`, { body: { note: note || null } })}
          onDone={done}
        />
      )}
      {form === "drop" && (
        <NoteForm
          label="Drop"
          placeholder="Why drop it? (optional)"
          submit={(reason) => api(`${base}/cancel`, { body: { reason: reason || "dropped by the developer" } })}
          onDone={done}
        />
      )}
      {form === "disagree" && lines.length > 0 && (
        <Disagreement unit={{ projectId: story.projectId, seq: u.seq }} options={lines} initial={lines.at(-1)!.ref} onDone={done} />
      )}
      {!form && actions.length > 0 && (
        <div className="unit-now-actions">
          {story.gates.map((g) => (
            <GateAnswer key={g.id} gate={g} reload={reload} />
          ))}
          {actions.includes("retry") && (
            <button className="btn" type="button" onClick={() => setForm("retry")}>
              Retry
            </button>
          )}
          {actions.includes("stop") && (
            <button className="btn" type="button" onClick={() => setForm("stop")}>
              Stop the {role}
            </button>
          )}
          {actions.includes("ask-lead") && (
            <button className="btn" type="button" onClick={() => setForm("ask-lead")}>
              Ask the unit lead…
            </button>
          )}
          {actions.includes("drop") && (
            <button className="btn story-disagree" type="button" onClick={() => setForm("drop")}>
              Drop
            </button>
          )}
          {actions.includes("disagree") && lines.length > 0 && <DisagreeButton onClick={() => setForm("disagree")} />}
        </div>
      )}
    </section>
  );
}

function useLiveStep(running: UnitStory["running"]): string | null {
  const lines = useLog(running?.attemptId ?? 0, !!running);
  const now = useNow(5000);
  if (!running) return null;
  const step = buildTimeline(lines).steps.findLast((s) => s.kind === "tool");
  const took = duration(now - Date.parse(running.startedAt));
  return `A${running.agentNo} · ${took}${step?.kind === "tool" ? ` · ${clip(`${step.name}: ${step.summary}`, 52)}` : ""}`;
}

type Tab = "timeline" | "code" | "agents" | "deps";

export function Unit({ projectId, seq }: { projectId: string; seq: number }) {
  const { data: story, error, reload } = useApi<UnitStory>(`/api/projects/${projectId}/units/${seq}/story`);
  const query = useQuery();
  const [picked, setPicked] = useState<UnitState | null>(null);
  const live = useLiveStep(story?.running ?? null);
  const raw = query.get("tab");
  const tab: Tab = raw === "code" || raw === "agents" || raw === "deps" ? raw : "timeline";
  if (error)
    return (
      <main style={{ padding: 36 }} className="s-bell">
        {error}
      </main>
    );
  if (!story)
    return (
      <main style={{ padding: 36 }} className="muted">
        Loading…
      </main>
    );
  const u = story.unit;
  const tone = unitTone(u.state, story.gates.length);
  const own = story.agents.filter((a) => !a.shared);
  const pick = (s: UnitState | null) => setPicked((p) => (s === null || p === s ? null : s));
  const tabs: [Tab, string][] = [
    ["timeline", "Timeline"],
    ["code", "Code"],
    ["agents", `Agents (${own.length})`],
    ["deps", `Dependencies (${story.dependencies.length})`],
  ];
  return (
    <main className="story">
      <div className="story-crumb mono">
        <Link to={`/p/${projectId}`}>{projectId}</Link> / U{u.seq}
        {u.repoId ? ` · ${u.repoId}` : ` · ${u.type}`}
      </div>
      <h1 className="serif story-title">
        <Inline text={u.goal} />
      </h1>
      <dl className="unit-facts">
        <div className="wide">
          <dt>Acceptance</dt>
          <dd>
            {u.acceptance.length ? (
              <ul>
                {u.acceptance.map((a, i) => (
                  <li key={i}>
                    <Inline text={a} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">none written</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Pull request</dt>
          <dd>
            {story.pr ? (
              <a href={story.pr.url} target="_blank" rel="noreferrer">
                #{story.pr.number} on {story.pr.repo}
                {story.pr.draft ? " · draft" : ""}
              </a>
            ) : (
              <span className="muted">none yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd className="mono">{u.branch ? `${u.branch} → ${story.base ?? "base"}` : <span className="muted">not started</span>}</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd>
            ${story.costUsd.toFixed(2)} · {own.length} agent{own.length === 1 ? "" : "s"}
            {story.started &&
              (story.ended ? ` · ${clock(story.started).slice(0, 5)} to ${clock(story.ended).slice(0, 5)}` : ` · since ${clock(story.started).slice(0, 5)}`)}
          </dd>
        </div>
      </dl>
      <StatusCard story={story} tone={tone} reload={reload} />
      <StateMap moves={story.moves} state={u.state} tone={tone} working={!!story.running} label={live} picked={picked} onPick={pick} />
      <div className="hub-tabs" role="tablist" aria-label="Unit details">
        {tabs.map(([k, label]) => (
          <Link
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "on" : ""}
            to={`/p/${projectId}/u/${u.seq}${k === "timeline" ? "" : `?tab=${k}`}`}
          >
            {label}
          </Link>
        ))}
      </div>
      {tab === "timeline" && <Timeline story={story} picked={picked} onPick={pick} reload={reload} />}
      {tab === "code" && <CodeTab story={story} />}
      {tab === "agents" && <AgentsTab story={story} />}
      {tab === "deps" && <DependenciesTab story={story} />}
    </main>
  );
}
