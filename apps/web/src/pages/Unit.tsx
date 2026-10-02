import { useState } from "react";
import { api, useApi, useQuery, type StoryEntry, type StoryLine, type UnitCode, type UnitStory } from "../api";
import { clip, clock, duration, modelName } from "../lib/format";
import { Inline } from "../lib/markdown";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";

const JUDGMENT: Record<string, string> = { chose: "choice", noted: "note" };
const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "7px 10px", fontSize: 14, width: "100%" } as const;

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
  const [ref, setRef] = useState(first.ref);
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<"follow-up" | "note">("follow-up");
  const save = useAction();
  const id = `disagree-${entry.lines[0]!.ref}`;
  return (
    <form
      className="story-form"
      onSubmit={(e) => {
        e.preventDefault();
        const about = entry.lines.find((l) => l.ref === ref)!.text;
        void save.run(async () => {
          await api(`/api/projects/${projectId}/units/${seq}/disagreements`, { body: { ref, about, reason, action } });
          onDone();
        });
      }}
    >
      <fieldset>
        <legend>About which part?</legend>
        {entry.lines.map((l) => (
          <label key={l.ref} className="story-choice">
            <input type="radio" name={`${id}-about`} checked={ref === l.ref} onChange={() => setRef(l.ref)} />
            <span>
              <Inline text={l.text} />
            </span>
          </label>
        ))}
      </fieldset>
      <label className="story-field">
        Why
        <textarea
          id={`${id}-why`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          rows={3}
          placeholder="What is wrong, in your words. It is kept with the decision and shown to the agents that act on it."
          style={field}
        />
      </label>
      <fieldset>
        <legend>What should happen</legend>
        <label className="story-choice">
          <input type="radio" name={`${id}-then`} checked={action === "follow-up"} onChange={() => setAction("follow-up")} />
          <span>Plan a follow-up unit that fixes it forward (trunk is never rewritten)</span>
        </label>
        <label className="story-choice">
          <input type="radio" name={`${id}-then`} checked={action === "note"} onChange={() => setAction("note")} />
          <span>Only record it: later verifiers of this repo read it as context</span>
        </label>
      </fieldset>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm lamp" type="submit" disabled={save.busy || !reason.trim()}>
          Record disagreement
        </button>
        <button className="btn sm" type="button" onClick={onDone}>
          Cancel
        </button>
        {save.error && <span className="s-bell">{save.error}</span>}
      </div>
    </form>
  );
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
            {a ? (
              <Link to={`/p/${story.projectId}/u/${a.unitSeq}/${a.n}`}>
                <b>{entry.who}</b>
                {entry.actor !== "person" && ` · U${a.unitSeq}.${a.n}`}
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
            <Link className="story-open" to={`/p/${story.projectId}/u/${a.unitSeq}/${a.n}`}>
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
            <button className="btn sm story-disagree" type="button" onClick={() => setOpen(true)}>
              Disagree
            </button>
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
            <th>Started</th>
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
                <Link to={`/p/${story.projectId}/u/${a.unitSeq}/${a.n}`}>
                  {a.role} U{a.unitSeq}.{a.n}
                </Link>
                {a.shared && <div className="muted hub-small">also planned other units</div>}
              </td>
              <td className="mono">{clock(a.startedAt)}</td>
              <td className="mono">{a.startedAt && a.endedAt ? duration(Date.parse(a.endedAt) - Date.parse(a.startedAt)) : "—"}</td>
              <td className="num mono">${a.costUsd.toFixed(2)}</td>
              <td>
                <span className={`chip story-${a.tone}`}>{a.counted || a.outcome === "running" ? a.outcome : `${a.outcome} · not counted`}</span>
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

function CodeTab({ story }: { story: UnitStory }) {
  const u = story.unit;
  const { data, error } = useApi<{ code: UnitCode | null }>(u.repoId ? `/api/projects/${story.projectId}/units/${u.seq}/code` : null);
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
      <div className="hub-files">
        {code.files.map((f) => (
          <div key={f} className="hub-file mono">
            {code.source === "landed" ? <Link to={editor(`file=${encodeURIComponent(f)}&`)}>{f}</Link> : <span>{f}</span>}
            <span className="s-pine">+{code.stats[f]?.added ?? 0}</span>
            <span className="s-bell">−{code.stats[f]?.removed ?? 0}</span>
          </div>
        ))}
      </div>
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
      <div className="repo-diff mono hub-diff">
        {code.diff
          .split("\n")
          .filter((l) => !l.startsWith("index ") && !l.startsWith("+++ ") && !l.startsWith("--- "))
          .map((l, i) => {
            const cls = l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
            return (
              <div key={i} className={`repo-diff-row ${cls}`}>
                {cls === "file" ? l.replace(/^diff --git a\/(\S+).*/, "$1") : l || " "}
              </div>
            );
          })}
        {code.truncated && <div className="muted repo-pad">The rest of this change is too large to show.</div>}
      </div>
    </div>
  );
}

type HubTab = "story" | "agents" | "code";

export function Unit({ projectId, seq }: { projectId: string; seq: number }) {
  const { data: story, error, reload } = useApi<UnitStory>(`/api/projects/${projectId}/units/${seq}/story`);
  const query = useQuery();
  const tab: HubTab = query.get("tab") === "agents" ? "agents" : query.get("tab") === "code" ? "code" : "story";
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
        {u.state === "running" && running?.attempt && (
          <Link to={`/p/${projectId}/u/${running.attempt.unitSeq}/${running.attempt.n}`}>running now · watch it live</Link>
        )}
      </div>
      <div className="hub-tabs" role="tablist">
        {(
          [
            ["story", "Story", null],
            ["agents", "Agents", story.agents.length],
            ["code", "Code", u.repoId ? "" : null],
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
    </main>
  );
}
