import { useEffect, useRef, useState } from "react";
import { streamUrl, useApi, type EvidenceRun } from "../api";
import { followTheme, languageOf, monaco } from "../lib/monaco";
import { duration, sha } from "../lib/format";
import { Link } from "./Link";

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

interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  old: string;
  new: string;
  binary: boolean;
  tooLarge: boolean;
}
const STATUS_MARK = { added: "A", modified: "M", deleted: "D" } as const;

// The same editor as the repo browser, in diff mode: both sides of the file, changes marked, unchanged stretches folded.
function FileDiff({ file, sideBySide }: { file: DiffFile; sideBySide: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    if (!host.current) return;
    followTheme();
    editor.current = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      renderSideBySide: sideBySide,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 4 },
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12.5,
      contextmenu: false,
    });
    return () => {
      const m = editor.current?.getModel();
      editor.current?.dispose();
      m?.original.dispose();
      m?.modified.dispose();
    };
  }, []);
  useEffect(() => editor.current?.updateOptions({ renderSideBySide: sideBySide }), [sideBySide]);
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    const before = ed.getModel();
    const language = languageOf(file.path);
    ed.setModel({ original: monaco.editor.createModel(file.old, language), modified: monaco.editor.createModel(file.new, language) });
    before?.original.dispose();
    before?.modified.dispose();
  }, [file]);
  const lines = file.old.split("\n").length + file.new.split("\n").length;
  return <div ref={host} className="diff-monaco" style={{ height: Math.min(Math.max(lines * 19 + 40, 160), 640) }} />;
}

export interface DiffData {
  base: string | null;
  head: string | null;
  files: DiffFile[] | null;
  omitted: number;
}

// The files of a change with Monaco's diff of the selected one; `stats` and `editorLink` add the counts and a way into the repo editor.
export function DiffPanel({
  data,
  stats,
  editorLink,
  onOpen,
}: {
  data: DiffData;
  stats?: Record<string, { added: number; removed: number }>;
  editorLink?: (path: string) => string;
  onOpen?: (path: string) => void;
}) {
  const [at, setAt] = useState(0);
  const [sideBySide, setSideBySide] = useState(false);
  if (data.files === null) return <div className="empty">No diff: this attempt has no committed head yet, or its commits are gone from the mirror.</div>;
  if (!data.files.length) return <div className="empty">The head is the same as trunk; nothing changed.</div>;
  const file = data.files[Math.min(at, data.files.length - 1)]!;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="facts">
        <span>
          trunk {sha(data.base)} → head {sha(data.head)}
        </span>
        <span>{data.files.length} files</span>
        {data.omitted > 0 && <span className="s-lamp">{data.omitted} more files not shown</span>}
        <span className="diff-mode" role="group" aria-label="Layout">
          <button type="button" className={!sideBySide ? "on" : ""} aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>
            Inline
          </button>
          <button type="button" className={sideBySide ? "on" : ""} aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>
            Side by side
          </button>
        </span>
      </div>
      <div className="diff-files" role="list">
        {data.files.map((f, i) => (
          <div key={f.path} role="listitem" className={`diff-file ${f.status}${f === file ? " on" : ""}`}>
            <button type="button" className="diff-name" onClick={() => setAt(i)} aria-current={f === file}>
              <span className="diff-mark">{STATUS_MARK[f.status]}</span>
              {f.path}
            </button>
            {stats?.[f.path] && (
              <>
                <span className="s-pine">+{stats[f.path]!.added}</span>
                <span className="s-bell">−{stats[f.path]!.removed}</span>
              </>
            )}
            {editorLink && f.status !== "deleted" && (
              <Link to={editorLink(f.path)} title="Open the whole file, each line tagged with the unit that wrote it">
                open whole file →
              </Link>
            )}
            {onOpen && f.status !== "deleted" && (
              <button type="button" className="diff-open" onClick={() => onOpen(f.path)}>
                open whole file →
              </button>
            )}
          </div>
        ))}
      </div>
      {file.binary ? (
        <div className="empty">{file.path} is a binary file.</div>
      ) : file.tooLarge ? (
        <div className="empty">{file.path} is over 1 MB, too large to show here.</div>
      ) : (
        <FileDiff file={file} sideBySide={sideBySide} />
      )}
    </div>
  );
}

export function DiffView({ attemptId }: { attemptId: number }) {
  const { data, error } = useApi<DiffData>(`/api/attempts/${attemptId}/diff-files`);
  if (error) return <div className="s-bell">{error}</div>;
  if (!data) return <div className="muted">Loading the diff…</div>;
  return <DiffPanel data={data} />;
}
