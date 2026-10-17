import { useEffect, useState } from "react";
import { api, navigate, useApi, type EnvironmentView, type RepoView } from "../api";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";
import { AddRepo } from "./Repos";

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "7px 10px", fontSize: 14 } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</span>
      {children}
      {hint && (
        <span className="muted" style={{ fontSize: 13 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function NewProject() {
  const repos = useApi<RepoView[]>("/api/repos");
  const envs = useApi<EnvironmentView[]>("/api/environments");
  const [goal, setGoal] = useState("");
  const [predicate, setPredicate] = useState("");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [environment, setEnvironment] = useState("");
  const [merge, setMerge] = useState<"human" | "auto">("human");
  const [issues, setIssues] = useState("");
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const envAction = useAction();

  useEffect(() => {
    if (!environment && envs.data?.length === 1) setEnvironment(envs.data[0]!.environment.id);
  }, [envs.data, environment]);

  const ready = goal.trim() && predicate.trim() && chosen.length > 0 && environment;

  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24, maxWidth: 820 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        New project
      </h1>
      <p className="muted" style={{ margin: 0 }}>
        A project is one goal. The project lead splits it into units, each a small piece of work in one repo that ends as one pull request. The project closes
        itself when the goal is met.
      </p>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 22 }}
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const created = await api<{ project: { id: string } }>("/api/projects", {
              body: {
                name: name.trim() || undefined,
                goal,
                predicate,
                repos: chosen,
                references,
                environment,
                merge,
                issues: issues
                  .split(/[\s,]+/)
                  .map((i) => i.trim())
                  .filter(Boolean),
              },
            });
            navigate(`/p/${created.project.id}`);
          });
        }}
      >
        <Field label="Goal" hint="What you want done, in your own words.">
          <textarea className="mono" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} style={{ ...field, resize: "vertical" }} />
        </Field>
        <Field label="Done when" hint="How anyone could tell it is finished. The project lead checks this before it closes the project.">
          <textarea className="mono" rows={2} value={predicate} onChange={(e) => setPredicate(e.target.value)} style={{ ...field, resize: "vertical" }} />
        </Field>
        <Field label="Name (optional)" hint="Becomes the project's id; left empty, it is taken from the goal.">
          <input className="mono" value={name} onChange={(e) => setName(e.target.value)} style={{ ...field, maxWidth: 320 }} />
        </Field>

        <section>
          <div className="gh">
            <h2 className="h2">Repos this project may change</h2>
            <span className="n">{chosen.length}</span>
          </div>
          {repos.data && repos.data.length === 0 && !adding && <div className="empty">No repos registered yet. Add one below.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
            {(repos.data ?? []).map((r) => (
              <div key={r.repo.id} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <input type="checkbox" checked={chosen.includes(r.repo.id)} onChange={() => setChosen(toggle(chosen, r.repo.id))} />
                <b className="mono">{r.repo.id}</b>
                <span className="muted mono" style={{ fontSize: 13 }}>
                  {r.repo.url}
                </span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {r.route.text}
                </span>
                <span style={{ flexBasis: "100%", paddingLeft: 26 }}>
                  <label className="muted" style={{ fontSize: 13 }}>
                    <input
                      type="checkbox"
                      disabled={chosen.includes(r.repo.id)}
                      checked={references.includes(r.repo.id) && !chosen.includes(r.repo.id)}
                      onChange={() => setReferences(toggle(references, r.repo.id))}
                    />{" "}
                    read-only reference instead
                  </label>
                </span>
              </div>
            ))}
          </div>
          {adding ? (
            <>
              <AddRepo
                onAdded={(added) => {
                  repos.reload();
                  setChosen((c) => (c.includes(added.repo.id) ? c : [...c, added.repo.id]));
                }}
              />
              <button className="btn sm" type="button" onClick={() => setAdding(false)}>
                Done adding
              </button>
            </>
          ) : (
            <button className="btn" type="button" onClick={() => setAdding(true)}>
              Add another repo
            </button>
          )}
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Pointing at a repo yagura already knows? Tick it. Several repos work too: each unit changes exactly one, and a library merges before the app that
            uses it.
          </div>
        </section>

        <Field label="Environment" hint="How tests run and how publishing works for this project's repos. Every project needs one.">
          {envs.data && envs.data.length === 0 ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted">None yet.</span>
              <button
                className="btn"
                type="button"
                disabled={envAction.busy}
                onClick={() =>
                  envAction.run(async () => {
                    await api("/api/environments", { body: { id: "local", provider: "local-process", capacity: 1 } });
                    setEnvironment("local");
                    envs.reload();
                  })
                }
              >
                Create a local environment
              </button>
              {envAction.error && <span className="s-bell">{envAction.error}</span>}
            </div>
          ) : (
            <select value={environment} onChange={(e) => setEnvironment(e.target.value)} style={{ ...field, maxWidth: 320 }}>
              <option value="">Pick one…</option>
              {(envs.data ?? []).map((e) => (
                <option key={e.environment.id} value={e.environment.id}>
                  {e.environment.name === e.environment.id ? e.environment.id : `${e.environment.name} (${e.environment.id})`}
                </option>
              ))}
            </select>
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            Describe how it runs on the <Link to="/environments">Environments</Link> page; the doctor turns your answers into proven commands.
          </span>
        </Field>

        <Field label="Merging">
          <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="radio" name="merge" checked={merge === "human"} onChange={() => setMerge("human")} />I approve each merge
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <input type="radio" name="merge" checked={merge === "auto"} onChange={() => setMerge("auto")} />
            Merge when the judge approves and CI passes
          </label>
        </Field>

        <Field
          label="Issues it answers (optional)"
          hint="References like #123 or group/repo#45, separated by spaces or commas. They close when the work merges."
        >
          <input className="mono" value={issues} onChange={(e) => setIssues(e.target.value)} style={{ ...field, maxWidth: 420 }} />
        </Field>

        {action.error && <div className="s-bell">{action.error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn lamp" type="submit" disabled={action.busy || !ready}>
            {action.busy ? "Creating…" : "Create project"}
          </button>
          <Link className="btn" to="/projects">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
