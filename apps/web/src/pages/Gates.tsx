import { useApi, type BellItem, type Gate } from "../api";
import { clock } from "../lib/format";
import { Inline } from "../lib/markdown";
import { Link } from "../ui/Link";
import { BellRow, Row } from "../ui/rows";

interface Inbox {
  waiting: BellItem[];
  resolved: (Gate & { unit: { seq: number; goal: string } | null })[];
}

const GROUPS: { title: string; test: (i: BellItem) => boolean }[] = [
  { title: "Questions", test: (i) => i.kind === "gate" && i.gate.kind !== "report" },
  { title: "Proposals waiting for Go", test: (i) => i.kind === "proposal" },
  { title: "Blocked work", test: (i) => i.kind === "blocked" },
  { title: "Reports to read", test: (i) => i.kind === "gate" && i.gate.kind === "report" },
];

export function Gates() {
  const { data, error } = useApi<Inbox>("/api/inbox");
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Gates
      </h1>
      <div className="muted" style={{ fontSize: 14, marginTop: -12 }}>
        Everything waiting for you, across projects. A question with a default takes it when its time runs out (<Link to="/settings">gates.timeout_hours</Link>
        ); one whose default is hold waits for you.
      </div>
      {error && <div className="s-bell">{error}</div>}
      {data && data.waiting.length === 0 && <div className="empty">Nothing is waiting for you.</div>}
      {data &&
        GROUPS.map((g) => {
          const list = data.waiting.filter(g.test);
          if (!list.length) return null;
          return (
            <section key={g.title}>
              <div className="gh">
                <h2 className="h2">{g.title}</h2>
                <span className="n">{list.length}</span>
              </div>
              {list.map((i) => (
                <BellRow key={i.id} item={i} showProject />
              ))}
            </section>
          );
        })}
      {data && data.resolved.length > 0 && (
        <section>
          <div className="gh">
            <h2 className="h2">Resolved recently</h2>
            <span className="n">{data.resolved.length}</span>
          </div>
          {data.resolved.map((g) => (
            <Row
              key={g.id}
              seq={
                g.unit ? (
                  <Link to={`/p/${g.projectId}/u/${g.unit.seq}`}>{`${g.projectId} · U${g.unit.seq}`}</Link>
                ) : (
                  <Link to={`/p/${g.projectId}`}>{g.projectId}</Link>
                )
              }
              goal={<Inline text={g.question} />}
              status={
                g.state === "defaulted"
                  ? `Nobody answered, so it took the default: ${g.answer}.`
                  : g.state === "cancelled"
                    ? "Cancelled."
                    : `Answered: ${g.answer}.`
              }
              tone={g.state === "defaulted" ? "lamp" : "muted"}
              facts={<span>{clock(g.resolvedAt)}</span>}
            />
          ))}
        </section>
      )}
    </main>
  );
}
