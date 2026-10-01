import { useState } from "react";
import { api, useApi, type StoryEntry, type StoryLine, type UnitStory } from "../api";
import { clock, modelName } from "../lib/format";
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
                <b>{entry.who}</b> · U{a.unitSeq}.{a.n}
              </Link>
            ) : (
              <b>{entry.who}</b>
            )}
            {a && (
              <>
                {a.model && ` · ${modelName(a.model)}`} · ${a.costUsd.toFixed(2)}
              </>
            )}
          </span>
          {entry.status && <span className={`chip story-${entry.status.tone}`}>{entry.status.text}</span>}
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

export function Unit({ projectId, seq }: { projectId: string; seq: number }) {
  const { data: story, error, reload } = useApi<UnitStory>(`/api/projects/${projectId}/units/${seq}/story`);
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
    </main>
  );
}
