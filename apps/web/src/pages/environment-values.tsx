import { useState } from "react";
import { api, apiText, useApi, type EnvTemplateFile, type EnvValueView, type EnvironmentDetail, type KeptSlot } from "../api";
import { clock } from "../lib/format";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";

const field = {
  background: "var(--bg)",
  border: "1px solid var(--btnline)",
  borderRadius: 4,
  padding: "7px 10px",
  fontSize: 13,
  width: "100%",
} as const;

function keepLine(keep: EnvironmentDetail["keep"]): string {
  if (keep.policy.value === "never") return "Slots are removed when verification ends.";
  if (!keep.keeps) return "Pool namespaces are reused, so slots are cleaned when verification ends.";
  const what = keep.keeps === "deployed" ? "its namespace with what it deployed" : "its slot directory (deploy's teardown still runs)";
  const which = keep.policy.value === "failed" ? "A failed verification keeps" : "Every verification keeps";
  return `${which} ${what} for ${keep.hours.value} ${keep.hours.value === 1 ? "hour" : "hours"}, then it is deleted.`;
}

export function slotLine(slot: KeptSlot): string | null {
  if (slot.namespace) return `kubectl${slot.context ? ` --context ${slot.context}` : ""} -n ${slot.namespace}`;
  return slot.leaseDir;
}

function ValueRow({ envId, v, onSaved }: { envId: string; v: EnvValueView; onSaved: () => void }) {
  const [value, setValue] = useState(v.value);
  const [note, setNote] = useState(v.note);
  const action = useAction();
  const dirty = value !== v.value || note !== v.note;
  const save = () => api(`/api/environments/${envId}/values`, { body: { name: v.name, value, note, source: v.source } }).then(onSaved);
  return (
    <form
      className="item"
      style={{ alignItems: "flex-start" }}
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(save);
      }}
    >
      <div className="body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="goal mono">{v.name}</div>
        <div className="facts">
          <span>{v.source}</span>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13 }}>
          Value
          <input className="mono" value={value} onChange={(e) => setValue(e.target.value)} style={field} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13 }}>
          Note for agents
          <input value={note} onChange={(e) => setNote(e.target.value)} style={field} />
        </label>
        {action.error && (
          <div className="s-bell" style={{ fontSize: 13 }}>
            {action.error}
          </div>
        )}
      </div>
      <div className="actions">
        <button className="btn sm lamp" type="submit" disabled={!dirty || action.busy}>
          Save
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => (await api(`/api/environments/${envId}/values/${encodeURIComponent(v.name)}/delete`, { body: {} }), onSaved()))
          }
        >
          Remove
        </button>
      </div>
    </form>
  );
}

function AddValue({ envId, onAdded }: { envId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const action = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await api(`/api/environments/${envId}/values`, { body: { name: name.trim(), value, note } });
          setName("");
          setValue("");
          setNote("");
          onAdded();
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}
    >
      <div className="muted" style={{ fontSize: 13 }}>
        Add a value
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label className="sr-only" htmlFor={`add-name-${envId}`}>
          Name
        </label>
        <input
          id={`add-name-${envId}`}
          className="mono"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="NAME"
          style={{ ...field, width: 180 }}
        />
        <label className="sr-only" htmlFor={`add-value-${envId}`}>
          Value
        </label>
        <input
          id={`add-value-${envId}`}
          className="mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          style={{ ...field, flex: "1 1 180px", width: "auto" }}
        />
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note for agents" aria-label="Note for agents" style={field} />
      <div>
        <button className="btn sm lamp" type="submit" disabled={action.busy || !name.trim()}>
          Add value
        </button>
      </div>
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </div>
      )}
    </form>
  );
}

function Kept({ envId, slots, onChanged }: { envId: string; slots: KeptSlot[]; onChanged: () => void }) {
  const action = useAction();
  if (!slots.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 13 }}>
        Kept
      </div>
      {slots.map((slot) => {
        const line = slotLine(slot);
        return (
          <div key={slot.leaseId} className="facts" style={{ flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Link to={`/a/${slot.attemptId}`}>
              {slot.unit.projectId} · A{slot.agentNo} for U{slot.unit.seq}
            </Link>
            <span>{slot.reason}</span>
            <span>until {clock(slot.until)}</span>
            {line && (
              <input
                className="mono"
                readOnly
                value={line}
                aria-label={`Command for ${envId} slot ${slot.leaseId}`}
                onFocus={(e) => e.currentTarget.select()}
                style={{ ...field, width: "auto", flex: "1 1 220px" }}
              />
            )}
            <button
              className="btn sm"
              type="button"
              disabled={action.busy}
              onClick={() => void action.run(async () => (await api(`/api/leases/${slot.leaseId}/delete-kept`, { body: {} }), onChanged()))}
            >
              Delete
            </button>
          </div>
        );
      })}
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </div>
      )}
    </div>
  );
}

