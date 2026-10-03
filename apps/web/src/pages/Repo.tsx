import { useEffect, useMemo, useRef, useState } from "react";
import { DiffPanel, type DiffData } from "../ui/evidence";
import { useApi, useQuery, type CommitUnit, type FileView, type StoryEntry, type UnitStory } from "../api";
import { clock } from "../lib/format";
import { Inline } from "../lib/markdown";
import { followTheme, languageOf, monaco } from "../lib/monaco";
import { Link } from "../ui/Link";
import { DisagreeForm } from "./Unit";

type Tab = { kind: "file"; path: string } | { kind: "change"; sha: string; label: string };
const firstSentence = (text: string) => {
  const s = text.split("\n")[0]!.split(/(?<=[.!?])\s/)[0]!;
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
};
const tabKey = (t: Tab) => (t.kind === "file" ? `f:${t.path}` : `c:${t.sha}`);
const short = (sha: string) => sha.slice(0, 7);
const unitLabel = (c: CommitUnit | undefined, projectId: string | null) =>
  !c || c.seq === null ? "—" : c.projectId === projectId ? `U${c.seq}` : `${c.projectId}/U${c.seq}`;
const COLOURS = 5;

function Tree({ files, open, onOpen }: { files: string[]; open: string | null; onOpen: (path: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        open
          ? open
              .split("/")
              .slice(0, -1)
              .map((_, i, a) => a.slice(0, i + 1).join("/"))
          : [],
      ),
  );
  const rows = useMemo(() => {
    const dirs = new Set<string>();
    for (const f of files)
      f.split("/")
        .slice(0, -1)
        .forEach((_, i, a) => dirs.add(a.slice(0, i + 1).join("/")));
    const entries = [...[...dirs].map((d) => ({ path: d, dir: true })), ...files.map((f) => ({ path: f, dir: false }))];
    return entries.sort((a, b) => {
      const pa = a.path.split("/");
      const pb = b.path.split("/");
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] === pb[i]) continue;
        const aDir = i < pa.length - 1 || a.dir;
        const bDir = i < pb.length - 1 || b.dir;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return pa[i]!.localeCompare(pb[i]!);
      }
      return pa.length - pb.length;
    });
  }, [files]);
  const visible = (path: string) =>
    path
      .split("/")
      .slice(0, -1)
      .every((_, i, a) => expanded.has(a.slice(0, i + 1).join("/")));
  return (
    <div className="repo-tree">
      {rows
        .filter((r) => visible(r.path))
        .map((r) => {
          const depth = r.path.split("/").length - 1;
          const name = r.path.split("/").at(-1);
          return r.dir ? (
            <button
              key={r.path}
              type="button"
              className="repo-node dir"
              style={{ paddingLeft: 10 + depth * 12 }}
              onClick={() =>
                setExpanded((e) => {
                  const next = new Set(e);
                  if (next.has(r.path)) next.delete(r.path);
                  else next.add(r.path);
                  return next;
                })
              }
            >
              <span className="repo-mark">{expanded.has(r.path) ? "▾" : "▸"}</span>
              {name}
            </button>
          ) : (
            <button
              key={r.path}
              type="button"
              className={`repo-node${r.path === open ? " on" : ""}`}
              style={{ paddingLeft: 22 + depth * 12 }}
              onClick={() => onOpen(r.path)}
            >
              {name}
            </button>
          );
        })}
    </div>
  );
}

function History({
  repoId,
  projectOf,
  path,
  active,
  onPick,
}: {
  repoId: string;
  projectOf: (c: CommitUnit) => string;
  path: string | null;
  active: string | null;
  onPick: (c: CommitUnit) => void;
}) {
  const [only, setOnly] = useState(false);
  const { data, error } = useApi<CommitUnit[]>(`/api/repos/${repoId}/history${only && path ? `?path=${encodeURIComponent(path)}` : ""}`);
  return (
    <div>
      <div className="repo-h3">Landed on trunk</div>
      {path && (
        <label className="repo-only">
          <input id="repo-only-file" type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only units that touched{" "}
          {path.split("/").at(-1)}
        </label>
      )}
      {error && <div className="s-bell repo-pad">{error}</div>}
      {data?.map((c) => (
        <button key={c.sha} type="button" className={`repo-commit${active === c.sha ? " on" : ""}`} onClick={() => onPick(c)}>
          <span className="repo-commit-meta mono">
            <b>{projectOf(c)}</b> · {clock(c.date)} · {short(c.sha)}
          </span>
          <span className="repo-commit-subject">
            <Inline text={c.subject} />
          </span>
        </button>
      ))}
      {data && !data.length && <div className="muted repo-pad">No landed unit touched this file.</div>}
    </div>
  );
}

