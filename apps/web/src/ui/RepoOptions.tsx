import { useState, type ReactNode } from "react";
import { api, type Repo } from "../api";
import { useAction } from "./rows";

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "5px 8px", fontSize: 13 } as const;

function Option({ title, help, children }: { title: string; help: ReactNode; children: ReactNode }) {
  return (
    <div className="item setting" style={{ alignItems: "flex-start" }}>
      <div className="body">
        <div className="goal" style={{ fontSize: 15 }}>
          {title}
        </div>
        <div className="setting-help">{help}</div>
      </div>
      <div className="actions" style={{ alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}

const routeOf = (repo: Repo) => (repo.forge === "none" ? "push" : repo.forge);

const ROUTE_HELP: Record<string, string> = {
  gh: "Each finished unit becomes a GitHub pull request, and yagura merges it through GitHub once the judge approves, CI passes and you say so.",
  glab: "Each finished unit becomes a GitLab merge request, and yagura merges it through GitLab once the judge approves, CI passes and you say so.",
  push: "No pull request and no review on the forge: when you approve a unit, yagura pushes the merge straight to the default branch. Only choose this where that is fine.",
};

// How a repo is reached and how its work lands; the rest of its settings are in the lists below.
export function RepoOptions({ repo, onSaved }: { repo: Repo; onSaved: () => void }) {
  const [url, setUrl] = useState(repo.url);
  const [route, setRoute] = useState<string>(routeOf(repo));
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const changed = { ...(url.trim() !== repo.url ? { url } : {}), ...(route !== routeOf(repo) ? { route } : {}) };
  const dirty = Object.keys(changed).length > 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void action.run(async () => {
          await api(`/api/repos/${repo.id}/options`, { body: changed });
          setSaved(true);
          onSaved();
        });
      }}
    >
      <Option
        title="Address"
        help="The git URL yagura clones and fetches. Change it if the repo moved; yagura keeps working from its own copy until the next fetch."
      >
        <input aria-label="Address" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} style={{ ...field, width: 360 }} />
      </Option>
      <Option title="How work lands" help={ROUTE_HELP[route]}>
        <select aria-label="How work lands" value={route} onChange={(e) => setRoute(e.target.value)} style={field}>
          <option value="gh">GitHub pull requests</option>
          <option value="glab">GitLab merge requests</option>
          <option value="push">Push straight to the default branch</option>
        </select>
      </Option>
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 0" }}>
        <button className="btn sm lamp" type="submit" disabled={!dirty || action.busy}>
          Save
        </button>
        {saved && !dirty && <span className="s-pine">Saved.</span>}
        {action.error && <span className="s-bell">{action.error}</span>}
      </div>
    </form>
  );
}
