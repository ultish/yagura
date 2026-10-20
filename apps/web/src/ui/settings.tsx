import { useState, type ReactNode } from "react";
import { api, useApi, type SettingsOverview } from "../api";
import { filterSettings, groupSettings } from "../lib/setting-groups";
import { settingParsed, settingShown } from "../lib/setting-text";
import { useAction } from "./rows";

type Setting = SettingsOverview["settings"][number];
type SettingScope = "global" | "project" | "repo" | "environment";

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "5px 8px", fontSize: 13 } as const;

const SOURCE: Record<string, string> = {
  default: "default",
  global: "from global",
  project: "from the project",
  repo: "from the repo",
  environment: "from the environment",
};

const slug = (scopeId: string, title: string) => `settings-${scopeId}-${title}`.toLowerCase().replace(/\W+/g, "-");

const LAYER_NAME: Record<string, string> = { project: "a project", repo: "a repo", environment: "an environment" };

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

// "900 (15 minutes)" is an example for the reader; only the part before the bracket is a value to type.
const typed = (example: string | undefined) => example?.replace(/\s*\(.*\)$/, "");

function Control({ s, id, text, setText }: { s: Setting; id: string; text: string; setText: (t: string) => void }) {
  if (typeof s.default === "boolean")
    return (
      <select id={id} value={text} onChange={(e) => setText(e.target.value)} style={field}>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  if (s.options)
    return (
      <select id={id} className="mono" value={text} onChange={(e) => setText(e.target.value)} style={field}>
        {s.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  if (s.lines)
    return (
      <textarea id={id} className="mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} style={{ ...field, width: 300, resize: "vertical" }} />
    );
  const number = typeof s.default === "number";
  return (
    <input
      id={id}
      className="mono"
      type={number ? "number" : "text"}
      value={text}
      placeholder={s.emptyMeans ?? undefined}
      onChange={(e) => setText(e.target.value)}
      style={{ ...field, width: number ? 110 : 260 }}
    />
  );
}

export function SettingRow({ s, scope, scopeId, cap, onSaved }: { s: Setting; scope: SettingScope; scopeId: string; cap?: string; onSaved: () => void }) {
  const [text, setText] = useState(settingShown(s.value, s.lines));
  const action = useAction();
  const dirty = text !== settingShown(s.value, s.lines);
  const save = () =>
    action.run(
      async () => (await api("/api/settings", { body: { scope, id: scopeId, key: s.key, value: settingParsed(s.default, text, s.lines) } }), onSaved()),
    );
  const reset = () => action.run(async () => (await api("/api/settings/clear", { body: { scope, id: scopeId, key: s.key } }), onSaved()));
  const id = `setting-${scope}-${scopeId}-${s.key}`.replace(/\W+/g, "-");
  const clip = (t: string) => (t.length > 40 ? `${t.slice(0, 39)}…` : t);
  const show = (v: unknown) => (isEmpty(v) ? `empty, which means ${s.emptyMeans ?? "nothing is set"}` : clip(settingShown(v, s.lines).split("\n").join(", ")));
  const status =
    s.source === scope
      ? scope === "global"
        ? `set globally; default ${show(s.default)}`
        : `set here, instead of: ${show(s.inherited)}`
      : s.source === "default"
        ? `using the default: ${show(s.default)}`
        : SOURCE[s.source];
  const masks = scope !== "global" && s.source === scope && isEmpty(s.value) && !isEmpty(s.inherited);
  const others = s.layers.filter((l) => l !== scope).map((l) => LAYER_NAME[l]);
  return (
    <div className="item setting" style={{ alignItems: "flex-start" }}>
      <div className="body">
        <label htmlFor={id} className="goal" style={{ fontSize: 15 }}>
          {s.title}
        </label>
        <div className="setting-help">{s.help}</div>
        {s.example && !s.options && (
          <div className="setting-eg mono">
            e.g. <span>{s.example}</span>
          </div>
        )}
        <div className="facts">
          <span className="mono">{s.key}</span>
          <span>{status}</span>
          {scope === "global" && others.length > 0 && <span>can also be set on {others.join(", ")}</span>}
          {cap && <span className="s-lamp">{cap}</span>}
        </div>
        {masks && (
          <div className="s-bell" style={{ fontSize: 13, marginTop: 4 }}>
            This is empty here, so the value from further up ({clip(settingShown(s.inherited, s.lines).split("\n").join(", "))}) is not used. Remove the
            override to use it.
          </div>
        )}
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
        <Control s={s} id={id} text={text} setText={setText} />
        <button className="btn sm lamp" type="submit" disabled={!dirty || action.busy}>
          Save
        </button>
        {s.source === scope && (
          <button className="btn sm" type="button" disabled={action.busy} onClick={() => void reset()}>
            {scope === "global" ? "Reset" : "Remove override"}
          </button>
        )}
      </form>
    </div>
  );
}

// Settings gathered under their group, the rarely changed ones folded away, with a filter once there are many to scroll.
export function SettingsList({
  settings,
  scope,
  scopeId,
  caps,
  onSaved,
  heading,
}: {
  settings: Setting[];
  scope: SettingScope;
  scopeId: string;
  caps?: Record<string, string | undefined>;
  onSaved: () => void;
  heading: (title: string, count: number) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const shown = filterSettings(settings, query);
  const row = (s: Setting) => (
    <SettingRow key={`${s.key}:${JSON.stringify(s.value)}:${s.source}`} s={s} scope={scope} scopeId={scopeId} cap={caps?.[s.key]} onSaved={onSaved} />
  );
  return (
    <>
      {settings.length > 10 && (
        <input
          type="search"
          aria-label="Filter settings"
          placeholder="Filter settings: a word from the name, the description, or the key"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...field, width: "100%", maxWidth: 520, padding: "8px 10px", fontSize: 14 }}
        />
      )}
      {settings.length > 10 && !query && (
        <nav className="setting-jump" aria-label="Setting groups">
          {groupSettings(shown).map((g) => (
            <a key={g.title} href={`#${slug(scopeId, g.title)}`}>
              {g.title}
            </a>
          ))}
        </nav>
      )}
      {query && shown.length === 0 && <div className="muted">No setting matches "{query}".</div>}
      {groupSettings(shown).map((g) => (
        <section key={g.title} id={slug(scopeId, g.title)} className="setting-group">
          {heading(g.title, g.main.length + g.advanced.length)}
          {g.main.map(row)}
          {g.advanced.length > 0 && (
            <details className="setting-advanced" open={query !== ""}>
              <summary>Advanced ({g.advanced.length})</summary>
              {g.advanced.map(row)}
            </details>
          )}
        </section>
      ))}
    </>
  );
}

export function ScopedSettings({ scope, id }: { scope: Exclude<SettingScope, "global">; id: string }) {
  const { data, error, reload } = useApi<SettingsOverview>(`/api/settings/overview?scope=${scope}&id=${encodeURIComponent(id)}`);
  return (
    <div style={{ marginTop: 8 }}>
      <h3 className="setting-panel-title">
        Settings for {scope} <span className="mono">{id}</span>
      </h3>
      <div className="muted" style={{ fontSize: 13 }}>
        Values set here apply to this {scope} only and win over the global ones. Only settings yagura reads per {scope} are listed.
      </div>
      {error && <div className="s-bell">{error}</div>}
      {data && (
        <SettingsList
          settings={data.settings}
          scope={scope}
          scopeId={id}
          onSaved={reload}
          heading={(title, n) => (
            <h3 className="setting-group-title">
              {title} <span className="muted">{n}</span>
            </h3>
          )}
        />
      )}
    </div>
  );
}
