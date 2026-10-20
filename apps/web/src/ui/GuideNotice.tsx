import { useState } from "react";
import { api, useApi } from "../api";
import { Link } from "./Link";
import { useAction } from "./rows";

interface GuideState {
  hasGuide: boolean;
  creating: { projectId: string; seq: number; state: string } | null;
}

// A repo with no verification guide says so, and the developer starts its creation here: one unit in a project that uses the repo.
// The note is what only the developer knows (how to start the app, what to avoid); the agent cannot stop and ask for it mid-run.
export function GuideNotice({ repoId, projects, onChange }: { repoId: string; projects: string[]; onChange?: () => void }) {
  const { data, reload } = useApi<GuideState>(`/api/repos/${repoId}/guide`);
  const action = useAction();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [projectId, setProjectId] = useState(projects[0] ?? "");
  if (!data || data.hasGuide) return null;
  const c = data.creating;
  const start = () =>
    action.run(() =>
      api(`/api/repos/${repoId}/guide`, { body: { projectId, note } }).then(() => {
        setAsking(false);
        setNote("");
        reload();
        onChange?.();
      }),
    );
  return (
    <div className="guide-notice" role="note">
      <span>
        <b>{repoId}</b> has no verification guide, so units on it are proved with the environment's tests only.
        {c && (
          <>
            {" "}
            <Link to={`/p/${c.projectId}/u/${c.seq}`}>
              {c.projectId} U{c.seq}
            </Link>{" "}
            is creating it ({c.state}).
          </>
        )}
        {!c && !projects.length && " No active project uses it, so there is nowhere to add the unit."}
      </span>
      {!c && projects.length > 0 && !asking && (
        <button className="btn sm" type="button" onClick={() => setAsking(true)}>
          Create the guide
        </button>
      )}
      {!c && asking && (
        <form
          className="guide-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label>
            Anything the agent should know? How to start the app, ports, test data, what to leave alone. It cannot ask you mid-run. (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </label>
          <div className="guide-ask-row">
            {projects.length > 1 && (
              <label>
                Add the unit to
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn lamp sm" type="submit" disabled={action.busy}>
              Add the unit
            </button>
            <button className="btn sm" type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {action.error && <span className="s-bell">{action.error}</span>}
    </div>
  );
}
