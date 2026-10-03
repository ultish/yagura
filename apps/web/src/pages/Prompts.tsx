import { useEffect, useState } from "react";
import { api, useApi, useQuery, type AttemptDetail } from "../api";
import { lineDiff } from "../lib/linediff";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";

type Source = "default" | "global" | "project";
interface RolePrompt {
  role: string;
  default: string;
  global: string | null;
  project: string | null;
  source: Source;
  sha: string;
  notes: string | null;
  lastAttemptId: number | null;
  followUps: { when: string; text: string }[];
}
interface PromptsView {
  projectId: string | null;
  allNotes: string | null;
  roles: RolePrompt[];
}

const LABEL: Record<string, string> = {
  planner: "Planner",
  worker: "Worker",
  verifier: "Verifier",
  reviewer: "Reviewer",
  "review-triage": "Review triage",
  rebase: "Rebase",
  pack: "Pack writer",
  manager: "Manager",
  watchman: "Watchman",
};
const SOURCE: Record<Source, { text: string; color: string }> = {
  default: { text: "yagura default", color: "var(--muted)" },
  global: { text: "your global", color: "var(--info)" },
  project: { text: "this project", color: "var(--amber)" },
};
const area = {
  width: "100%",
  boxSizing: "border-box",
  font: "12.5px/1.55 var(--mono, monospace)",
  background: "var(--bg2)",
  color: "var(--text)",
  border: "1px solid var(--btnline)",
  borderRadius: 4,
  padding: 10,
  resize: "vertical",
} as const;

function Chip({ source }: { source: Source }) {
  const s = SOURCE[source];
  return (
    <span className="mono" style={{ fontSize: 11, padding: "1px 7px", borderRadius: 10, border: `1px solid ${s.color}`, color: s.color, whiteSpace: "nowrap" }}>
      {s.text}
    </span>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  if (lines.every((l) => l.kind === "same"))
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        Same as yagura's default.
      </div>
    );
  return (
    <div className="mono" style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {lines
        .filter((l) => l.kind !== "same")
        .map((l, i) => (
          <div key={i} className={l.kind === "add" ? "s-pine" : "s-bell"} style={{ textDecoration: l.kind === "del" ? "line-through" : undefined }}>
            {l.kind === "add" ? "+ " : "- "}
            {l.text}
          </div>
        ))}
    </div>
  );
}

function Contract({ attemptId, role }: { attemptId: number | null; role: string }) {
  const [open, setOpen] = useState(false);
  const d = useApi<AttemptDetail>(open && attemptId !== null ? `/api/attempts/${attemptId}` : null);
  if (attemptId === null)
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <h2 className="h2">Contract</h2>
        <span className="mono muted" style={{ fontSize: 11.5 }}>
          no {LABEL[role]!.toLowerCase()} has run in this project yet
        </span>
      </div>
    );
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary style={{ cursor: "pointer", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 className="h2" style={{ display: "inline" }}>
          Contract
        </h2>
        <span className="mono muted" style={{ fontSize: 11.5 }}>
          read-only · the brief its last agent got · yagura parses this
        </span>
        <Link to={`/a/${attemptId}`} style={{ fontSize: 12 }}>
          open that agent →
        </Link>
      </summary>
      <pre
        className="mono"
        style={{
          margin: "8px 0 0",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "var(--soft)",
          background: "var(--bg2)",
          border: "1px solid var(--line)",
          borderRadius: 4,
          padding: 10,
          maxHeight: 460,
          overflow: "auto",
        }}
      >
        {d.error ?? d.data?.brief ?? "Loading…"}
      </pre>
    </details>
  );
}

