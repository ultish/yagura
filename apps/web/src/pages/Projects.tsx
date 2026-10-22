import { useApi, type ProjectSummary } from "../api";
import { sha, usd } from "../lib/format";
import { projectStatus } from "../lib/project-status";
import { Link } from "../ui/Link";
import { Inline } from "../lib/markdown";
import { ClampCell, StatusCell, Table, TableRow, type Col } from "../ui/Table";

const GROUPS: { title: string; test: (s: ProjectSummary) => boolean }[] = [
  { title: "Active", test: (s) => s.project.state === "active" || s.project.state === "paused" || s.project.state === "closing" },
  { title: "Waiting in a chain", test: (s) => s.project.state === "framing" },
  { title: "Closed", test: (s) => s.project.state === "closed" },
];

const inFlight = (s: ProjectSummary) => {
  const c = s.workCounts;
  return (c.ready ?? 0) + (c.running ?? 0) + (c.verifying ?? 0) + (c.verified ?? 0) + (c.handed_off ?? 0);
};

const COLS: Col[] = [
  { label: "Project", width: 300 },
  { label: "What it is for" },
  { label: "Status", width: 180 },
  { label: "Landed", width: 100, num: true },
  { label: "In flight", width: 100, num: true },
  { label: "Spent", width: 110, num: true },
];

function ProjectRow({ s }: { s: ProjectSummary }) {
  const status = projectStatus(s);
  return (
    <TableRow to={`/p/${s.project.id}`}>
      <td className="tbl-name">
        <Link to={`/p/${s.project.id}`} onClick={(e) => e.stopPropagation()}>
          {s.project.id}
        </Link>
        {s.project.mergePolicy === "auto" && (
          <span className="tbl-tag" title="Merges automatically once the judge approves and CI passes">
            auto-merge
          </span>
        )}
      </td>
      <ClampCell title={s.project.goal}>
        <Inline text={s.project.goal} />
      </ClampCell>
      <StatusCell tone={status.tone}>{status.text}</StatusCell>
      <td className="tbl-num" title={s.lastLanded ? `last landed ${sha(s.lastLanded.sha)} · U${s.lastLanded.seq}` : "nothing has landed yet"}>
        {s.workCounts.landed ?? 0}
      </td>
      <td className="tbl-num">{inFlight(s)}</td>
      <td className="tbl-num">{s.budgetUsd ? `${usd(s.costUsd)} of ${usd(s.budgetUsd)}` : usd(s.costUsd)}</td>
    </TableRow>
  );
}

export function Projects() {
  const { data, error } = useApi<ProjectSummary[]>("/api/projects");
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
          Projects
        </h1>
        <Link className="btn lamp" to="/projects/new">
          New project
        </Link>
      </div>
      {error && <div className="s-bell">{error}</div>}
      {data && data.length === 0 && (
        <div className="empty">
          No projects yet. <Link to="/projects/new">Start one</Link>, or <Link to="/talk">talk to the watch</Link> and let it propose one.
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
            <Table cols={COLS}>
              {list.map((s) => (
                <ProjectRow key={s.project.id} s={s} />
              ))}
            </Table>
          </section>
        );
      })}
    </main>
  );
}
