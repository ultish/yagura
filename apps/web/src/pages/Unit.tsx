import { useState } from "react";
import { api, useApi, useQuery, type StoryEntry, type StoryLine, type UnitCode, type UnitStory } from "../api";
import { clip, clock, duration, modelName, when } from "../lib/format";
import { Inline } from "../lib/markdown";
import { RoleIcon } from "../ui/RoleIcon";
import { DiffPanel, type DiffData } from "../ui/evidence";
import { Link } from "../ui/Link";
import { RunningDot } from "../ui/Running";
import { DisagreeButton, DisagreeForm as Disagreement } from "../ui/Disagree";
import { useAction } from "../ui/rows";

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
          {d.state === "open" && " · the planner will plan a follow-up"}
          {d.state === "noted" && " · later verifiers on this repo will see it"}
        </div>
      ))}
    </li>
  );
}

export function DisagreeForm({ projectId, seq, entry, onDone }: { projectId: string; seq: number; entry: StoryEntry; onDone: () => void }) {
  const first = entry.lines.find((l) => l.kind === "chose" || l.kind === "noted") ?? entry.lines[0]!;
  return <Disagreement unit={{ projectId, seq }} options={entry.lines.map((l) => ({ ref: l.ref, text: l.text }))} initial={first.ref} onDone={onDone} />;
}

