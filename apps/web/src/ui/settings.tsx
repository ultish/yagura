import { useState } from "react";
import { api, useApi, type SettingsOverview } from "../api";
import { useAction } from "./rows";

type Setting = SettingsOverview["settings"][number];
type SettingScope = "global" | "project" | "repo" | "environment";

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

const SOURCE: Record<string, string> = {
  default: "default",
  global: "from global",
  project: "from the project",
  repo: "from the repo",
  environment: "from the environment",
};

export function SettingRow({ s, scope, scopeId, cap, onSaved }: { s: Setting; scope: SettingScope; scopeId: string; cap?: string; onSaved: () => void }) {
  const [text, setText] = useState(shown(s.value));
  const action = useAction();
  const dirty = text !== shown(s.value);
  const save = () => action.run(async () => (await api("/api/settings", { body: { scope, id: scopeId, key: s.key, value: parsed(s, text) } }), onSaved()));
  const reset = () => action.run(async () => (await api("/api/settings/clear", { body: { scope, id: scopeId, key: s.key } }), onSaved()));
  const id = `setting-${scope}-${scopeId}-${s.key}`.replace(/\W+/g, "-");
  return (
    <div className="item" style={{ alignItems: "center" }}>
      <div className="body">
        <label htmlFor={id} className="goal" style={{ fontSize: 15 }}>
          {s.description}
        </label>
        <div className="facts">
          <span>{s.key}</span>
          <span>{s.source === scope ? `set ${scope === "global" ? "globally" : "here"}; default ${shown(s.default) || "empty"}` : SOURCE[s.source]}</span>
          {cap && <span className="s-lamp">{cap}</span>}
        </div>
        {action.error && (
          <div className="s-bell" style={{ fontSize: 13 }}>
            {action.error}
          </div>
        )}
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
        {s.source === scope && (
          <button className="btn sm" type="button" disabled={action.busy} onClick={() => void reset()}>
            Reset
          </button>
        )}
      </form>
    </div>
  );
}

export function ScopedSettings({ scope, id }: { scope: Exclude<SettingScope, "global">; id: string }) {
  const { data, error, reload } = useApi<SettingsOverview>(`/api/settings/overview?scope=${scope}&id=${encodeURIComponent(id)}`);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 13 }}>
        Values set here apply to this {scope} only and win over global ones. Only settings yagura reads per {scope} are listed.
      </div>
      {error && <div className="s-bell">{error}</div>}
      {data?.settings.map((s) => (
        <SettingRow key={`${s.key}:${JSON.stringify(s.value)}:${s.source}`} s={s} scope={scope} scopeId={id} onSaved={reload} />
      ))}
    </div>
  );
}
