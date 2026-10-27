import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessagesSquare, PanelRight } from "lucide-react";
import { api, navigate, useApi, useQuery, type Proposal, type ProjectSummary, type Thread, type ThreadMessage, type ThreadView } from "../api";
import { atEnd } from "../lib/follow";
import { clock } from "../lib/format";
import { Inline, Markdown } from "../lib/markdown";
import { needsYou } from "../lib/scene";
import { hasStarted, startedBy } from "../lib/proposal-result";
import { PANELS, useMediaQuery } from "../lib/media";
import { Link } from "../ui/Link";
import { Slideout } from "../ui/Slideout";
import { MentionInput } from "../ui/MentionInput";
import { LiveTurnCalls, TurnCallsFor } from "../ui/TurnCalls";
import { useAction } from "../ui/rows";

const ROLE = {
  human: { label: "you", color: "var(--info)" },
  watchman: { label: "watchman", color: "var(--amber)" },
  system: { label: "yagura", color: "var(--pine)" },
} as const;

interface ProposalBody {
  summary: string;
  repos?: { id: string; description?: string; existing?: string; forge?: string; land?: string }[];
  environments?: (
    | { id: string; template: string; answers?: Record<string, string> }
    | { id: string; provider?: string; capacity?: number; presets?: string[]; values?: { name: string; value: string }[] }
  )[];
  projects?: {
    id: string;
    goal: string;
    predicate: string;
    merge?: string;
    minTier?: string;
    after?: string[];
    environment?: string | null;
    units?: { key: string; title?: string; goal: string }[];
  }[];
  amend?: { project: string; units: { key: string; title?: string; goal: string }[] }[];
}

function Outcome({ result }: { result: unknown }) {
  const s = startedBy(result);
  if (!hasStarted(s)) return null;
  return (
    <div className="facts" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line2)" }}>
      <span>Started:</span>
      {s.projects.map((id) => (
        <Link key={`p${id}`} to={`/p/${id}`}>
          project {id}
        </Link>
      ))}
      {s.units.map((u) => (
        <Link key={`u${u.project}${u.seq}`} to={`/p/${u.project}/u/${u.seq}`}>
          {u.project} U{u.seq}
        </Link>
      ))}
      {s.environments.map((id) => (
        <Link key={`e${id}`} to={`/e/${id}`}>
          environment {id}
        </Link>
      ))}
      {s.repos.map((id) => (
        <Link key={`r${id}`} to={`/repos#${id}`}>
          repo {id}
        </Link>
      ))}
    </div>
  );
}

