import { useApi, type ProjectSummary } from "../api";
import { clock, sha, spend } from "../lib/format";
import { needsYou } from "../lib/scene";
import { Link } from "../ui/Link";
import { Inline } from "../lib/markdown";
import { Row } from "../ui/rows";

const GROUPS: { title: string; test: (s: ProjectSummary) => boolean }[] = [
  { title: "Active", test: (s) => s.project.state === "active" || s.project.state === "paused" || s.project.state === "closing" },
  { title: "Waiting in a chain", test: (s) => s.project.state === "framing" },
  { title: "Closed", test: (s) => s.project.state === "closed" },
];

export function Projects() {
  const { data, error } = useApi<ProjectSummary[]>("/api/projects");
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Projects
      </h1>
      {error && <div className="s-bell">{error}</div>}
      {data && data.length === 0 && (
        <div className="empty">
          No projects yet. <Link to="/talk">Talk to the watch</Link> to start one.
        </div>
      )}
      {GROUPS.map((g) => {
        const list = (data ?? []).filter(g.test).reverse();
        if (!list.length) return null;
        return (
          <section key={g.title}>
            <div className="gh">
              <h2 className="h2">{g.title}</h2>
              <span className="n">{list.length}</span>
            </div>
            {list.map((s) => {
              const n = needsYou(s);
              const c = s.workCounts;
              return (
                <Row
                  key={s.project.id}
                  seq={<Link to={`/p/${s.project.id}`}>{s.project.id}</Link>}
                  goal={<Inline text={s.project.goal} />}
                  to={`/p/${s.project.id}`}
                  status={
                    s.project.andonReason
                      ? `Andon: ${s.project.andonReason}`
                      : n
                        ? `${n} thing${n === 1 ? "" : "s"} need you.`
                        : s.running || s.planning
                          ? `${s.running} agent${s.running === 1 ? "" : "s"} at work${s.planning ? ", planner thinking" : ""}.`
                          : s.project.state === "closed"
                            ? `Closed ${clock(s.project.closedAt)}.`
                            : s.project.state === "framing"
                              ? `Starts after ${s.project.after.join(", ")}.`
                              : "Idle."
                  }
                  tone={s.project.andonReason || n ? "bell" : s.running || s.planning ? "lamp" : s.project.state === "closed" ? "pine" : "muted"}
                  facts={
                    <>
                      <span>{c.landed ?? 0} landed</span>
                      {c.blocked ? <span>{c.blocked} blocked</span> : null}
                      <span>{(c.ready ?? 0) + (c.running ?? 0) + (c.verifying ?? 0) + (c.verified ?? 0) + (c.handed_off ?? 0)} in flight</span>
                      <span>{s.project.mergePolicy === "auto" ? "merges automatically" : "merge by hand"}</span>
                      <span>{spend(s.costUsd, s.budgetUsd)}</span>
                      {s.lastLanded && (
                        <span>
                          last landed {sha(s.lastLanded.sha)} · U{s.lastLanded.seq}
                        </span>
                      )}
                    </>
                  }
                />
              );
            })}
          </section>
        );
      })}
    </main>
  );
}
