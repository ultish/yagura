import { useApi, type TurnCall, type TurnCalls as TurnCallsData } from "../api";

const OUTCOME = {
  ok: { label: "allowed", color: "var(--pine)", border: "var(--ok-border)" },
  error: { label: "ran · error", color: "var(--muted)", border: "var(--btnline)" },
  refused: { label: "refused", color: "var(--bell-text)", border: "var(--bad-border)" },
} as const;

const offset = (ms: number | null) => (ms === null ? "" : `+${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`);

export function summarizeCalls(calls: TurnCall[]) {
  const refused = calls.filter((c) => c.outcome === "refused").length;
  const errored = calls.filter((c) => c.outcome === "error").length;
  return { refused, errored, allowed: calls.length - refused - errored };
}

function Pill({ outcome }: { outcome: TurnCall["outcome"] }) {
  const o = OUTCOME[outcome];
  return (
    <span className="mono" style={{ fontSize: 11, padding: "1px 6px", borderRadius: 3, border: `1px solid ${o.border}`, color: o.color, whiteSpace: "nowrap" }}>
      {o.label}
    </span>
  );
}

function Row({ c }: { c: TurnCall }) {
  return (
    <details style={{ borderTop: "1px solid var(--line2)" }}>
      <summary
        style={{
          display: "grid",
          gridTemplateColumns: "48px 1fr auto",
          gap: 10,
          alignItems: "baseline",
          padding: "6px 10px",
          cursor: "pointer",
          listStyle: "none",
        }}
      >
        <span className="mono muted" style={{ fontSize: 11 }}>
          {offset(c.atMs)}
        </span>
        <span className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          <b>{c.name}</b> {c.arg}
          {c.why && (
            <div className="muted" style={{ fontFamily: "var(--sans, inherit)", fontSize: 12.5, marginTop: 2 }}>
              {c.why}
            </div>
          )}
        </span>
        {c.output === null ? (
          <span className="mono muted" style={{ fontSize: 11 }}>
            running
          </span>
        ) : (
          <Pill outcome={c.outcome} />
        )}
      </summary>
      {c.output !== null && (
        <pre
          className="mono"
          style={{
            margin: "0 10px 8px 68px",
            padding: "8px 10px",
            background: "var(--bg)",
            border: "1px solid var(--line2)",
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            color: "var(--soft)",
          }}
        >
          {c.output.trim() || "(no output)"}
        </pre>
      )}
    </details>
  );
}

function Box({ data, live }: { data: TurnCallsData; live: boolean }) {
  const { refused, errored, allowed } = summarizeCalls(data.calls);
  const last = data.calls.at(-1);
  return (
    <details
      style={{ margin: "0 0 10px", border: "1px solid var(--line2)", borderRadius: 4, background: "var(--bg)" }}
      open={live && data.calls.length <= 3 ? true : undefined}
    >
      <summary
        className="mono"
        style={{ padding: "7px 10px", cursor: "pointer", fontSize: 12.5, color: "var(--soft)", display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        <span>
          {live && (
            <span className="pulse" style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: "var(--lamp)", marginRight: 8 }} />
          )}
          {data.calls.length} tool {data.calls.length === 1 ? "call" : "calls"} · {allowed} allowed
          {errored > 0 && ` · ${errored} errored`}
          {refused > 0 && <span style={{ color: "var(--bell-text)" }}> · {refused} refused</span>}
        </span>
        {live && last && (
          <span className="muted">
            latest: {last.name} {last.arg.slice(0, 60)}
          </span>
        )}
      </summary>
      <div>
        {data.calls.map((c, i) => (
          <Row key={i} c={c} />
        ))}
      </div>
    </details>
  );
}

export function TurnCallsFor({ messageId }: { messageId: number }) {
  const r = useApi<TurnCallsData>(`/api/messages/${messageId}/calls`);
  return r.data && r.data.calls.length > 0 ? <Box data={r.data} live={false} /> : null;
}

export function LiveTurnCalls({ threadId }: { threadId: number }) {
  const r = useApi<TurnCallsData>(`/api/threads/${threadId}/live-calls`, { poll: 1500 });
  return r.data && r.data.calls.length > 0 ? <Box data={r.data} live /> : null;
}
