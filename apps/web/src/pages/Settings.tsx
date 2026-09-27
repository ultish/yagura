import { useRef, useState } from "react";
import { api, streamUrl, useApi, type SettingsOverview } from "../api";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";

type Setting = SettingsOverview["settings"][number];

const GROUPS: { title: string; test: (key: string) => boolean }[] = [
  { title: "Limits", test: (k) => k.startsWith("max_") || k === "project.max_in_flight" || k === "verify.max_retries" },
  { title: "Time limits", test: (k) => k.startsWith("timebox.") },
  { title: "Agents and models", test: (k) => k.startsWith("role.") || k.startsWith("harness.") || k.startsWith("watchman.") || k.startsWith("method.") },
  { title: "Git and links", test: (k) => k.startsWith("git.") || k.startsWith("yagura.") },
];

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "5px 8px", fontSize: 13 } as const;

function shown(value: unknown): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join(" ");
  return String(value);
}

function parsed(s: Setting, text: string): unknown {
  const t = text.trim();
  if (typeof s.default === "number") return t === "" ? null : Number(t);
  if (typeof s.default === "boolean") return t === "true";
  if (Array.isArray(s.default)) return t ? t.split(/\s+/) : [];
  return t === "" && s.default === null ? null : t;
}

function SettingRow({ s, cap, onSaved }: { s: Setting; cap?: string; onSaved: () => void }) {
  const [text, setText] = useState(shown(s.value));
  const action = useAction();
  const dirty = text !== shown(s.value);
  const save = () => action.run(async () => (await api("/api/settings", { body: { scope: "global", key: s.key, value: parsed(s, text) } }), onSaved()));
  const reset = () => action.run(async () => (await api("/api/settings/clear", { body: { scope: "global", key: s.key } }), onSaved()));
  const id = `setting-${s.key.replace(/\W+/g, "-")}`;
  return (
    <div className="item" style={{ alignItems: "center" }}>
      <div className="body">
        <label htmlFor={id} className="goal" style={{ fontSize: 15 }}>
          {s.description}
        </label>
        <div className="facts">
          <span>{s.key}</span>
          <span>{s.source === "default" ? "default" : `set ${s.source === "global" ? "globally" : `per ${s.source}`}; default ${shown(s.default) || "empty"}`}</span>
          {cap && <span className="s-lamp">{cap}</span>}
        </div>
        {action.error && <div className="s-bell" style={{ fontSize: 13 }}>{action.error}</div>}
      </div>
      <form
        className="actions"
        style={{ alignItems: "center" }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {typeof s.default === "boolean" ? (
          <select id={id} className="mono" value={text} onChange={(e) => setText(e.target.value)} style={field}>
            <option>true</option>
            <option>false</option>
          </select>
        ) : (
          <input
            id={id}
            className="mono"
            type={typeof s.default === "number" ? "number" : "text"}
            value={text}
            placeholder={s.default === null ? "empty" : undefined}
            onChange={(e) => setText(e.target.value)}
            style={{ ...field, width: typeof s.default === "number" ? 90 : 220 }}
          />
        )}
        <button className="btn sm lamp" type="submit" disabled={!dirty || action.busy}>
          Save
        </button>
        {s.source === "global" && (
          <button className="btn sm" type="button" disabled={action.busy} onClick={() => void reset()}>
            Reset
          </button>
        )}
      </form>
    </div>
  );
}

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
      {applied !== null && <span className="s-pine" style={{ fontSize: 13 }}>Imported {applied} value(s).</span>}
      {action.error && <span className="s-bell" style={{ fontSize: 13, width: "100%" }}>{action.error}</span>}
    </div>
  );
}

export function Settings() {
  const { data, error, reload } = useApi<SettingsOverview>("/api/settings/overview");
  const caps = data?.caps;
  const capText: Record<string, string | undefined> = caps
    ? {
        max_parallel_agents: `${caps.max_parallel_agents.running} running now`,
        max_parallel_per_harness: Object.entries(caps.max_parallel_per_harness.byHarness).map(([h, n]) => `${h}: ${n} running`).join(", ") || "none running",
      }
    : {};
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Settings
      </h1>
      <div className="muted" style={{ fontSize: 14, marginTop: -12 }}>
        These are the global values. A project, repo, or environment can override one with <span className="mono">yagura set --scope</span>; the narrowest layer wins.
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
      {data &&
        GROUPS.map((g) => {
          const list = data.settings.filter((s) => g.test(s.key));
          return (
            <section key={g.title}>
              <div className="gh">
                <h2 className="h2">{g.title}</h2>
              </div>
              {list.map((s) => (
                <SettingRow key={`${s.key}:${JSON.stringify(s.value)}:${s.source}`} s={s} cap={capText[s.key]} onSaved={reload} />
              ))}
            </section>
          );
        })}
    </main>
  );
}
