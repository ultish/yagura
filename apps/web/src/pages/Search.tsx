import { useState } from "react";
import { useApi, useQuery } from "../api";
import { groupHits, KIND_LABEL, type FindResult } from "../lib/search";
import { Link } from "../ui/Link";
import { Marked } from "../ui/SearchBox";

export function Search() {
  const q = (useQuery().get("q") ?? "").trim();
  const { data, error } = useApi<FindResult>(q ? `/api/find?q=${encodeURIComponent(q)}` : null);
  const [kind, setKind] = useState<string | null>(null);
  const groups = data ? groupHits(data) : [];
  const hits = data ? data.hits.filter((h) => !kind || h.kind === kind) : [];
  return (
    <main style={{ padding: "22px 36px 48px", maxWidth: 1100 }}>
      <h1 className="serif" style={{ margin: "0 0 4px", fontSize: 26, fontWeight: 600 }}>
        {q ? <>Results for “{q}”</> : "Search"}
      </h1>
      {!q && <p className="muted">Type in the search box at the top: words, a commit, an issue key, or a unit like U3.</p>}
      {error && <div className="s-bell">{error}</div>}
      {data && (
        <>
          <div className="mono" style={{ fontSize: 12.5, color: "var(--soft)", margin: "4px 0 10px" }}>
            {data.total ? `${data.total} results · ${groups.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(" · ")}` : "Nothing matches."}
          </div>
          {data.total > 0 && (
            <div className="search-filters" role="group" aria-label="Show only">
              <button type="button" className="chip-btn mono" aria-pressed={!kind} onClick={() => setKind(null)}>
                all
              </button>
              {groups.map((g) => (
                <button key={g.kind} type="button" className="chip-btn mono" aria-pressed={kind === g.kind} onClick={() => setKind(g.kind)}>
                  {g.label} {g.count}
                </button>
              ))}
            </div>
          )}
          <div className="search-ledger">
            {hits.map((h, i) => (
              <div key={`${h.kind}:${h.href}:${i}`} className="search-line">
                <span className="mono muted">{KIND_LABEL[h.kind] ?? h.kind}</span>
                <Link to={h.href} className="mono">
                  {h.ref}
                </Link>
                <span className="search-text">
                  <Marked text={h.kind === "handoff" || h.kind === "message" || h.kind === "review" ? h.text : h.title} query={q} />
                  <span className="search-meta mono">{h.meta}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
