import { useState } from "react";
import { api, useApi, useNow, type EnvironmentView } from "../api";
import { roleOf } from "../lib/units";
import { clock, plural, since } from "../lib/format";
import { Link } from "../ui/Link";
import { Row, useAction } from "../ui/rows";
import { ScopedSettings } from "../ui/settings";
import { EnvironmentValues, NewFromTemplate } from "./environment-values";

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "7px 10px", fontSize: 13 } as const;
const PROVIDERS = ["local-process", "kube-namespace"];

function occupancy(v: EnvironmentView): { text: string; tone: string } {
  if (!v.implemented) return { text: `The ${v.environment.provider} provider is not built yet, so agents cannot get a slot here.`, tone: "bell" };
  const { capacity } = v.environment;
  const waiting = v.queued.length ? `, ${v.queued.length} waiting` : "";
  if (capacity === 0) return { text: `No slots: capacity is 0, so nothing can verify here${waiting}.`, tone: v.queued.length ? "bell" : "muted" };
  return { text: `${v.active.length} of ${plural(capacity, "slot")} in use${waiting}.`, tone: v.active.length ? "lamp" : "muted" };
}

function doctor(v: EnvironmentView): string {
  const { doctorStatus, doctorCheckedAt } = v.environment;
  return doctorStatus === "unknown" ? "doctor not run yet" : `doctor ${doctorStatus} ${clock(doctorCheckedAt)}`;
}

function AddEnvironment({ onAdded }: { onAdded: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("2");
  const [provider, setProvider] = useState(PROVIDERS[0]!);
  const [context, setContext] = useState("");
  const [pool, setPool] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const action = useAction();
  const kube = provider === "kube-namespace";
  const providerConfig = kube
    ? {
        ...(context.trim() ? { context: context.trim() } : {}),
        ...(pool.trim()
          ? {
              mode: "pool",
              pool: pool
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean),
            }
          : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      }
    : {};
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await api("/api/environments", { body: { id: id.trim(), name: name.trim() || undefined, provider, capacity: Number(capacity), providerConfig } });
          setId("");
          setName("");
          onAdded();
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0", borderTop: "1px solid var(--line2)" }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label htmlFor="env-id" className="sr-only">
          Id
        </label>
        <input id="env-id" className="mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="id, e.g. dev-2" style={{ ...field, width: 160 }} />
        <label htmlFor="env-name" className="sr-only">
          Name
        </label>
        <input
          id="env-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (optional)"
          style={{ ...field, flexGrow: 1, minWidth: 180 }}
        />
        <label htmlFor="env-provider" className="sr-only">
          Provider
        </label>
        <select id="env-provider" className="mono" value={provider} onChange={(e) => setProvider(e.target.value)} style={field}>
          {PROVIDERS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label htmlFor="env-capacity" className="muted" style={{ fontSize: 13 }}>
          slots
        </label>
        <input
          id="env-capacity"
          className="mono"
          type="number"
          min={0}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          style={{ ...field, width: 70 }}
        />
        <button className="btn lamp" type="submit" disabled={action.busy || !id.trim()}>
          {action.busy ? "Running doctor…" : "Add environment"}
        </button>
      </div>
      {kube && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label htmlFor="env-context" className="sr-only">
            Kube context
          </label>
          <input
            id="env-context"
            className="mono"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="context (default: current)"
            style={{ ...field, width: 220 }}
          />
          <label htmlFor="env-pool" className="sr-only">
            Namespace pool
          </label>
          <input
            id="env-pool"
            className="mono"
            value={pool}
            onChange={(e) => setPool(e.target.value)}
            placeholder="pool: ns-a, ns-b (empty: yagura creates namespaces)"
            style={{ ...field, flexGrow: 1, minWidth: 260 }}
          />
          <label htmlFor="env-base-url" className="sr-only">
            Base URL pattern
          </label>
          <input
            id="env-base-url"
            className="mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="base URL, e.g. http://{namespace}.apps.local"
            style={{ ...field, width: 300 }}
          />
        </div>
      )}
      <div className="muted" style={{ fontSize: 13 }}>
        Verification runs inside a slot of the project's environment. local-process gives each slot a private directory and a free port on this machine.
        kube-namespace gives each slot its own namespace labelled yagura=1 (or one from your pool, where only yagura-labelled resources are deleted). Adding one
        runs its doctor; a Kubernetes environment is usable once the doctor passes.
      </div>
      {action.error && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </div>
      )}
    </form>
  );
}

