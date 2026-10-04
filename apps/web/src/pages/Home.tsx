import { useEffect, useRef, useState } from "react";
import { api, navigate, useApi, useNow, type AgentRow, type BellItem, type ProjectSummary, type Thread } from "../api";
import { roleOf } from "../lib/units";
import { RoleLabel } from "../ui/RoleIcon";
import { duration, tokens } from "../lib/format";
import { Watch, WatchStrip } from "../scene/Watch";
import { Link } from "../ui/Link";
import { MentionInput } from "../ui/MentionInput";
import { BellRow, useAction } from "../ui/rows";

function Legend() {
  const item = { display: "inline-flex", alignItems: "center", gap: 8 } as const;
  return (
    <div
      className="mono"
      style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "center", padding: "8px 36px", fontSize: 11.5, color: "var(--muted)" }}
    >
      <span style={item}>
        <span style={{ width: 8, height: 12, background: "var(--lamp)" }} />
        shōji lit: an agent at work
      </span>
      <span style={item}>
        <span style={{ width: 10, height: 10, borderRadius: "5px 5px 2px 2px", background: "var(--bell)" }} />
        hanshō ringing: needs you
      </span>
      <span style={item}>
        <span style={{ width: 24, borderTop: "2px dashed var(--lamp)" }} />
        signal: waiting on another project
      </span>
      <span style={item}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--lamp)" }} />
        ridge lamp: planner thinking
      </span>
    </div>
  );
}

function TalkBox() {
  const [text, setText] = useState("");
  const action = useAction();
  const send = () =>
    action.run(async () => {
      const r = await api<{ thread: Thread }>("/api/threads", { body: { message: text } });
      navigate(`/talk/${r.thread.id}`);
    });
  return (
    <div>
      <h2 className="h2" style={{ marginBottom: 8 }}>
        Talk to the watch
      </h2>
      <MentionInput
        value={text}
        onChange={setText}
        onSubmit={() => void send()}
        label="Talk to the watch"
        placeholder="What should yagura build or change?"
        disabled={action.busy}
        hint="@ mentions a project, unit or run · Enter sends"
      />
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13, marginTop: 6 }}>
          {action.error}
        </div>
      )}
    </div>
  );
}

function Lanterns({ now }: { now: number }) {
  const agents = useApi<{ attempts: AgentRow[]; caps: { maxParallelAgents: number; running: number } }>("/api/agents?recent=0");
  const running = agents.data?.attempts.filter((a) => a.state === "running") ?? [];
  const role = (a: AgentRow) => roleOf(a.unit.type, a.harness);
  return (
    <section aria-labelledby="lanterns">
      <div className="gh">
        <h2 id="lanterns" className="h2">
          Lanterns lit
        </h2>
        <span className="n">{agents.data ? `${agents.data.caps.running} of ${agents.data.caps.maxParallelAgents} agents` : ""}</span>
      </div>
      {running.length === 0 && <div className="empty">No agents at work.</div>}
      {running.map((a) => (
        <Link
          key={a.id}
          to={`/a/${a.id}`}
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            padding: "10px 0",
            borderTop: "1px solid var(--line2)",
            color: "var(--text)",
            textDecoration: "none",
          }}
        >
          <span className="shoji" style={{ width: 12, height: 16, borderRadius: 2, background: "var(--lamp)", flexShrink: 0 }} />
          <span style={{ flexGrow: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 14.5 }}>
              {a.unit.projectId} ·{" "}
              {a.unit.type === "plan" ? (
                <RoleLabel role="planner" text="project lead" />
              ) : (
                <>
                  <RoleLabel role={role(a)} /> A{a.agentNo}
                </>
              )}
            </span>
            <span className="mono muted" style={{ display: "block", fontSize: 12 }}>
              {a.startedAt ? duration(now - Date.parse(a.startedAt)) : "starting"}
              {a.contextPeak ? ` · ctx ${tokens(a.contextPeak)}` : ""} · {a.unit.goal.slice(0, 48)}
            </span>
          </span>
        </Link>
      ))}
    </section>
  );
}

function Conversations() {
  const threads = useApi<(Thread & { busy: boolean })[]>("/api/threads");
  const list = (threads.data ?? []).filter((t) => t.state === "open").slice(0, 4);
  return (
    <section aria-labelledby="convos">
      <div className="gh">
        <h2 id="convos" className="h2">
          Conversations
        </h2>
        <Link to="/talk" className="mono" style={{ fontSize: 12, textDecoration: "none" }}>
          all
        </Link>
      </div>
      {list.length === 0 && <div className="empty">None yet.</div>}
      {list.map((t) => (
        <Link
          key={t.id}
          to={`/talk/${t.id}`}
          style={{ display: "block", padding: "9px 0", borderTop: "1px solid var(--line2)", color: "var(--text)", textDecoration: "none" }}
        >
          <span style={{ fontSize: 14.5 }}>{t.title}</span>
          <span className="mono muted" style={{ display: "block", fontSize: 12 }}>
            {t.busy ? "watchman is replying…" : t.projects.join(", ") || "no projects yet"}
          </span>
        </Link>
      ))}
    </section>
  );
}

export function Home() {
  const now = useNow(1000);
  const projects = useApi<ProjectSummary[]>("/api/projects");
  const bell = useApi<BellItem[]>("/api/bell");
  const sceneRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e!.isIntersecting), { rootMargin: "-60px 0px 0px 0px", threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const items = bell.data ?? [];
  return (
    <main>
      {collapsed && projects.data && (
        <div style={{ position: "sticky", top: 0, zIndex: 5 }}>
          <WatchStrip projects={projects.data} now={now} />
        </div>
      )}
      <div ref={sceneRef} style={{ overflow: "hidden" }}>
        {projects.data ? <Watch projects={projects.data} now={now} /> : <div style={{ height: 286 }} />}
      </div>
      <Legend />
      <div
        style={{
          display: "flex",
          gap: 48,
          padding: "20px 36px 48px",
          borderTop: "1px solid var(--line)",
          background: "var(--bg2)",
          flexWrap: "wrap",
          minHeight: "60vh",
        }}
      >
        <section aria-labelledby="bell" style={{ flex: "1 1 520px", minWidth: 0 }}>
          <div className="gh">
            <h2 id="bell" className="h2" style={{ color: "var(--bell-text)" }}>
              The bell · needs you
            </h2>
            <span className="n">{items.length}</span>
          </div>
          {items.length === 0 && <div className="empty">Nothing needs you. yagura is keeping watch.</div>}
          {items.map((i) => (
            <BellRow key={i.id} item={i} showProject />
          ))}
        </section>
        <div style={{ flex: "0 1 430px", minWidth: 280, display: "flex", flexDirection: "column", gap: 28 }}>
          <TalkBox />
          <Lanterns now={now} />
          <Conversations />
        </div>
      </div>
    </main>
  );
}
