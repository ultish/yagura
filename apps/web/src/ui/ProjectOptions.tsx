import { useState, type ReactNode } from "react";
import { api, useApi, type ProjectDetail } from "../api";
import { environmentChoices, type EnvironmentRow } from "../lib/environment-choices";
import { useAction } from "./rows";

type Project = ProjectDetail["project"];

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

const refsOf = (text: string) => text.split(/[\s,]+/).filter(Boolean);

// The choices a project makes about itself, which are not tunable settings: how it merges, where it runs, whether it ever closes,
// and the issues it answers.
export function ProjectOptions({ p, onSaved }: { p: Project; onSaved: () => void }) {
  const environments = useApi<EnvironmentRow[]>("/api/environments");
  const [merge, setMerge] = useState<string>(p.mergePolicy);
  const [env, setEnv] = useState<string>(p.environmentId ?? "");
  const [standing, setStanding] = useState(p.standing);
  const [refs, setRefs] = useState(p.refs.join(" "));
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const changed = {
    ...(merge !== p.mergePolicy ? { merge } : {}),
    ...(env !== (p.environmentId ?? "") ? { environmentId: env || null } : {}),
    ...(standing !== p.standing ? { standing } : {}),
    ...(refs.trim() !== p.refs.join(" ") ? { refs: refsOf(refs) } : {}),
  };
  const dirty = Object.keys(changed).length > 0;
  const save = () =>
    action.run(async () => {
      await api(`/api/projects/${p.id}/options`, { body: changed });
      setSaved(true);
      onSaved();
    });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void save();
      }}
    >
      <Option
        title="How it merges"
        help={
          merge === "auto" ? (
            <>
              <b>Automatic:</b> a unit merges once the judge approves and CI passes, with no question to you. This applies to every unit in the project,
              including ones already waiting at the merge gate.
            </>
          ) : (
            "Each approved unit waits for you at a merge gate, and nothing lands until you choose Merge."
          )
        }
      >
        <select aria-label="How it merges" value={merge} onChange={(e) => setMerge(e.target.value)} style={field}>
          <option value="human">I approve each merge</option>
          <option value="auto">Merge automatically</option>
        </select>
      </Option>
      <Option title="Environment" help="Where its agents run and how its tests are run. The environment's answers and actions come from the Environments page.">
        <select aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value)} style={field}>
          <option value="">none</option>
          {environmentChoices(environments.data ?? [], p.environmentId).map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </Option>
      <Option
        title="Never closes"
        help="A standing project is never done: it takes work whenever you add it, and plans nothing until then. Off: it closes once its goal is met."
      >
        <select aria-label="Never closes" value={standing ? "yes" : "no"} onChange={(e) => setStanding(e.target.value === "yes")} style={field}>
          <option value="no">Off</option>
          <option value="yes">On</option>
        </select>
      </Option>
      <Option
        title="Issues it answers"
        help="The issues this project is for, written repo#number, for example rakko#19. They show on the project, and yagura trace rakko#19 finds the project and its units from the issue. This does not close the issue: a pull request closes it when its own unit was started from that issue or given --issue."
      >
        <input
          aria-label="Issues it answers"
          className="mono"
          value={refs}
          placeholder="none"
          onChange={(e) => setRefs(e.target.value)}
          style={{ ...field, width: 260 }}
        />
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
