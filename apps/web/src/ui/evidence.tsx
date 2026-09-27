import { useEffect, useState } from "react";
import { streamUrl, useApi, type EvidenceRun } from "../api";
import { diffLines, type DiffLineKind } from "../lib/diff";
import { duration, sha } from "../lib/format";

interface ArtifactInfo {
  id: number;
  kind: string;
  name: string;
  bytes: number;
  contentType: string;
}

const PREVIEW_BYTES = 256 * 1024;
const pre = {
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 480,
  overflow: "auto",
  background: "var(--bg)",
  padding: 10,
  borderRadius: 4,
  margin: 0,
} as const;

function useText(url: string | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(streamUrl(url))
      .then((r) => r.text())
      .then((t) => !cancelled && setText(t));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return text;
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function TextArtifact({ a }: { a: ArtifactInfo }) {
  const text = useText(a.bytes <= PREVIEW_BYTES ? `/api/artifacts/${a.id}` : null);
  if (a.bytes > PREVIEW_BYTES)
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        Too large to preview ({kb(a.bytes)}). <a href={streamUrl(`/api/artifacts/${a.id}?download=1`)}>Download</a>
      </div>
    );
  return (
    <pre className="mono" style={pre}>
      {text ?? "…"}
    </pre>
  );
}

function Artifact({ a }: { a: ArtifactInfo }) {
  const url = streamUrl(`/api/artifacts/${a.id}`);
  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      <figcaption className="facts">
        <b>{a.name}</b>
        <span>{kb(a.bytes)}</span>
        <a href={streamUrl(`/api/artifacts/${a.id}?download=1`)}>download</a>
      </figcaption>
      {a.bytes === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Empty.
        </div>
      ) : a.contentType.startsWith("image/") ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img
            src={url}
            alt={a.name}
            style={{ maxWidth: "100%", maxHeight: 520, border: "1px solid var(--line2)", borderRadius: 4, background: "var(--bg)" }}
          />
        </a>
      ) : a.contentType.startsWith("text/") ? (
        <TextArtifact a={a} />
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          Binary file; download it to open.
        </div>
      )}
    </figure>
  );
}

export function RunView({ runId }: { runId: number }) {
  const { data, error } = useApi<{ run: EvidenceRun; artifacts: ArtifactInfo[] }>(`/api/evidence/${runId}`);
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return <div className="muted">Loading run {runId}…</div>;
  const r = data.run;
  const ok = r.exitCode === 0 && !r.timedOut && !r.tampered;
  const outcome = r.tampered ? "the checkout was edited, so this run does not count" : r.timedOut ? "timed out" : `exit ${r.exitCode}`;
  const files = data.artifacts.filter((a) => a.kind === "file");
  const streams = data.artifacts.filter((a) => a.kind !== "file" && (a.bytes > 0 || a.kind === "stdout"));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4 }}>
      <div>
        <div className={ok ? "s-pine" : "s-bell"} style={{ fontSize: 14 }}>
          r{r.id} {r.label} on {r.at === "base" ? "trunk" : "head"} {sha(r.sha)}: {outcome}, {duration(r.durationMs)}.
        </div>
        <pre className="mono" style={{ ...pre, marginTop: 8 }}>
          $ {r.command}
        </pre>
      </div>
      {streams.map((a) => (
        <Artifact key={a.id} a={a} />
      ))}
      {files.length > 0 ? (
        files.map((a) => <Artifact key={a.id} a={a} />)
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          The run saved no files. Anything a check writes to $YAGURA_EVIDENCE (screenshots, reports) shows up here.
        </div>
      )}
    </div>
  );
}

const DIFF_COLOR: Record<DiffLineKind, string> = {
  file: "var(--text)",
  hunk: "var(--amber)",
  add: "var(--pine)",
  del: "var(--faint)",
  meta: "var(--muted)",
  context: "var(--soft)",
};
const MAX_LINES = 5000;

export function DiffView({ attemptId }: { attemptId: number }) {
  const { data, error } = useApi<{ base: string | null; head: string | null; text: string | null; truncated: boolean }>(`/api/attempts/${attemptId}/diff`);
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return <div className="muted">Loading the diff…</div>;
  if (data.text === null) return <div className="empty">No diff: this attempt has no committed head yet, or its commits are gone from the mirror.</div>;
  if (!data.text) return <div className="empty">The head is the same as trunk; nothing changed.</div>;
  const lines = diffLines(data.text);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="facts">
        <span>
          trunk {sha(data.base)} → head {sha(data.head)}
        </span>
        {(data.truncated || lines.length > MAX_LINES) && <span className="s-lamp">showing the first {Math.min(lines.length, MAX_LINES)} lines</span>}
      </div>
      <pre className="mono" style={{ ...pre, maxHeight: "none", fontSize: 12.5 }}>
        {lines.slice(0, MAX_LINES).map((l, i) => (
          <div key={i} style={{ color: DIFF_COLOR[l.kind], fontWeight: l.kind === "file" ? 700 : 400, marginTop: l.kind === "file" && i ? 14 : 0 }}>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
