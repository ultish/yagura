import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, navigate, useApi, useQuery, type Proposal, type ProjectSummary, type Thread, type ThreadMessage, type ThreadView } from "../api";
import { clock } from "../lib/format";
import { Inline, Markdown } from "../lib/markdown";
import { needsYou } from "../lib/scene";
import { Link } from "../ui/Link";
import { MentionInput } from "../ui/MentionInput";
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
    units?: { key: string; goal: string }[];
  }[];
  amend?: { project: string; units: { key: string; goal: string }[] }[];
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
              {a.project} + <Inline text={u.goal} />
            </li>
          )),
        )}
      </ul>
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

function Message({ m, proposals, known, onEdit }: { m: ThreadMessage; proposals: Proposal[]; known: ReadonlySet<string>; onEdit: (t: string) => void }) {
  const r = ROLE[m.role];
  return (
    <div style={{ display: "flex", gap: 16, padding: "14px 0", borderTop: "1px solid var(--line2)" }}>
      <div className="mono" style={{ width: 86, flexShrink: 0, fontSize: 12, color: r.color, paddingTop: 3 }}>
        {r.label}
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
          {clock(m.createdAt)}
        </div>
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, fontSize: 15, lineHeight: 1.55, color: m.role === "system" ? "var(--soft)" : "var(--text)" }}>
        <Markdown text={m.body} known={known} />
        {proposals.map((p) => (
          <ProposalCard key={p.id} p={p} onEdit={onEdit} />
        ))}
      </div>
    </div>
  );
}

function ThreadList({ current }: { current: number | null }) {
  const threads = useApi<(Thread & { busy: boolean })[]>("/api/threads");
  const list = threads.data ?? [];
  const section = (title: string, items: typeof list) =>
    items.length > 0 && (
      <>
        <div className="mono muted" style={{ fontSize: 11.5, padding: "12px 8px 6px" }}>
          {title}
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
            <div style={{ fontSize: 14 }}>{t.title}</div>
            <div className="mono muted" style={{ fontSize: 11.5, marginTop: 2 }}>
              {t.busy ? "replying…" : t.projects.join(", ") || "no projects"}
            </div>
          </Link>
        ))}
      </>
    );
  return (
    <nav
      aria-label="Conversations"
      style={{
        width: 250,
        flexShrink: 0,
        borderRight: "1px solid var(--line)",
        padding: "18px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        position: "sticky",
        top: 0,
        alignSelf: "flex-start",
        maxHeight: "100vh",
        overflowY: "auto",
      }}
    >
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

function Ledger({ v }: { v: ThreadView }) {
  const active = v.decisions.filter((d) => d.supersededBy === null).length;
  const open = v.questions.filter((q) => q.answer === null);
  const dot = (s: ProjectSummary) =>
    needsYou(s) ? "var(--bell)" : s.running || s.planning ? "var(--lamp)" : s.project.state === "closed" ? "var(--pine)" : "var(--beacon-off-line)";
  return (
    <aside
      aria-label="Thread records"
      style={{
        width: 360,
        flexShrink: 0,
        borderLeft: "1px solid var(--line)",
        padding: "18px 22px 48px",
        display: "flex",
        flexDirection: "column",
        gap: 22,
        position: "sticky",
        top: 0,
        alignSelf: "flex-start",
        maxHeight: "100vh",
        overflowY: "auto",
      }}
    >
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

function Composer({ threadId, busy, initial, draftKey }: { threadId: number | null; busy: boolean; initial: string; draftKey: number }) {
  const [text, setText] = useState(initial);
  const action = useAction();
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
    });
  return (
    <div style={{ padding: "14px 32px 20px", borderTop: "1px solid var(--line)", position: "sticky", bottom: 0, background: "var(--bg2)" }}>
      {busy && (
        <div className="mono" style={{ fontSize: 12, color: "var(--amber)", display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span className="pulse" style={{ width: 8, height: 8, borderRadius: 4, background: "var(--lamp)" }} />
          the watchman is reading the records and replying…
        </div>
      )}
      <MentionInput
        value={text}
        onChange={setText}
        onSubmit={() => void send()}
        label="Message the watchman"
        placeholder="Message the watchman"
        disabled={action.busy || busy}
        autoFocus
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
  const busy = view.data?.busy ?? false;
  const projects = useApi<ProjectSummary[]>("/api/projects");
  const known = useMemo(() => new Set((projects.data ?? []).map((p) => p.project.id as string)), [projects.data]);
  const [draft, setDraft] = useState({ text: say, key: 0 });
  const [all, setAll] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const count = view.data?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, threadId]);
  useEffect(() => {
    setDraft({ text: say, key: Date.now() });
  }, [say, threadId]);
  const autonomy = useAction();
  const session = useAction();

  const v = view.data;
  const messages = v ? (all ? v.messages : v.messages.slice(-SHOWN)) : [];
  return (
    <main style={{ display: "flex", minHeight: "calc(100vh - 61px)" }}>
      <ThreadList current={threadId} />
      <section style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg2)" }}>
        {threadId === null ? (
          <div style={{ padding: "28px 32px", flexGrow: 1 }}>
            <h1 className="serif" style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>
              Talk to the watch
            </h1>
            <p className="muted" style={{ maxWidth: 640, fontSize: 15, lineHeight: 1.6 }}>
              Describe what you want built or changed. The watchman asks only what it must, records every decision, and proposes projects for you to start with
              Go. Mention anything with @: a project, a unit like @orders/U3, one agent run like @orders/U3.2, a thread, or a repo.
            </p>
          </div>
        ) : (
          <>
            <div
              style={{ padding: "18px 32px 12px", display: "flex", alignItems: "baseline", gap: 14, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}
            >
              <h1 className="serif" style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>
                {v?.thread.title ?? "…"}
              </h1>
              <span className="mono muted" style={{ fontSize: 12 }}>
                thread {threadId} · autonomy
              </span>
              {v && (
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
                      onClick={() => autonomy.run(() => api(`/api/threads/${threadId}/autonomy`, { body: { autonomy: a } }))}
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
              )}
              {v && (
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10, alignItems: "baseline" }}>
                  {v.session && (
                    <span
                      className="mono muted"
                      style={{ fontSize: 12 }}
                      title="The watchman's context at its last turn; a new session starts when it passes the roll point"
                    >
                      session · {Math.round(v.session.contextPeak / 1000)}k of {Math.round(v.session.rollAt / 1000)}k
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!v.session || busy || session.busy}
                    title="Start the watchman fresh from yagura's records on the next message. Decisions, questions, spec, and messages stay. Typing /clear does the same."
                    onClick={() => session.run(() => api(`/api/threads/${threadId}/clear`, { body: {} }))}
                  >
                    New session
                  </button>
                </span>
              )}
            </div>
            <div style={{ flexGrow: 1, padding: "0 32px" }}>
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
                    proposals={v!.proposals.filter((p) => p.messageId === m.id)}
                    known={known}
                    onEdit={(t) => setDraft({ text: t, key: Date.now() })}
                  />
                </Fragment>
              ))}
              <div ref={bottom} />
            </div>
          </>
        )}
        <Composer threadId={threadId} busy={busy} initial={draft.text} draftKey={draft.key} />
      </section>
      {v && <Ledger v={v} />}
    </main>
  );
}
