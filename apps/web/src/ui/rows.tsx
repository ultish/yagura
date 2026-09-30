import { useState, type ReactNode } from "react";
import { api, navigate, useNow, type BellItem } from "../api";
import { ifUnanswered } from "../lib/gates";
import { Inline } from "../lib/markdown";
import { Link } from "./Link";

export function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<unknown>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    run: async (fn) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

export function Row({
  seq,
  goal,
  status,
  tone,
  facts,
  actions,
  extra,
}: {
  seq: ReactNode;
  goal: ReactNode;
  status?: ReactNode;
  tone?: string;
  facts?: ReactNode;
  actions?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="item">
      <span className="seq">{seq}</span>
      <div className="body">
        <div className="goal">{goal}</div>
        {status && <div className={`status s-${tone ?? "muted"}`}>{status}</div>}
        {facts && <div className="facts">{facts}</div>}
        {extra}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function NoteForm({
  label,
  placeholder,
  submit,
  onDone,
}: {
  label: string;
  placeholder: string;
  submit: (note: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const action = useAction();
  const id = `note-${label.replace(/\W+/g, "-")}`;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await submit(note);
          onDone();
        });
      }}
      style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        style={{ flexGrow: 1, minWidth: 240, background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "7px 10px" }}
      />
      <button className="btn sm lamp" type="submit" disabled={action.busy}>
        {label}
      </button>
      <button className="btn sm" type="button" onClick={onDone}>
        Never mind
      </button>
      {action.error && (
        <span className="s-bell" style={{ fontSize: 13, width: "100%" }}>
          {action.error}
        </span>
      )}
    </form>
  );
}

const threadOf = (question: string) => /thread (\d+)/.exec(question)?.[1] ?? null;

export function BellRow({ item, showProject }: { item: BellItem; showProject: boolean }) {
  const action = useAction();
  const now = useNow(30_000);
  const [retrying, setRetrying] = useState(false);
  const where = (projectId: string, seq?: number) => (showProject ? `${projectId}${seq ? ` · U${seq}` : ""}` : seq ? `U${seq}` : "");
  const answer = (id: number, a: string) => action.run(() => api(`/api/gates/${id}/answer`, { body: { answer: a } }));
  const error = action.error ? (
    <span className="s-bell" style={{ fontSize: 13 }}>
      {action.error}
    </span>
  ) : null;

  if (item.kind === "proposal")
    return (
      <Row
        seq={<Link to={`/talk/${item.threadId}`}>thread {item.threadId}</Link>}
        goal={<Inline text={item.summary} />}
        status={`Proposal ${item.proposalId} from “${item.threadTitle}” is waiting for Go.`}
        tone="bell"
        extra={error}
        actions={
          <>
            <button
              className="btn bell"
              type="button"
              disabled={action.busy}
              onClick={() => action.run(() => api(`/api/proposals/${item.proposalId}/apply`, { body: {} }))}
            >
              Go
            </button>
            <button className="btn" type="button" onClick={() => navigate(`/talk/${item.threadId}`)}>
              Open
            </button>
          </>
        }
      />
    );

  if (item.kind === "blocked")
    return (
      <Row
        seq={<Link to={`/p/${item.projectId}/u/${item.unit.seq}`}>{where(item.projectId, item.unit.seq)}</Link>}
        goal={<Inline text={item.unit.goal} />}
        status={<Inline text={`Blocked. ${item.reason ?? "No reason recorded."}`} />}
        tone="bell"
        facts={
          <span>
            {item.attempts} of {item.maxAttempts} tries used
          </span>
        }
        extra={
          <>
            {retrying && (
              <NoteForm
                label="Retry"
                placeholder="What should the next try do differently? (optional)"
                submit={(note) => api(`/api/projects/${item.projectId}/units/${item.unit.seq}/retry`, { body: { note } })}
                onDone={() => setRetrying(false)}
              />
            )}
            {error}
          </>
        }
        actions={
          !retrying && (
            <>
              <button className="btn" type="button" onClick={() => setRetrying(true)}>
                Retry with a note
              </button>
              <button
                className="btn"
                type="button"
                disabled={action.busy}
                onClick={() => action.run(() => api(`/api/projects/${item.projectId}/units/${item.unit.seq}/cancel`, { body: {} }))}
              >
                Cancel
              </button>
            </>
          )
        }
      />
    );

  const g = item.gate;
  const seq = item.unit ? (
    <Link to={`/p/${item.projectId}/u/${item.unit.seq}`}>{where(item.projectId, item.unit.seq)}</Link>
  ) : (
    <Link to={`/p/${item.projectId}`}>{showProject ? item.projectId : "project"}</Link>
  );
  const labels: Record<string, string> = { land: "Land", hold: "Hold", start: "Start", seen: "Seen" };
  const thread = g.kind === "report" ? threadOf(g.question) : null;
  const unanswered = ifUnanswered(g, now);
  // The default is the likely answer; with a hold default, the action it holds back is.
  const primary = g.kind === "report" || !g.defaultOption ? null : g.defaultOption === "hold" ? g.options[0] : g.defaultOption;
  return (
    <Row
      seq={seq}
      goal={<Inline text={item.unit?.goal ?? g.question} />}
      status={item.unit ? g.question : g.kind === "report" ? "Report posted in the conversation." : undefined}
      tone={g.kind === "report" ? "pine" : "bell"}
      facts={unanswered && <span>{unanswered}</span>}
      extra={error}
      actions={
        <>
          {thread && (
            <button className="btn" type="button" onClick={() => navigate(`/talk/${thread}`)}>
              Read
            </button>
          )}
          {g.options.map((o) => (
            <button key={o} className={`btn${o === primary ? " bell" : ""}`} type="button" disabled={action.busy} onClick={() => answer(g.id, o)}>
              {labels[o] ?? o}
            </button>
          ))}
        </>
      }
    />
  );
}