function SaveTemplate({ envId, names }: { envId: string; names: string[] }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ask, setAsk] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  const toggle = (valueName: string) => setAsk((cur) => (cur.includes(valueName) ? cur.filter((n) => n !== valueName) : [...cur, valueName]));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const r = await api<{ template: { name: string } }>(`/api/environments/${envId}/template`, { body: { name: name.trim(), description, ask } });
          setSaved(r.template.name);
          setName("");
          setDescription("");
          setAsk([]);
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}
    >
      <div className="muted" style={{ fontSize: 13 }}>
        Save as template
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="template name"
          aria-label="Template name"
          style={{ ...field, width: 180 }}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="description (optional)"
          aria-label="Template description"
          style={{ ...field, flex: "1 1 180px", width: "auto" }}
        />
      </div>
      {names.length > 0 && (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 10 }}>
          <legend className="muted" style={{ fontSize: 13, padding: 0 }}>
            Ask for these when the template is applied
          </legend>
          {names.map((valueName) => (
            <label key={valueName} className="mono" style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={ask.includes(valueName)} onChange={() => toggle(valueName)} />
              {valueName}
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <button className="btn sm" type="submit" disabled={action.busy || !name.trim()}>
          Save template
        </button>
      </div>
      {saved && <div style={{ fontSize: 13 }}>Saved template {saved}. Share it with Export under Templates.</div>}
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </div>
      )}
    </form>
  );
}

export function EnvironmentValues({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, reload } = useApi<EnvironmentDetail>(`/api/environments/${id}`);
  const presets = useAction();
  const notes = useAction();
  const [noteText, setNoteText] = useState<string | null>(null);
  const refresh = () => {
    reload();
    onChanged();
  };
  if (error && !data) return <div className="s-bell">{error}</div>;
  if (!data) return <div className="muted">Loading values…</div>;
  const text = noteText ?? data.environment.notes;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <div style={{ fontSize: 13 }}>
        {keepLine(data.keep)} <span className="muted">Change this in Settings.</span>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13 }}>
        Notes for agents
        <textarea value={text} onChange={(e) => setNoteText(e.target.value)} rows={2} style={{ ...field, resize: "vertical" }} />
      </label>
      <div>
        <button
          className="btn sm lamp"
          type="button"
          disabled={notes.busy || text === data.environment.notes}
          onClick={() => void notes.run(async () => (await api(`/api/environments/${id}/notes`, { body: { notes: text } }), refresh()))}
        >
          Save notes
        </button>
      </div>
      {notes.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {notes.error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Add from a preset
        </span>
        {data.presets.map((preset) => (
          <button
            key={preset.id}
            className="btn sm"
            type="button"
            disabled={presets.busy}
            onClick={() => void presets.run(async () => (await api(`/api/environments/${id}/presets/${preset.id}`, { body: {} }), refresh()))}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {presets.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {presets.error}
        </div>
      )}
      {data.values.length === 0 && <div className="empty">No values yet. Add one, or start from a preset.</div>}
      {data.values.map((v) => (
        <ValueRow key={`${v.name}:${v.value}:${v.note}:${v.source}`} envId={id} v={v} onSaved={refresh} />
      ))}
      <AddValue envId={id} onAdded={refresh} />
      <Kept envId={id} slots={data.kept} onChanged={refresh} />
      <SaveTemplate envId={id} names={data.values.map((v) => v.name)} />
    </div>
  );
}

export function NewFromTemplate({ onAdded }: { onAdded: () => void }) {
  const { data, error } = useApi<EnvTemplateFile[]>("/api/templates");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [display, setDisplay] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const action = useAction();
  const templates = (data ?? []).filter((item) => item.template);
  const chosen = templates.find((item) => item.template!.name === name)?.template ?? null;
  const asks = chosen?.values.filter((v) => v.ask) ?? [];
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return null;
  if (!templates.length) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await api(`/api/templates/${encodeURIComponent(name)}/apply`, { body: { id: id.trim(), name: display.trim() || undefined, answers } });
          setId("");
          setDisplay("");
          setAnswers({});
          onAdded();
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0", borderTop: "1px solid var(--line2)" }}
    >
      <div className="gh">
        <h2 className="h2">New from template</h2>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label className="sr-only" htmlFor="template-name">
          Template
        </label>
        <select id="template-name" className="mono" value={name} onChange={(e) => setName(e.target.value)} style={{ ...field, width: "auto" }}>
          <option value="">Choose a template</option>
          {templates.map((item) => (
            <option key={item.template!.name} value={item.template!.name}>
              {item.template!.name}
              {item.template!.description ? ` — ${item.template!.description}` : ""}
            </option>
          ))}
        </select>
        <input
          className="mono"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="new id"
          aria-label="New environment id"
          style={{ ...field, width: 160 }}
        />
        <input
          value={display}
          onChange={(e) => setDisplay(e.target.value)}
          placeholder="name (optional)"
          aria-label="New environment name"
          style={{ ...field, flex: "1 1 160px", width: "auto" }}
        />
        <button className="btn lamp" type="submit" disabled={action.busy || !name || !id.trim()}>
          {action.busy ? "Creating…" : "Create"}
        </button>
      </div>
      {asks.map((v) => (
        <label key={v.name} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13 }}>
          {v.name}
          <span className="muted">{v.note}</span>
          <input
            className="mono"
            value={answers[v.name] ?? ""}
            placeholder={v.value}
            onChange={(e) => setAnswers((cur) => ({ ...cur, [v.name]: e.target.value }))}
            style={field}
          />
        </label>
      ))}
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </div>
      )}
    </form>
  );
}