function ProposalCard({ p, onEdit }: { p: Proposal & { routes?: Record<string, { text: string; ok: boolean }> }; onEdit: (text: string) => void }) {
  const action = useAction();
  const body = p.body as ProposalBody;
  const pending = p.state === "pending";
  const tone = pending ? "var(--bad-border)" : p.state === "applied" ? "var(--ok-border)" : "var(--btnline)";
  return (
    <div style={{ marginTop: 12, border: `1px solid ${tone}`, borderRadius: 6, padding: "14px 16px", background: "var(--bg)" }}>
      <div className="mono" style={{ fontSize: 12, color: pending ? "var(--bell-text)" : p.state === "applied" ? "var(--pine)" : "var(--muted)" }}>
        PROPOSAL {p.id} · {pending ? "WAITING FOR YOU" : p.state.toUpperCase()}
      </div>
      <div style={{ fontSize: 15, marginTop: 6 }}>
        <Inline text={body.summary} />
      </div>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 14, display: "flex", flexDirection: "column", gap: 4 }}>
        {body.repos?.map((r) => (
          <li key={`r${r.id}`}>
            {r.existing ? "existing" : "new"} repo <span className="mono">{r.id}</span>
            {r.existing ? `: ${r.existing}` : r.description ? `: ${r.description}` : ""}
            {r.forge ? ` · forge ${r.forge}` : r.land === "push" ? " · pushes to its default branch" : ""}
          </li>
        ))}
        {body.environments?.map((e) => (
          <li key={`e${e.id}`}>
            environment <span className="mono">{e.id}</span>
            {"template" in e ? (
              <>
                {" "}
                from template <span className="mono">{e.template}</span>
                {e.answers && Object.keys(e.answers).length ? (
                  <div className="facts" style={{ marginTop: 2 }}>
                    {Object.entries(e.answers).map(([k, v]) => (
                      <span key={k} className="mono">
                        {k}={v}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                {" "}
                ({e.provider ?? "local-process"}, {e.capacity ?? 1} {(e.capacity ?? 1) === 1 ? "slot" : "slots"})
                <div className="facts" style={{ marginTop: 2 }}>
                  {e.values?.map((v) => (
                    <span key={v.name} className="mono">
                      {v.name}={v.value}
                    </span>
                  ))}
                  {e.presets?.map((p) => (
                    <span key={p}>preset {p}</span>
                  ))}
                </div>
              </>
            )}
          </li>
        ))}
        {body.projects?.map((pr) => (
          <li key={`p${pr.id}`}>
            project <b>{pr.id}</b>: <Inline text={pr.goal} />
            <div className="facts" style={{ marginTop: 2 }}>
              <span>
                done when: <Inline text={pr.predicate} />
              </span>
              <span>merge {pr.merge ?? "human"}</span>
              {p.routes?.[pr.id] && <span className={p.routes[pr.id]!.ok ? undefined : "s-bell"}>{p.routes[pr.id]!.text}</span>}
              <span>≥ {pr.minTier ?? "unit-verified"}</span>
              {pr.after?.length ? <span>after {pr.after.join(", ")}</span> : null}
              {pr.units?.length ? <span>{pr.units.length} starting units</span> : null}
            </div>
          </li>
        ))}
        {body.amend?.map((a) =>
          a.units.map((u) => (
            <li key={`a${a.project}${u.key}`}>
              {a.project} + <Inline text={u.title ?? u.goal} />
            </li>
          )),
        )}
      </ul>
      {p.state === "applied" && <Outcome result={p.result} />}
      {p.state === "failed" && (
        <div className="s-bell" style={{ fontSize: 13, marginTop: 8 }}>
          {String((p.result as { error?: string } | null)?.error ?? "failed")}
        </div>
      )}
      {pending && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn bell" type="button" disabled={action.busy} onClick={() => action.run(() => api(`/api/proposals/${p.id}/apply`, { body: {} }))}>
            Go
          </button>
          <button className="btn" type="button" onClick={() => onEdit(`About proposal ${p.id}: `)}>
            Edit
          </button>
          <button className="btn" type="button" disabled={action.busy} onClick={() => action.run(() => api(`/api/proposals/${p.id}/discard`, { body: {} }))}>
            Discard
          </button>
        </div>
      )}
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13, marginTop: 8 }}>
          {action.error}
        </div>
      )}
    </div>
  );
}