function CodeView({
  repoId,
  path,
  projectId,
  line,
  onPick,
}: {
  repoId: string;
  path: string;
  projectId: string | null;
  line: number | null;
  onPick: (c: CommitUnit) => void;
}) {
  const { data: file, error } = useApi<FileView>(`/api/repos/${repoId}/file?path=${encodeURIComponent(path)}`);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  useEffect(() => {
    if (!host.current) return;
    followTheme();
    editor.current = monaco.editor.create(host.current, {
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12.5,
      lineDecorationsWidth: 48,
      renderLineHighlight: "line",
      contextmenu: false,
    });
    return () => {
      editor.current?.getModel()?.dispose();
      editor.current?.dispose();
    };
  }, []);
  useEffect(() => {
    const ed = editor.current;
    if (!ed || !file || file.text === null) return;
    const old = ed.getModel();
    ed.setModel(monaco.editor.createModel(file.text, languageOf(path)));
    old?.dispose();
    // The gutter: each block of lines carries the unit that last wrote it, in that unit's colour.
    const colour = new Map<string, number>();
    const labels: string[] = [];
    const decorations = file.blame.map((sha, i) => {
      if (!colour.has(sha)) colour.set(sha, colour.size % COLOURS);
      const start = i === 0 || file.blame[i - 1] !== sha;
      const label = unitLabel(file.commits[sha], projectId);
      if (start) labels.push(`.yg-l-${short(sha)}::after{content:${JSON.stringify(label)}}`);
      return {
        range: new monaco.Range(i + 1, 1, i + 1, 1),
        options: { isWholeLine: true, linesDecorationsClassName: `yg-u yg-c${colour.get(sha)}${start ? ` yg-l-${short(sha)}` : ""}` },
      };
    });
    let style = document.getElementById("yg-unit-labels");
    if (!style) {
      style = document.createElement("style");
      style.id = "yg-unit-labels";
      document.head.appendChild(style);
    }
    style.textContent = labels.join("\n");
    const collection = ed.createDecorationsCollection(decorations);
    if (line && line <= file.blame.length) {
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
      const sha = file.blame[line - 1];
      if (sha && file.commits[sha]) onPick(file.commits[sha]!);
    }
    const pickLine = (line: number | undefined) => {
      const sha = line ? file.blame[line - 1] : undefined;
      if (sha && file.commits[sha]) onPick(file.commits[sha]!);
    };
    // A click on an editor without focus only focuses it, so the mouse is read directly; the cursor covers the keyboard.
    const subs = [ed.onMouseDown((e) => pickLine(e.target.position?.lineNumber)), ed.onDidChangeCursorPosition((e) => pickLine(e.position.lineNumber))];
    return () => {
      subs.forEach((x) => x.dispose());
      collection.clear();
    };
  }, [file, path, projectId, line, onPick]);
  if (error) return <div className="s-bell repo-pad">{error}</div>;
  if (file?.binary) return <div className="muted repo-pad">{path} is a binary file.</div>;
  if (file?.tooLarge) return <div className="muted repo-pad">{path} is over 1 MB, too large to show here.</div>;
  return <div ref={host} className="repo-monaco" />;
}

function ChangeView({ repoId, sha, projectOf, onOpen }: { repoId: string; sha: string; projectOf: (c: CommitUnit) => string; onOpen: (path: string) => void }) {
  const { data, error } = useApi<{
    commit: CommitUnit;
    base: string;
    files: string[];
    stats: Record<string, { added: number; removed: number }>;
    truncated: boolean;
  }>(`/api/repos/${repoId}/change/${sha}`);
  const diff = useApi<DiffData>(data ? `/api/repos/${repoId}/diff-files?base=${data.base}&head=${data.commit.sha}` : null);
  if (error) return <div className="s-bell repo-pad">{error}</div>;
  if (!data) return <div className="muted repo-pad">Loading…</div>;
  return (
    <div className="repo-change">
      <div className="repo-change-head">
        <div>
          <b>{projectOf(data.commit)}</b> · <Inline text={data.commit.subject} />
        </div>
        {data.commit.verdict && <div className="s-pine">✓ {data.commit.verdict}</div>}
        <div className="muted mono" style={{ fontSize: 12 }}>
          landed {clock(data.commit.date)} · {short(data.commit.sha)}
        </div>
      </div>
      <div className="repo-pad">
        {diff.error && <div className="s-bell">{diff.error}</div>}
        {!diff.data && !diff.error && <div className="muted">Loading the diff…</div>}
        {diff.data && <DiffPanel data={diff.data} stats={data.stats} onOpen={onOpen} />}
        {data.truncated && <div className="muted">The rest of this change is too large to show.</div>}
      </div>
    </div>
  );
}