function FollowUps({ items }: { items: { when: string; text: string }[] }) {
  return (
    <details>
      <summary style={{ cursor: "pointer", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 className="h2" style={{ display: "inline" }}>
          Follow-ups
        </h2>
        <span className="mono muted" style={{ fontSize: 11.5 }}>
          read-only · what yagura may send after the brief · {items.length}
        </span>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
        {items.map((f) => (
          <div key={f.when}>
            <div style={{ fontSize: 13, marginBottom: 4 }}>{f.when}</div>
            <pre
              className="mono"
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                color: "var(--soft)",
                background: "var(--bg2)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                padding: 10,
                maxHeight: 320,
                overflow: "auto",
              }}
            >
              {f.text}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function NotesBox({ label, value, save, rows = 3 }: { label: string; value: string | null; save: (text: string) => Promise<unknown>; rows?: number }) {
  const [text, setText] = useState(value ?? "");
  const action = useAction();
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 className="h2">{label}</h2>
        <span className="mono muted" style={{ fontSize: 11.5 }}>
          added to the brief's standing orders
        </span>
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: "auto" }}
          disabled={action.busy || text === (value ?? "")}
          onClick={() => action.run(() => save(text))}
        >
          Save notes
        </button>
      </div>
      <textarea aria-label={label} rows={rows} value={text} placeholder="Nothing extra" onChange={(e) => setText(e.target.value)} style={area} />
      {action.error && <div className="s-bell">{action.error}</div>}
    </div>
  );
}

// With a project: its overrides and notes. Without one: the global guidance every project uses unless it sets its own, the watchman's included.
export function Prompts({ projectId }: { projectId: string | null }) {
  const view = useApi<PromptsView>(projectId ? `/api/prompts?project=${projectId}` : "/api/prompts");
  const [role, setRole] = useState(useQuery().get("role") ?? "planner");
  const [draft, setDraft] = useState("");
  const action = useAction();
  const r = view.data?.roles.find((x) => x.role === role);
  useEffect(() => {
    if (view.data && !r && view.data.roles[0]) setRole(view.data.roles[0].role);
  }, [view.data, r]);
  const effective = r ? (r.project ?? r.global ?? r.default) : "";
  useEffect(() => setDraft(effective), [effective, role]);
  const put = (body: object) => api(`/api/prompts`, { method: "PUT", body: { projectId, ...body } }).then(view.reload);
  if (view.error)
    return (
      <main style={{ padding: 36 }} className="s-bell">
        {view.error}
      </main>
    );
  if (!view.data || !r)
    return (
      <main style={{ padding: 36 }} className="muted">
        Loading…
      </main>
    );
  const dirty = draft !== effective;
  return (
    <main style={{ padding: "22px 36px 48px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="mono muted" style={{ fontSize: 12.5 }}>
        {projectId ? (
          <>
            <Link to={`/p/${projectId}`}>{projectId}</Link> / prompts · <Link to="/prompts">global guidance →</Link>
          </>
        ) : (
          "every project / prompts"
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <h1 className="serif" style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>
          Prompts
        </h1>
        <span className="muted" style={{ fontSize: 13 }}>
          {projectId
            ? "Edits apply to each role's next agent. Every run records the version it got."
            : "The guidance every project uses unless it sets its own. Notes are set per project, except the watchman's."}
        </span>
      </div>
      {projectId && (
        <div className="panel" style={{ padding: "12px 16px", border: "1px solid var(--line)", borderRadius: 6 }}>
          <NotesBox
            label="Notes for every role"
            value={view.data.allNotes}
            rows={2}
            save={(text) => put({ scope: "project", role: "all", kind: "notes", text })}
          />
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "230px minmax(0, 1fr)", border: "1px solid var(--line)", borderRadius: 6 }}>
        <nav aria-label="Roles" style={{ borderRight: "1px solid var(--line)", padding: 10, display: "flex", flexDirection: "column", gap: 2 }}>
          {view.data.roles.map((x) => (
            <button
              key={x.role}
              type="button"
              aria-current={x.role === role}
              onClick={() => setRole(x.role)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 6,
                alignItems: "center",
                padding: "8px 10px",
                borderRadius: 4,
                border: 0,
                cursor: "pointer",
                textAlign: "left",
                font: "inherit",
                fontSize: 14,
                color: "var(--text)",
                background: x.role === role ? "var(--panel)" : "transparent",
              }}
            >
              {LABEL[x.role] ?? x.role} <Chip source={x.source} />
            </button>
          ))}
        </nav>
        <section style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <h2 className="h2">Guidance</h2>
            <Chip source={r.source} />
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              version {r.sha}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
              {projectId && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={action.busy || !dirty}
                  onClick={() => action.run(() => put({ scope: "project", role, kind: "guidance", text: draft }))}
                >
                  Save for this project
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={action.busy || (!dirty && r.source !== "project")}
                title="Make this the guidance for every project that has not set its own"
                onClick={() =>
                  action.run(async () => {
                    await put({ scope: "global", role, kind: "guidance", text: draft });
                    if (r.project !== null) await put({ scope: "project", role, kind: "guidance", text: null });
                  })
                }
              >
                Save for all projects
              </button>
              {r.source !== "default" && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(() =>
                      put(
                        r.project !== null ? { scope: "project", role, kind: "guidance", text: null } : { scope: "global", role, kind: "guidance", text: null },
                      ),
                    )
                  }
                >
                  Reset to {r.project !== null && r.global !== null ? "your global" : "yagura default"}
                </button>
              )}
            </span>
          </div>
          <textarea aria-label={`${LABEL[role]} guidance`} rows={20} value={draft} onChange={(e) => setDraft(e.target.value)} style={area} />
          {action.error && <div className="s-bell">{action.error}</div>}
          <details open={r.source !== "default" || dirty}>
            <summary style={{ cursor: "pointer" }}>
              <h2 className="h2" style={{ display: "inline" }}>
                Changes from yagura's default
              </h2>
            </summary>
            <div style={{ marginTop: 8 }}>
              <Diff before={r.default} after={draft} />
            </div>
          </details>
          {projectId ? (
            <NotesBox
              key={role}
              label={`Notes for ${(LABEL[role] ?? role).toLowerCase()}s`}
              value={r.notes}
              save={(text) => put({ scope: "project", role, kind: "notes", text })}
            />
          ) : (
            role === "watchman" && (
              <NotesBox
                key={role}
                label="Notes for the watchman, in every conversation"
                value={r.notes}
                save={(text) => put({ scope: "global", role, kind: "notes", text })}
              />
            )
          )}
          <FollowUps key={`f-${role}`} items={r.followUps} />
          {projectId ? (
            <Contract key={`c-${role}`} attemptId={r.lastAttemptId} role={role} />
          ) : (
            <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <h2 className="h2">Contract</h2>
              <span className="mono muted" style={{ fontSize: 11.5 }}>
                read-only ·{" "}
                {role === "watchman" ? "each conversation turn's brief is in its log" : "a project's prompts page shows the brief its last agent got"}
              </span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