function EditEnvironment({ v, onDone }: { v: EnvironmentView; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(v.environment.name);
  const [capacity, setCapacity] = useState(String(v.environment.capacity));
  const action = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await api(`/api/environments/${v.environment.id}`, { body: { name, capacity: Number(capacity) } });
          onDone();
        });
      }}
      style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}
    >
      <label htmlFor={`name-${v.environment.id}`} className="sr-only">
        Name
      </label>
      <input
        id={`name-${v.environment.id}`}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ ...field, flexGrow: 1, minWidth: 180 }}
      />
      <label htmlFor={`cap-${v.environment.id}`} className="muted" style={{ fontSize: 13 }}>
        slots
      </label>
      <input
        id={`cap-${v.environment.id}`}
        className="mono"
        type="number"
        min={0}
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
        style={{ ...field, width: 70 }}
      />
      <button className="btn sm lamp" type="submit" disabled={action.busy}>
        Save
      </button>
      <button className="btn sm" type="button" onClick={onDone}>
        Never mind
      </button>
      {!confirming ? (
        <button className="btn sm" type="button" style={{ marginLeft: "auto" }} onClick={() => setConfirming(true)}>
          Delete environment
        </button>
      ) : (
        <span style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", fontSize: 13 }}>
          <span className="s-bell">Delete {v.environment.id} with its values and settings?</span>
          <button
            className="btn sm bell"
            type="button"
            disabled={action.busy}
            onClick={() => void action.run(async () => (await api(`/api/environments/${v.environment.id}/delete`, { body: {} }), onDone()))}
          >
            Delete
          </button>
          <button className="btn sm" type="button" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </span>
      )}
      {Number(capacity) < v.active.length && (
        <span className="muted" style={{ fontSize: 13, width: "100%" }}>
          Slots in use now keep running; no new ones start until the count drops.
        </span>
      )}
      {action.error && (
        <span className="s-bell" style={{ fontSize: 13, width: "100%" }}>
          {action.error}
        </span>
      )}
    </form>
  );
}

function Doctor({ v, onRan }: { v: EnvironmentView; onRan: () => void }) {
  const action = useAction();
  const checks = v.environment.doctorChecks;
  const failing = v.environment.doctorStatus === "failing";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {checks.length > 0 && (
        <details open={failing}>
          <summary className="mono" style={{ fontSize: 12, cursor: "pointer", color: failing ? "var(--bell-text)" : "var(--muted)" }}>
            {checks.filter((c) => c.ok).length} of {checks.length} doctor checks pass
          </summary>
          <div className="facts" style={{ flexDirection: "column", gap: 2, marginTop: 4 }}>
            {checks.map((c) => (
              <span key={c.name} className={c.ok ? undefined : "s-bell"}>
                {c.ok ? "✓" : "✗"} <b>{c.name}</b> {c.detail}
              </span>
            ))}
          </div>
        </details>
      )}
      <div>
        <button
          className="btn sm"
          type="button"
          disabled={action.busy}
          onClick={() => void action.run(async () => (await api(`/api/environments/${v.environment.id}/doctor`, { body: {} }), onRan()))}
        >
          {action.busy ? "Running doctor…" : "Run doctor"}
        </button>
      </div>
      {action.error && (
        <span className="s-bell" style={{ fontSize: 13 }}>
          {action.error}
        </span>
      )}
    </div>
  );
}