function Rail({ commit, mode, onShowChange }: { commit: CommitUnit | null; mode: "line" | "change"; onShowChange: (c: CommitUnit) => void }) {
  const known = commit?.projectId && commit.seq !== null;
  const { data: story, reload } = useApi<UnitStory>(known ? `/api/projects/${commit!.projectId}/units/${commit!.seq}/story` : null);
  const [disagreeing, setDisagreeing] = useState(false);
  useEffect(() => setDisagreeing(false), [commit?.sha]);
  if (!commit) return <aside className="repo-rail muted">Select a line to see the unit behind it.</aside>;
  const lines = story?.entries.filter((e) => e.lines.length && e.actor !== "yagura").flatMap((e) => e.lines) ?? [];
  const all: StoryEntry | null = story && lines.length ? { ...story.entries[0]!, lines } : null;
  return (
    <aside className="repo-rail">
      <div className="repo-rail-who">{mode === "change" ? "This change is" : "Selected line written by"}</div>
      <h4 className="serif">
        {known ? `${commit.projectId}/U${commit.seq}` : short(commit.sha)} · <Inline text={story?.unit.goal.split(/[.;]\s/)[0] ?? commit.subject} />
      </h4>
      {commit.verdict ? (
        <div className="s-pine repo-small">✓ {commit.verdict}</div>
      ) : (
        !known && <div className="muted repo-small">Not landed by yagura: no verdict to show.</div>
      )}
      <div className="muted repo-small">
        {commit.author} · landed {clock(commit.date)} · {short(commit.sha)}
      </div>
      {story && (
        <>
          <div className="repo-rail-who">Its story</div>
          <ul className="repo-rail-story">
            {story.entries.map((e, i) => (
              <li key={i}>
                <b>{e.who}</b>
                {e.status ? ` · ${e.status.text}` : ""}
                {e.lines[0] ? (
                  <>
                    {": "}
                    <Inline text={firstSentence(e.lines[0].text)} />
                  </>
                ) : e.body ? (
                  <>
                    {": "}
                    <Inline text={firstSentence(e.body)} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="repo-links">
        {known && <Link to={`/p/${commit.projectId}/u/${commit.seq}`}>Open the full story</Link>}
        {mode === "line" && (
          <button type="button" className="linkish" onClick={() => onShowChange(commit)}>
            Show this change
          </button>
        )}
      </div>
      {known && all && !disagreeing && (
        <div>
          <button type="button" className="btn sm story-disagree" onClick={() => setDisagreeing(true)}>
            Disagree…
          </button>
        </div>
      )}
      {known && all && disagreeing && (
        <DisagreeForm
          projectId={commit.projectId!}
          seq={commit.seq!}
          entry={all}
          onDone={() => {
            setDisagreeing(false);
            reload();
          }}
        />
      )}
    </aside>
  );
}

export default function Repo({ id }: { id: string }) {
  const { data: tree, error } = useApi<{ head: string; branch: string; files: string[] }>(`/api/repos/${id}/tree`);
  const { data: repos } = useApi<{ repo: { id: string }; projects: { id: string }[] }[]>("/api/repos");
  const [side, setSide] = useState<"explorer" | "history">("explorer");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [picked, setPicked] = useState<CommitUnit | null>(null);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const projectId = repos?.find((r) => r.repo.id === id)?.projects.length === 1 ? repos.find((r) => r.repo.id === id)!.projects[0]!.id : null;
  const projectOf = (c: CommitUnit) => (c.seq === null ? short(c.sha) : unitLabel(c, projectId));
  const open = (t: Tab) => {
    setTabs((ts) => (ts.some((x) => tabKey(x) === tabKey(t)) ? ts : [...ts, t]));
    setActive(tabKey(t));
    if (t.kind === "file") setLastFile(t.path);
  };
  // Other pages link here at a change, a file, or a line: ?change=<sha>&file=<path>&line=<n>&from=<project>/<seq>.
  const query = useQuery();
  const from = /^([a-z][a-z0-9-]*)\/(\d+)$/.exec(query.get("from") ?? "");
  const line = Number(query.get("line")) || null;
  useEffect(() => {
    if (!tree || tabs.length) return;
    const change = query.get("change");
    const file = query.get("file");
    if (change) open({ kind: "change", sha: change, label: from ? `U${from[2]}` : short(change) });
    if (file && tree.files.includes(file)) open({ kind: "file", path: file });
    if (!change && !(file && tree.files.includes(file))) {
      const first = tree.files.find((f) => /^readme/i.test(f)) ?? tree.files[0];
      if (first) open({ kind: "file", path: first });
    }
  }, [tree]);
  const current = tabs.find((t) => tabKey(t) === active) ?? null;
  const filePath = current?.kind === "file" ? current.path : lastFile;
  // Arriving from a unit's change, the side panel is about that change until a line is picked.
  const arrivedAt = query.get("change");
  const railSha = current?.kind === "change" ? current.sha : arrivedAt;
  const { data: changeCommit } = useApi<{ commit: CommitUnit }>(railSha ? `/api/repos/${id}/change/${railSha}` : null);
  if (error)
    return (
      <main style={{ padding: 36 }} className="s-bell">
        {error}
      </main>
    );
  if (!tree)
    return (
      <main style={{ padding: 36 }} className="muted">
        Loading {id}…
      </main>
    );
  const showingChange = current?.kind === "change" || (picked === null && arrivedAt !== null);
  const railCommit = current?.kind === "change" ? (changeCommit?.commit ?? null) : (picked ?? changeCommit?.commit ?? null);
  return (
    <main className="repo">
      <div className="repo-bar">
        <b>{id}</b>
        <span className="mono">
          {tree.branch} @ {short(tree.head)}
        </span>
        <span>read-only</span>
        {from && (
          <span>
            opened from <Link to={`/p/${from[1]}/u/${from[2]}?tab=code`}>U{from[2]}'s change</Link>
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>{tree.files.length} files</span>
      </div>
      <div className="repo-body">
        <nav className="repo-side">
          <div className="repo-switch" role="tablist" aria-label="Side panel">
            {(["explorer", "history"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={side === v} className={side === v ? "on" : ""} onClick={() => setSide(v)}>
                {v === "explorer" ? "Explorer" : "History"}
              </button>
            ))}
          </div>
          {side === "explorer" ? (
            <Tree files={tree.files} open={current?.kind === "file" ? current.path : null} onOpen={(path) => open({ kind: "file", path })} />
          ) : (
            <History
              repoId={id}
              projectOf={projectOf}
              path={filePath}
              active={current?.kind === "change" ? current.sha : null}
              onPick={(c) => open({ kind: "change", sha: c.sha, label: projectOf(c) })}
            />
          )}
        </nav>
        <section className="repo-main">
          <div className="repo-tabs">
            {tabs.map((t) => (
              <div key={tabKey(t)} className={`repo-tab${tabKey(t) === active ? " on" : ""}`}>
                <button
                  type="button"
                  onClick={() => {
                    setActive(tabKey(t));
                    if (t.kind === "file") setLastFile(t.path);
                  }}
                >
                  {t.kind === "file" ? t.path.split("/").at(-1) : `${t.label} · change`}
                </button>
                <button
                  type="button"
                  aria-label="Close tab"
                  className="repo-tab-x"
                  onClick={() => {
                    const rest = tabs.filter((x) => tabKey(x) !== tabKey(t));
                    setTabs(rest);
                    if (active === tabKey(t)) setActive(rest.at(-1) ? tabKey(rest.at(-1)!) : null);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {current?.kind === "file" && (
            <CodeView
              key={current.path}
              repoId={id}
              path={current.path}
              projectId={projectId}
              line={current.path === query.get("file") ? line : null}
              onPick={setPicked}
            />
          )}
          {current?.kind === "change" && <ChangeView repoId={id} sha={current.sha} projectOf={projectOf} onOpen={(path) => open({ kind: "file", path })} />}
          {!current && <div className="muted repo-pad">Open a file from the explorer, or a change from the history.</div>}
        </section>
        <Rail commit={railCommit} mode={showingChange ? "change" : "line"} onShowChange={(c) => open({ kind: "change", sha: c.sha, label: projectOf(c) })} />
      </div>
    </main>
  );
}