// Templates live in yagura's store; Export gives the YAML to send a teammate, who pastes it into Import.
export function Templates() {
  const { data, error, reload } = useApi<EnvTemplateFile[]>("/api/templates");
  const [open, setOpen] = useState<{ name: string; yaml: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [yaml, setYaml] = useState("");
  const action = useAction();
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 className="h2">Templates</h2>
      {data.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          None yet. Save one from an environment's Values, or import a teammate's below.
        </div>
      )}
      {data.map((item) => (
        <div key={item.name} style={{ borderTop: "1px solid var(--line2)", padding: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className="mono">{item.name}</span>
            {item.template ? (
              <span className="muted" style={{ fontSize: 13 }}>
                {item.template.provider} · {item.template.capacity} slots
                {item.template.values.some((v) => v.ask)
                  ? ` · asks ${item.template.values
                      .filter((v) => v.ask)
                      .map((v) => v.name)
                      .join(", ")}`
                  : ""}
                {item.template.description ? ` · ${item.template.description}` : ""}
              </span>
            ) : (
              <span className="s-bell" style={{ fontSize: 13 }}>
                {item.error}
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                className="btn sm"
                type="button"
                onClick={() =>
                  void action.run(async () =>
                    setOpen(
                      open?.name === item.name ? null : { name: item.name, yaml: await apiText(`/api/templates/${encodeURIComponent(item.name)}/export`) },
                    ),
                  )
                }
              >
                {open?.name === item.name ? "Hide YAML" : "Export"}
              </button>
              {confirm === item.name ? (
                <>
                  <button
                    className="btn sm bell"
                    type="button"
                    onClick={() =>
                      void action.run(
                        async () => (await api(`/api/templates/${encodeURIComponent(item.name)}/delete`, { body: {} }), setConfirm(null), reload()),
                      )
                    }
                  >
                    Delete {item.name}
                  </button>
                  <button className="btn sm" type="button" onClick={() => setConfirm(null)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button className="btn sm" type="button" onClick={() => setConfirm(item.name)}>
                  Delete
                </button>
              )}
            </span>
          </div>
          {open?.name === item.name && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <textarea
                readOnly
                aria-label={`${item.name} as YAML`}
                rows={Math.min(18, open.yaml.split("\n").length + 1)}
                value={open.yaml}
                className="mono"
                style={{ ...field, fontSize: 12 }}
              />
              <div>
                <button className="btn sm" type="button" onClick={() => void navigator.clipboard?.writeText(open.yaml).catch(() => undefined)}>
                  Copy YAML
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api("/api/templates/import", { body: { yaml } });
            setYaml("");
            reload();
          });
        }}
        style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--line2)", paddingTop: 8 }}
      >
        <label htmlFor="template-import" className="muted" style={{ fontSize: 13 }}>
          Import a template: paste its YAML (a template with the same name is replaced)
        </label>
        <textarea
          id="template-import"
          rows={4}
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          className="mono"
          style={{ ...field, fontSize: 12 }}
          placeholder="name: spring-kube&#10;provider: kube-namespace&#10;…"
        />
        <div>
          <button className="btn sm" type="submit" disabled={action.busy || !yaml.trim()}>
            Import
          </button>
        </div>
      </form>
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </div>
      )}
    </div>
  );
}