function Entry({ story, entry, reload }: { story: UnitStory; entry: StoryEntry; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const a = entry.attempt;
  const dot = entry.actor === "person" ? "you" : entry.actor === "yagura" ? "yagura" : "agent";
  return (
    <div className={`story-entry ${dot}`}>
      <div className="story-time mono">{clock(entry.at)}</div>
      <div className="story-body">
        <div className="story-head">
          <span className="story-who">
            <RoleIcon role={entry.actor} />
            {a ? (
              <Link to={`/a/${a.id}`}>
                <b>{entry.who}</b>
                {entry.actor !== "person" && ` · A${a.agentNo}`}
              </Link>
            ) : (
              <b>{entry.who}</b>
            )}
            {a && entry.actor !== "person" && (
              <>
                {a.model && ` · ${modelName(a.model)}`} · ${a.costUsd.toFixed(2)}
              </>
            )}
          </span>
          {entry.status && <span className={`chip story-${entry.status.tone}`}>{entry.status.text}</span>}
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
    </div>
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
            <th>When</th>
            <th>Took</th>
            <th className="num">Cost</th>
            <th>Outcome</th>
            <th>What it did</th>
          </tr>
        </thead>
        <tbody>
          {story.agents.map((a) => (
            <tr key={a.attemptId} className={a.counted ? undefined : "dim"}>
              <td>
                <Link to={`/a/${a.attemptId}`}>
                  {a.role} A{a.agentNo}
                </Link>
                {a.shared && <div className="muted hub-small">also planned other units</div>}
              </td>
              <td className="mono">{when(a.startedAt, a.endedAt, false)}</td>
              <td className="mono">{a.startedAt && a.endedAt ? duration(Date.parse(a.endedAt) - Date.parse(a.startedAt)) : "—"}</td>
              <td className="num mono">${a.costUsd.toFixed(2)}</td>
              <td>
                <span className={`chip story-${a.tone}`}>
                  {a.outcome === "running" && <RunningDot />}
                  {a.counted || a.outcome === "running" ? a.outcome : `${a.outcome} · not counted`}
                </span>
              </td>
              <td>{a.note ? <Inline text={clip(a.note.split("\n")[0]!, 220)} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted hub-small">
        Every session that worked on U{story.unit.seq}: the planner run that planned it, its own attempts, and the verifiers, reviewers, review triage, and
        rebases that targeted it. Dimmed rows did not count.
      </p>
    </div>
  );
}

function OpenGates({ gates, reload }: { gates: UnitStory["gates"]; reload: () => void }) {
  const action = useAction();
  if (!gates.length) return null;
  return (
    <>
      {gates.map((g) => (
        <div key={g.id} className="hub-ask" role="group" aria-label="Waiting for you">
          <div>
            <b>Waiting for you</b> · {g.question}
          </div>
          <div className="hub-ask-buttons">
            {g.options.map((o, i) => (
              <button
                key={o}
                className={`btn${i === 0 ? " bell" : ""}`}
                type="button"
                disabled={action.busy}
                onClick={() => action.run(() => api(`/api/gates/${g.id}/answer`, { body: { answer: o } }).then(reload))}
              >
                {o === "land" ? "Land" : o === "hold" ? "Hold" : o === "publish" ? "Publish" : o}
              </button>
            ))}
          </div>
          {action.error && <div className="s-bell">{action.error}</div>}
        </div>
      ))}
    </>
  );
}

function CodeTab({ story }: { story: UnitStory }) {
  const u = story.unit;
  const { data, error } = useApi<{ code: UnitCode | null }>(u.repoId ? `/api/projects/${story.projectId}/units/${u.seq}/code` : null);
  const shown = data?.code ?? null;
  const diff = useApi<DiffData>(shown ? `/api/repos/${u.repoId}/diff-files?base=${shown.base}&head=${shown.commit.sha}` : null);
  if (!u.repoId) return <div className="muted">U{u.seq} does not change a repo.</div>;
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const code = data.code;
  if (!code) return <div className="muted">U{u.seq} has no code yet: nothing has been handed off.</div>;
  const from = `from=${story.projectId}/${u.seq}`;
  const editor = (extra: string) => `/r/${u.repoId}?${code.source === "landed" ? `change=${code.commit.sha}&` : ""}${extra}${from}`;
  return (
    <div className="hub-code">
      {code.source === "branch" && (
        <div className="hub-note">
          Not on trunk yet: this is branch <span className="mono">{code.branch}</span> against the trunk it started from. The editor shows trunk, so it opens
          after U{u.seq} lands.
        </div>
      )}
      {code.source === "landed" && (
        <div className="hub-actions">
          <Link className="btn sm lamp" to={editor("")}>
            Open this change in the editor
          </Link>
          <span className="muted hub-small">
            The commit that landed, <span className="mono">{code.commit.sha.slice(0, 7)}</span>, against trunk before it.
          </span>
        </div>
      )}
      {diff.error && <div className="s-bell">{diff.error}</div>}
      {!diff.data && !diff.error && <div className="muted">Loading the diff…</div>}
      {diff.data && (
        <DiffPanel
          data={diff.data}
          stats={code.stats}
          disagree={{ projectId: story.projectId, seq: u.seq }}
          editorLink={code.source === "landed" ? (f) => editor(`file=${encodeURIComponent(f)}&`) : undefined}
        />
      )}
      {code.truncated && <div className="muted repo-pad">The rest of this change is too large to show.</div>}
    </div>
  );
}

function ManagerTab({ story }: { story: UnitStory }) {
  if (!story.managerOn && !story.manager.length)
    return (
      <div className="muted">
        The manager is off for this project (the setting manager.enabled), so the fixed rules decide what happens after a rejection or failure.
      </div>
    );
  if (!story.manager.length)
    return (
      <div className="muted">
        No decisions yet. U{story.unit.seq}'s manager is woken only when its worker is rejected, fails, or runs out of tries; a unit that goes smoothly never
        needs it.
      </div>
    );
  return (
    <div className="mgr">
      <p className="muted">
        Each time the manager is woken it is told what changed since its last decision and answers with one action. Open its run to read exactly what it was
        told.
      </p>
      {story.manager.map((t) => (
        <section key={t.decisionId} className="mgr-turn">
          <div className="mgr-head mono">
            {t.agentNo !== null ? `A${t.agentNo}` : "no run"} · {clock(t.at)} · {t.resumed ? "same session, told what changed" : "first wake"} · $
            {t.costUsd.toFixed(2)}
            {t.attemptId !== null && (
              <>
                {" · "}
                <Link to={`/a/${t.attemptId}`}>open its run, brief, and log →</Link>
              </>
            )}
          </div>
          <div>
            <b>Woken because</b> <Inline text={t.wake} />
          </div>
          <div>
            <b>{t.actionText}</b>
            {": "}
            <Inline text={t.reason} />
          </div>
          {t.note && (
            <div className="muted">
              Note for the next worker: <Inline text={t.note} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

type HubTab = "story" | "agents" | "code" | "manager";

export function Unit({ projectId, seq }: { projectId: string; seq: number }) {
  const { data: story, error, reload } = useApi<UnitStory>(`/api/projects/${projectId}/units/${seq}/story`);
  const query = useQuery();
  const tab: HubTab = query.get("tab") === "agents" ? "agents" : query.get("tab") === "code" ? "code" : query.get("tab") === "manager" ? "manager" : "story";
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
  const running = story.entries.findLast((e) => e.attempt) ?? null;
  return (
    <main className="story">
      <div className="story-crumb mono">
        <Link to={`/p/${projectId}`}>{projectId}</Link> / U{u.seq} · {u.type}
        {u.repoId ? ` · ${u.repoId}` : ""}
      </div>
      <h1 className="serif story-title">
        <Inline text={u.goal} />
      </h1>
      {u.description && (
        <div className="story-why">
          {u.description.split("\n\n").map((para, i) => (
            <p key={i}>
              <Inline text={para} />
            </p>
          ))}
        </div>
      )}
      <div className="facts">
        <span className={`chip story-${u.state === "landed" ? "pine" : u.state === "blocked" ? "bell" : "amber"}`}>
          {u.state === "landed" && u.landedSha ? `landed ${u.landedSha.slice(0, 7)}` : u.state}
        </span>
        {story.tier && <span>{story.tier}</span>}
        {story.pr && (
          <a href={story.pr.url} target="_blank" rel="noreferrer">
            PR #{story.pr.number}
          </a>
        )}
        <span className="mono">${story.costUsd.toFixed(2)}</span>
        {story.started && (
          <span>
            {clock(story.started)}
            {story.ended ? ` → ${clock(story.ended)}` : ""}
          </span>
        )}
        {u.state === "running" && running?.attempt && <Link to={`/a/${running.attempt.id}`}>running now · watch it live</Link>}
      </div>
      <OpenGates gates={story.gates} reload={reload} />
      <div className="hub-tabs" role="tablist">
        {(
          [
            ["story", "Story", null],
            ["agents", "Agents", story.agents.length],
            ["code", "Code", u.repoId ? "" : null],
            ...(u.type === "work" ? ([["manager", "Manager", story.manager.length]] as const) : []),
          ] as const
        ).map(([k, label, n]) => (
          <Link
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "on" : ""}
            to={`/p/${projectId}/u/${u.seq}${k === "story" ? "" : `?tab=${k}`}`}
          >
            {label}
            {typeof n === "number" && <span className="hub-n">{n}</span>}
          </Link>
        ))}
      </div>
      {tab === "story" && (
        <>
          <div className="story-legend">
            <span>
              <span className="s-pine">✓</span> checked by yagura against runs it recorded
            </span>
            <span>· choice / note: judgment nobody checked</span>
          </div>
          <div className="story-ledger">
            {story.entries.map((e, i) => (
              <Entry key={`${e.at}-${i}`} story={story} entry={e} reload={reload} />
            ))}
            {!story.entries.length && <div className="muted">Nothing has happened on U{u.seq} yet.</div>}
          </div>
        </>
      )}
      {tab === "agents" && <AgentsTab story={story} />}
      {tab === "code" && <CodeTab story={story} />}
      {tab === "manager" && <ManagerTab story={story} />}
    </main>
  );
}
