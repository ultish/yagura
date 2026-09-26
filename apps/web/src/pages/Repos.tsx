import { useEffect, useState } from "react";
import { api, useApi, type RepoView } from "../api";
import { clock, plural, sha } from "../lib/format";
import { Link } from "../ui/Link";
import { Row, useAction } from "../ui/rows";

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "7px 10px" } as const;

function packStatus(v: RepoView): { text: string; tone: string } {
  if (!v.pack) return { text: "Not mirrored yet; yagura reads the verify pack on the first run.", tone: "muted" };
  if (!v.pack.ok) return { text: `No usable verify pack: ${v.pack.reason}. Verification stays blocked until one lands.`, tone: "bell" };
  const checks = v.pack.checks.map((c) => `${c.name} (${c.tier})`).join(", ");
  return v.repo.packStatus === "proven" ? { text: `Verify pack proven: ${checks}.`, tone: "pine" } : { text: `Verify pack on trunk: ${checks}.`, tone: "muted" };
}

function AddRepo({ onAdded }: { onAdded: () => void }) {
  const [source, setSource] = useState("");
  const [added, setAdded] = useState<RepoView | null>(null);
  const [id, setId] = useState("");
  const [suggested, setSuggested] = useState("");
  const action = useAction();

  useEffect(() => {
    if (!source.trim()) return setSuggested("");
    const t = setTimeout(() => {
      api<{ id: string }>(`/api/repos/suggest-id?source=${encodeURIComponent(source)}`)
        .then((r) => setSuggested(r.id))
        .catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
  }, [source]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setAdded(null);
        void action.run(async () => {
          setAdded(await api<RepoView>("/api/repos", { body: { source, id: id.trim() || undefined } }));
          onAdded();
          setSource("");
          setId("");
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0", borderTop: "1px solid var(--line2)" }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label htmlFor="repo-source" className="sr-only">
          Local path or git URL
        </label>
        <input id="repo-source" className="mono" value={source} onChange={(e) => setSource(e.target.value)} placeholder="~/Developer/billing or git@gitlab:team/billing.git" style={{ ...field, flexGrow: 1, minWidth: 260, fontSize: 13 }} />
        <label htmlFor="repo-id" className="sr-only">
          Repo id
        </label>
        <input id="repo-id" className="mono" value={id} onChange={(e) => setId(e.target.value)} placeholder={suggested ? `id: ${suggested}` : "id"} style={{ ...field, width: 180, fontSize: 13 }} />
        <button className="btn lamp" type="submit" disabled={action.busy || !source.trim()}>
          {action.busy ? "Reading…" : "Add repo"}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        yagura mirrors it and reads its default branch and verify pack. It never writes to the path you give; agents work in yagura's own worktrees, and landing pushes to it.
      </div>
      {action.error && <div className="s-bell" style={{ fontSize: 13 }}>{action.error}</div>}
      {added && (
        <div className="s-pine" style={{ fontSize: 13.5, display: "flex", flexDirection: "column", gap: 4 }}>
          <span>
            Added {added.repo.id} ({added.repo.defaultBranch} at {sha(added.trunk)}). <Link to="/talk">Talk to the watch</Link> to start a project in it.
          </span>
          {added.notes?.map((n) => (
            <span key={n} className="s-bell">
              {n}
            </span>
          ))}
        </div>
      )}
    </form>
  );
}

export function Repos() {
  const { data, error, reload } = useApi<RepoView[]>("/api/repos");
  const hash = typeof location !== "undefined" ? decodeURIComponent(location.hash.slice(1)) : "";

  useEffect(() => {
    if (data && hash) document.getElementById(`repo-${hash}`)?.scrollIntoView({ block: "center" });
  }, [data, hash]);

  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Repos
      </h1>
      <section>
        <div className="gh">
          <h2 className="h2">Add an existing repo</h2>
        </div>
        <AddRepo onAdded={reload} />
      </section>
      {error && <div className="s-bell">{error}</div>}
      {data && (
        <section>
          <div className="gh">
            <h2 className="h2">Registered</h2>
            <span className="n">{data.length}</span>
          </div>
          {data.length === 0 && <div className="empty">No repos yet. Add one above, or ask the watch for a prototype in a new repo.</div>}
          {data.map((v) => {
            const s = packStatus(v);
            return (
              <div key={v.repo.id} id={`repo-${v.repo.id}`} style={hash === v.repo.id ? { background: "var(--line2)" } : undefined}>
                <Row
                  seq={v.repo.id}
                  goal={<span className="mono" style={{ fontSize: 14, overflowWrap: "anywhere" }}>{v.repo.url}</span>}
                  status={s.text}
                  tone={s.tone}
                  facts={
                    <>
                      <span>
                        {v.repo.defaultBranch}
                        {v.trunk ? ` at ${sha(v.trunk)}` : ""}
                      </span>
                      <span>{v.landedCount} landed</span>
                      {v.lastLanded && (
                        <span>
                          last {sha(v.lastLanded.sha)} · <Link to={`/p/${v.lastLanded.projectId}/u/${v.lastLanded.seq}`}>{v.lastLanded.projectId} U{v.lastLanded.seq}</Link> · {clock(v.lastLanded.at)}
                        </span>
                      )}
                      {v.projects.length ? (
                        <span>
                          {v.projects.map((p, i) => (
                            <span key={p.id}>
                              {i ? ", " : ""}
                              <Link to={`/p/${p.id}`}>{p.id}</Link>
                              {p.state === "closed" ? " (closed)" : ""}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span>no projects</span>
                      )}
                    </>
                  }
                  extra={
                    v.landingQueue.length > 0 && (
                      <div className="s-lamp" style={{ fontSize: 13.5 }}>
                        {plural(v.landingQueue.length, "verified unit")} waiting to land:{" "}
                        {v.landingQueue.map((u, i) => (
                          <span key={`${u.projectId}-${u.seq}`}>
                            {i ? ", " : ""}
                            <Link to={`/p/${u.projectId}/u/${u.seq}`}>
                              {u.projectId} U{u.seq}
                            </Link>
                          </span>
                        ))}
                      </div>
                    )
                  }
                />
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}