function settingsOf(v: EnvironmentView): string | null {
  const c = v.environment.providerConfig as { context?: string; mode?: string; pool?: string[]; baseUrl?: string };
  if (v.environment.provider !== "kube-namespace") return null;
  return [`context ${c.context ?? "current"}`, c.mode === "pool" ? `pool ${c.pool?.join(", ")}` : "creates namespaces", c.baseUrl].filter(Boolean).join(" · ");
}

function Holders({ v }: { v: EnvironmentView }) {
  const now = useNow();
  if (!v.active.length && !v.queued.length) return null;
  const who = (h: EnvironmentView["active"][number] | EnvironmentView["queued"][number]) => (
    <Link to={`/a/${h.attemptId}`}>
      {h.unit.projectId} U{h.unit.seq} {roleOf(h.unit.type)}
    </Link>
  );
  return (
    <div className="facts" style={{ flexDirection: "column", gap: 2 }}>
      {v.active.map((h) => (
        <span key={`a-${h.attemptId}-${h.slot}`}>
          <b>{h.slot}</b> {who(h)} · {since(h.since, now)}
        </span>
      ))}
      {v.queued.map((h, i) => (
        <span key={`q-${h.attemptId}-${i}`}>
          <b>waiting {i + 1}</b> {who(h)} · {since(h.since, now)}
        </span>
      ))}
    </div>
  );
}

export function Environments() {
  const { data, error, reload } = useApi<EnvironmentView[]>("/api/environments");
  const [editing, setEditing] = useState<string | null>(null);
  const [settings, setSettings] = useState<string | null>(null);
  const [valuesFor, setValuesFor] = useState<string | null>(null);
  return (
    <main style={{ padding: "26px 36px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
      <h1 className="serif" style={{ margin: 0, fontSize: 34, fontWeight: 600 }}>
        Environments
      </h1>
      <section>
        <div className="gh">
          <h2 className="h2">Add an environment</h2>
        </div>
        <AddEnvironment onAdded={reload} />
        <NewFromTemplate onAdded={reload} />
      </section>
      {error && <div className="s-bell">{error}</div>}
      {data && (
        <section>
          <div className="gh">
            <h2 className="h2">Environments</h2>
            <span className="n">{data.length}</span>
          </div>
          {data.length === 0 && <div className="empty">No environments yet. The first project gets a local one automatically.</div>}
          {data.map((v) => {
            const o = occupancy(v);
            const e = v.environment;
            return (
              <Row
                key={e.id}
                seq={e.id}
                goal={
                  <>
                    {e.name}{" "}
                    <span className="mono muted" style={{ fontSize: 12.5 }}>
                      {e.provider}
                    </span>
                  </>
                }
                status={o.text}
                tone={o.tone}
                facts={
                  <>
                    <span>{doctor(v)}</span>
                    {settingsOf(v) && <span>{settingsOf(v)}</span>}
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
                  <>
                    <Holders v={v} />
                    <Doctor v={v} onRan={reload} />
                    {editing === e.id && (
                      <EditEnvironment
                        v={v}
                        onDone={() => {
                          setEditing(null);
                          reload();
                        }}
                      />
                    )}
                    {settings === e.id && <ScopedSettings scope="environment" id={e.id} />}
                    {valuesFor === e.id && <EnvironmentValues id={e.id} onChanged={reload} />}
                  </>
                }
                actions={
                  <>
                    <button className="btn" type="button" aria-expanded={valuesFor === e.id} onClick={() => setValuesFor(valuesFor === e.id ? null : e.id)}>
                      Values
                    </button>
                    <button className="btn" type="button" aria-expanded={settings === e.id} onClick={() => setSettings(settings === e.id ? null : e.id)}>
                      Settings
                    </button>
                    {editing !== e.id && (
                      <button className="btn" type="button" onClick={() => setEditing(e.id)}>
                        Edit
                      </button>
                    )}
                  </>
                }
              />
            );
          })}
        </section>
      )}
    </main>
  );
}