function Message({
  m,
  proposals,
  known,
  queued,
  target,
  onEdit,
}: {
  target: boolean;
  m: ThreadMessage;
  proposals: Proposal[];
  known: ReadonlySet<string>;
  queued: boolean;
  onEdit: (t: string) => void;
}) {
  const r = ROLE[m.role];
  return (
    <div
      id={`m${m.id}`}
      className="talk-msg"
      style={{
        padding: "14px 0",
        borderTop: "1px solid var(--line2)",
        ...(target ? { boxShadow: "inset 3px 0 0 var(--lamp)", paddingLeft: 12, background: "var(--mention-bg)" } : {}),
      }}
    >
      <div className="mono talk-msg-who" style={{ fontSize: 12, color: r.color, paddingTop: 3 }}>
        {r.label}
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
          {clock(m.createdAt)}
        </div>
        {queued && (
          <div style={{ fontSize: 11, marginTop: 3, color: "var(--amber)" }} title="Sent while the watchman was replying; it is answered right after this turn">
            queued
          </div>
        )}
      </div>
      <div className="talk-msg-body" style={{ fontSize: 15, lineHeight: 1.55, color: m.role === "system" ? "var(--soft)" : "var(--text)" }}>
        {m.role === "watchman" && m.turnLog && <TurnCallsFor messageId={m.id} />}
        <Markdown text={m.body} known={known} />
        {proposals.map((p) => (
          <ProposalCard key={p.id} p={p} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
}

// An open conversation is alive (a filled lamp); a closed one is history (an empty ring).
function StateDot({ open }: { open: boolean }) {
  return (
    <span
      role="img"
      aria-label={open ? "open" : "closed"}
      style={{
        flexShrink: 0,
        width: 8,
        height: 8,
        borderRadius: 4,
        boxSizing: "border-box",
        background: open ? "var(--lamp)" : "transparent",
        border: open ? 0 : "1.5px solid var(--faint)",
      }}
    />
  );
}

function ThreadList({ current, bare }: { current: number | null; bare?: boolean }) {
  const threads = useApi<(Thread & { busy: boolean })[]>("/api/threads");
  const list = threads.data ?? [];
  const section = (title: string, items: typeof list) =>
    items.length > 0 && (
      <>
        <div className="mono muted" style={{ fontSize: 11.5, padding: "12px 8px 6px" }}>
          {title} · {items.length}
        </div>
        {items.map((t) => (
          <Link
            key={t.id}
            to={`/talk/${t.id}`}
            aria-current={t.id === current ? "page" : undefined}
            style={{
              display: "block",
              textDecoration: "none",
              color: t.state === "open" ? "var(--text)" : "var(--muted)",
              background: t.id === current ? "var(--panel)" : "transparent",
              borderRadius: 4,
              padding: "9px 10px",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 14 }}>
              <StateDot open={t.state === "open"} />
              <span>{t.title}</span>
            </div>
            <div className="mono muted" style={{ fontSize: 11.5, marginTop: 2, paddingLeft: 16 }}>
              {t.busy ? "replying…" : t.projects.join(", ") || "no projects"}
            </div>
          </Link>
        ))}
      </>
    );
  return (
    <nav aria-label="Conversations" className={bare ? "talk-bare" : "talk-side talk-list"}>
      <button className="btn lamp" type="button" onClick={() => navigate("/talk")} style={{ marginBottom: 6 }}>
        New conversation
      </button>
      {section(
        "OPEN",
        list.filter((t) => t.state === "open"),
      )}
      {section(
        "CLOSED",
        list.filter((t) => t.state !== "open"),
      )}
    </nav>
  );
}

function ThreadControls({ threadId, v, busy, onChanged }: { threadId: number; v: ThreadView; busy: boolean; onChanged: () => void }) {
  const autonomy = useAction();
  const session = useAction();
  const open = v.thread.state === "open";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 className="h2">Conversation</h2>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span className="mono muted" style={{ fontSize: 12 }}>
          autonomy
        </span>
        <span
          role="radiogroup"
          aria-label="Autonomy"
          style={{ display: "inline-flex", border: "1px solid var(--btnline)", borderRadius: 999, overflow: "hidden" }}
        >
          {(["propose", "go"] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={v.thread.autonomy === a}
              title={a === "go" ? "Apply the watchman's proposals without waiting for Go" : "Nothing starts until you say Go"}
              disabled={autonomy.busy}
              onClick={() =>
                autonomy.run(async () => {
                  await api(`/api/threads/${threadId}/autonomy`, { body: { autonomy: a } });
                  onChanged();
                })
              }
              className="mono"
              style={{
                fontSize: 12,
                border: 0,
                padding: "4px 10px",
                cursor: "pointer",
                background: v.thread.autonomy === a ? "var(--lamp)" : "transparent",
                color: v.thread.autonomy === a ? "#141018" : "var(--muted)",
              }}
            >
              {a}
            </button>
          ))}
        </span>
      </div>
      {v.session && (
        <span
          className="mono muted"
          style={{ fontSize: 12 }}
          title="The watchman's context at its last turn; a new session starts when it passes the roll point"
        >
          session · {Math.round(v.session.contextPeak / 1000)}k of {Math.round(v.session.rollAt / 1000)}k
        </span>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn sm"
          disabled={!v.session || busy || session.busy}
          title="Start the watchman fresh from yagura's records on the next message. Decisions, questions, spec, and messages stay. Typing /clear does the same."
          onClick={() =>
            session.run(async () => {
              await api(`/api/threads/${threadId}/clear`, { body: {} });
              onChanged();
            })
          }
        >
          New session
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={session.busy}
          title={
            open
              ? "Move this conversation to Closed. It stays as history, and writing in it again reopens it. A reply in progress is stopped."
              : "Move this conversation back to Open."
          }
          onClick={() =>
            session.run(async () => {
              await api(`/api/threads/${threadId}/state`, { body: { state: open ? "closed" : "open" } });
              onChanged();
            })
          }
        >
          {open ? "Close" : "Reopen"}
        </button>
      </div>
      <Link
        to="/prompts?role=watchman"
        className="mono"
        style={{ fontSize: 12 }}
        title="The guidance the watchman follows in every conversation; edit it there"
      >
        watchman's guidance →
      </Link>
      {(autonomy.error || session.error) && (
        <span className="s-bell" style={{ fontSize: 13 }}>
          {autonomy.error ?? session.error}
        </span>
      )}
    </div>
  );
}

function Ledger({ v, controls, bare }: { v: ThreadView; controls: ReactNode; bare?: boolean }) {
  const active = v.decisions.filter((d) => d.supersededBy === null).length;
  const open = v.questions.filter((q) => q.answer === null);
  const started = v.proposals
    .filter((p) => p.state === "applied")
    .flatMap((p) => startedBy(p.result).units)
    .filter((u, i, all) => all.findIndex((x) => x.project === u.project && x.seq === u.seq) === i);
  const dot = (s: ProjectSummary) =>
    needsYou(s) ? "var(--bell)" : s.running || s.planning ? "var(--lamp)" : s.project.state === "closed" ? "var(--pine)" : "var(--beacon-off-line)";
  return (
    <aside aria-label="Thread records" className={bare ? "talk-bare talk-bare-ledger" : "talk-side talk-ledger"}>
      {controls}
      <div>
        <h2 className="h2">Projects</h2>
        {v.projects.length === 0 && <div className="empty">None yet. Say Go on a proposal.</div>}
        {v.projects.map((s) => (
          <Link
            key={s.project.id}
            to={`/p/${s.project.id}`}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              padding: "8px 0",
              borderTop: "1px solid var(--line2)",
              textDecoration: "none",
              color: "var(--text)",
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 5, background: dot(s), flexShrink: 0 }} />
            <span className="mono" style={{ fontSize: 13 }}>
              {s.project.id}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {s.project.state === "active" ? `${s.running} running · ${s.workCounts.landed ?? 0} landed` : s.project.state}
            </span>
          </Link>
        ))}
      </div>
      {started.length > 0 && (
        <div>
          <h2 className="h2">Units started</h2>
          {started.map((u) => (
            <Link
              key={`${u.project}${u.seq}`}
              to={`/p/${u.project}/u/${u.seq}`}
              className="mono"
              style={{ display: "block", padding: "6px 0", borderTop: "1px solid var(--line2)", fontSize: 13 }}
            >
              {u.project} U{u.seq}
            </Link>
          ))}
        </div>
      )}
      <div>
        <div className="gh">
          <h2 className="h2">Decisions</h2>
          <span className="n">
            {active} active{v.decisions.length > active ? ` · ${v.decisions.length - active} superseded` : ""}
          </span>
        </div>
        <div style={{ borderTop: "1px solid var(--line2)", paddingTop: 4 }}>
          {v.decisions.length === 0 && (
            <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>
              Nothing settled yet.
            </div>
          )}
          {v.decisions.map((d) => {
            const sup = d.supersededBy !== null;
            return (
              <div
                key={d.id}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "5px 0",
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: sup ? "var(--faint)" : "var(--text)",
                  textDecoration: sup ? "line-through" : "none",
                }}
              >
                <span className="mono" style={{ fontSize: 12, color: sup ? "var(--faint)" : "var(--amber)", width: 34, flexShrink: 0 }}>
                  D{d.id}
                </span>
                <span>{d.text}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="gh">
          <h2 className="h2">Open questions</h2>
          <span className="n">{open.length}</span>
        </div>
        {open.map((q) => (
          <div key={q.id} style={{ display: "flex", gap: 10, padding: "5px 0", fontSize: 13, borderTop: "1px solid var(--line2)" }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--bell-text)", width: 34, flexShrink: 0 }}>
              Q{q.id}
            </span>
            <span>{q.text}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Composer({
  threadId,
  busy,
  initial,
  draftKey,
  onSent,
}: {
  threadId: number | null;
  busy: boolean;
  initial: string;
  draftKey: number;
  onSent: () => void;
}) {
  const [text, setText] = useState(initial);
  const action = useAction();
  // A touch screen would open its keyboard the moment the page loads.
  const touch = useMediaQuery("(pointer: coarse)");
  useEffect(() => {
    setText(initial);
  }, [initial, draftKey]);
  const send = () =>
    action.run(async () => {
      if (threadId === null) {
        const r = await api<{ thread: Thread }>("/api/threads", { body: { message: text } });
        navigate(`/talk/${r.thread.id}`);
      } else await api(`/api/threads/${threadId}/messages`, { body: { message: text } });
      setText("");
      onSent();
    });
  return (
    <div style={{ padding: "14px var(--talk-pad) 20px", borderTop: "1px solid var(--line)", position: "sticky", bottom: 0, background: "var(--bg2)" }}>
      {busy && (
        <div className="mono" style={{ fontSize: 12, color: "var(--amber)", display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span className="pulse" style={{ width: 8, height: 8, borderRadius: 4, background: "var(--lamp)" }} />
          the watchman is replying… messages you send now are answered next
        </div>
      )}
      <MentionInput
        value={text}
        onChange={setText}
        onSubmit={() => void send()}
        label="Message the watchman"
        placeholder="Message the watchman"
        disabled={action.busy}
        autoFocus={!touch}
      />
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13, marginTop: 6 }}>
          {action.error}
        </div>
      )}
    </div>
  );
}

const SHOWN = 40;

export function Talk({ threadId }: { threadId: number | null }) {
  const query = useQuery();
  const say = query.get("say") ?? "";
  const view = useApi<ThreadView>(threadId === null ? null : `/api/threads/${threadId}`);
  const narrow = useMediaQuery(PANELS);
  const [panel, setPanel] = useState<"list" | "records" | null>(null);
  useEffect(() => setPanel(null), [threadId, narrow]);
  const busy = view.data?.busy ?? false;
  const projects = useApi<ProjectSummary[]>("/api/projects");
  const known = useMemo(() => new Set((projects.data ?? []).map((p) => p.project.id as string)), [projects.data]);
  const [draft, setDraft] = useState({ text: say, key: 0 });
  const [all, setAll] = useState(false);
  const column = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // A link to one message (from search) opens the thread at that message, not at its end.
  const target = Number(query.get("m")) || null;
  const loaded = !!view.data;
  // The page scrolls, not the column: going to the page's end puts the composer below the last line instead of over it.
  const toEnd = () => window.scrollTo({ top: document.documentElement.scrollHeight });
  useEffect(() => {
    const onScroll = () => {
      following.current = atEnd({ scrollY: window.scrollY, viewport: window.innerHeight, height: document.documentElement.scrollHeight });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Every growth of the conversation (a reply, the watchman's live calls, a proposal) keeps the end in view while the reader follows it.
  useEffect(() => {
    following.current = !target;
    if (target || !loaded || !column.current) return;
    toEnd();
    const watch = new ResizeObserver(() => following.current && toEnd());
    watch.observe(column.current);
    return () => watch.disconnect();
  }, [threadId, target, loaded]);
  // New data follows too: a background tab draws no frames, so the size watcher alone would only catch up when it is shown.
  useLayoutEffect(() => {
    if (following.current && !target) toEnd();
  }, [view.data, target]);
  useEffect(() => {
    if (target && loaded) document.getElementById(`m${target}`)?.scrollIntoView({ block: "center" });
  }, [target, loaded]);
  useEffect(() => {
    setDraft({ text: say, key: Date.now() });
  }, [say, threadId]);

  const v = view.data;
  const older = target !== null && v !== null && !v.messages.slice(-SHOWN).some((m) => m.id === target);
  const messages = v ? (all || older ? v.messages : v.messages.slice(-SHOWN)) : [];
  return (
    <main className="talk">
      {!narrow && <ThreadList current={threadId} />}
      <section style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg2)" }}>
        {narrow && (
          <div className="talk-bar">
            <button type="button" className="btn sm talk-bar-btn" aria-haspopup="dialog" onClick={() => setPanel("list")}>
              <MessagesSquare size={16} strokeWidth={1.75} aria-hidden="true" />
              Conversations
            </button>
            {v && (
              <button type="button" className="btn sm talk-bar-btn" aria-haspopup="dialog" onClick={() => setPanel("records")}>
                <PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />
                Records
              </button>
            )}
          </div>
        )}
        {threadId === null ? (
          <div style={{ padding: "28px var(--talk-pad)", flexGrow: 1 }}>
            <h1 className="serif" style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>
              Talk to the watch
            </h1>
            <p className="muted" style={{ maxWidth: 640, fontSize: 15, lineHeight: 1.6 }}>
              Describe what you want built or changed. The watchman asks only what it must, records every decision, and proposes projects for you to start with.
              Mention anything with @: a project, a unit like @orders/U3, one agent run like @orders/A7, a thread, or a repo.
            </p>
          </div>
        ) : (
          <>
            <div
              style={{
                padding: "18px var(--talk-pad) 12px",
                display: "flex",
                alignItems: "baseline",
                gap: 14,
                borderBottom: "1px solid var(--line)",
                flexWrap: "wrap",
              }}
            >
              <h1 className="serif" style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>
                {v?.thread.title ?? "…"}
              </h1>
              <span className="mono muted" style={{ fontSize: 12 }}>
                thread {threadId}
              </span>
              {v && (
                <span
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    padding: "1px 9px",
                    borderRadius: 999,
                    border: `1px solid ${v.thread.state === "open" ? "var(--lamp)" : "var(--faint)"}`,
                    color: v.thread.state === "open" ? "var(--amber-text)" : "var(--muted)",
                  }}
                >
                  {v.thread.state === "open" ? "open" : "closed"}
                </span>
              )}
            </div>
            {v && v.thread.state !== "open" && (
              <div
                className="muted"
                style={{ padding: "8px var(--talk-pad)", fontSize: 13, background: "var(--panel)", borderBottom: "1px solid var(--line)" }}
              >
                This conversation is closed and kept as history. Writing in it reopens it.
              </div>
            )}
            <div ref={column} style={{ flexGrow: 1, padding: "0 var(--talk-pad)" }}>
              {view.error && (
                <div className="s-bell" style={{ padding: "12px 0" }}>
                  {view.error}
                </div>
              )}
              {v && v.messages.length > messages.length && (
                <button
                  type="button"
                  className="mono"
                  onClick={() => setAll(true)}
                  style={{ fontSize: 11.5, padding: "10px 0", background: "none", border: 0, color: "var(--amber)", cursor: "pointer" }}
                >
                  {v.messages.length - messages.length} earlier messages · show
                </button>
              )}
              {messages.map((m) => (
                <Fragment key={m.id}>
                  {v!.sessionStarts.indexOf(m.id) > 0 && (
                    <div className="mono muted session-mark" role="separator">
                      new session
                    </div>
                  )}
                  <Message
                    m={m}
                    target={m.id === target}
                    proposals={v!.proposals.filter((p) => p.messageId === m.id)}
                    known={known}
                    queued={v!.queued.includes(m.id)}
                    onEdit={(t) => setDraft({ text: t, key: Date.now() })}
                  />
                </Fragment>
              ))}
              {busy && threadId !== null && (
                <div style={{ display: "flex", gap: 16, padding: "14px 0", borderTop: "1px solid var(--line2)" }}>
                  <div style={{ width: 86, flexShrink: 0 }} />
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <LiveTurnCalls threadId={threadId} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        <Composer
          threadId={threadId}
          busy={busy}
          initial={draft.text}
          draftKey={draft.key}
          onSent={() => {
            following.current = true;
            toEnd();
          }}
        />
      </section>
      {!narrow &&
        (v ? (
          <Ledger v={v} controls={<ThreadControls threadId={threadId!} v={v} busy={busy} onChanged={view.reload} />} />
        ) : (
          <aside aria-hidden className="talk-side talk-ledger" />
        ))}
      {narrow && (
        <>
          <Slideout open={panel === "list"} onClose={() => setPanel(null)} label="Conversations" side="left">
            <ThreadList current={threadId} bare />
          </Slideout>
          {v && (
            <Slideout open={panel === "records"} onClose={() => setPanel(null)} label="Records" side="right">
              <Ledger v={v} controls={<ThreadControls threadId={threadId!} v={v} busy={busy} onChanged={view.reload} />} bare />
            </Slideout>
          )}
        </>
      )}
    </main>
  );
}
