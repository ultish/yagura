import { useRef, useState } from "react";
import { api, streamUrl, useApi, type SettingsOverview } from "../api";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";
import { SettingsList } from "../ui/settings";

function Transfer({ onImported }: { onImported: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const action = useAction();
  const [applied, setApplied] = useState<number | null>(null);
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <a className="btn" href={streamUrl("/api/settings/export")} download="yagura-settings.yaml" style={{ textDecoration: "none" }}>
        Export YAML
      </a>
      <label htmlFor="settings-import" className="sr-only">
        Import a settings YAML file
      </label>
      <input
        id="settings-import"
        ref={file}
        type="file"
        accept=".yaml,.yml,text/yaml"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setApplied(null);
          void action.run(async () => {
            setApplied((await api<{ applied: number }>("/api/settings/import", { body: { yaml: await f.text() } })).applied);
            onImported();
          });
          e.target.value = "";
        }}
      />
      <button className="btn" type="button" disabled={action.busy} onClick={() => file.current?.click()}>
        Import YAML…
      </button>
      <span className="muted" style={{ fontSize: 13 }}>
        Export holds every value set on any layer. Import sets each value in the file and keeps the rest; one bad value and nothing is imported.
      </span>
      {applied !== null && (
        <span className="s-pine" style={{ fontSize: 13 }}>
          Imported {applied} value(s).
        </span>
      )}
      {action.error && (
        <span className="s-bell" style={{ fontSize: 13, width: "100%" }}>
          {action.error}
        </span>
      )}
    </div>
  );
}

export function Settings() {
  const { data, error, reload } = useApi<SettingsOverview>("/api/settings/overview");
  const caps = data?.caps;
  const capText: Record<string, string | undefined> = caps
    ? {
        max_parallel_agents: `${caps.max_parallel_agents.running} running now`,
        max_parallel_per_harness:
          Object.entries(caps.max_parallel_per_harness.byHarness)
            .map(([h, n]) => `${h}: ${n} running`)
            .join(", ") || "none running",
      }
    : {};
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Settings
      </h1>
      <div className="muted" style={{ fontSize: 14, marginTop: -12 }}>
        These are the global values, used wherever nothing narrower is set. Where a setting says it can also be set on a project, repo or environment, that page
        can override it, and the narrowest one wins.
      </div>
      <div style={{ fontSize: 14, marginTop: -12 }}>
        <Link to="/prompts">Prompts: the guidance each agent role follows, the watchman's included →</Link>
      </div>
      <Transfer onImported={reload} />
      {error && <div className="s-bell">{error}</div>}
      {caps && caps["project.max_in_flight"].length > 0 && (
        <section>
          <div className="gh">
            <h2 className="h2">Running now</h2>
          </div>
          <div className="facts" style={{ padding: "10px 0", borderTop: "1px solid var(--line2)" }}>
            <span>
              <b>all projects</b> {caps.max_parallel_agents.running} of {caps.max_parallel_agents.limit}
            </span>
            {caps["project.max_in_flight"].map((p) => (
              <span key={p.id}>
                <Link to={`/p/${p.id}`}>{p.id}</Link> {p.running} of {p.limit}
              </span>
            ))}
          </div>
        </section>
      )}
      {data && (
        <SettingsList
          settings={data.settings}
          scope="global"
          scopeId=""
          caps={capText}
          onSaved={reload}
          heading={(title, n) => (
            <div className="gh">
              <h2 className="h2">
                {title} <span className="muted">{n}</span>
              </h2>
            </div>
          )}
        />
      )}
    </main>
  );
}
