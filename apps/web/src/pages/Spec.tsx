import { useEffect, useRef, useState } from "react";
import { api, useApi } from "../api";
import { when } from "../lib/format";
import { followTheme, monaco } from "../lib/monaco";
import { Link } from "../ui/Link";
import { useAction } from "../ui/rows";

const BY: Record<string, string> = { watchman: "the watchman", developer: "you", imported: "imported from the old spec file" };

interface StoredSpec {
  text: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

// The project's spec lives in yagura's store; the watchman edits it by section, the developer edits it here.
export default function Spec({ projectId }: { projectId: string }) {
  const spec = useApi<StoredSpec>(`/api/projects/${projectId}/spec`);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [opened, setOpened] = useState<StoredSpec | null>(null);
  const openedRef = useRef<StoredSpec | null>(null);
  const [dirty, setDirty] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (!host.current) return;
    followTheme();
    editor.current = monaco.editor.create(host.current, {
      language: "markdown",
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineDecorationsWidth: 12,
    });
    const sub = editor.current.onDidChangeModelContent(() => setDirty(editor.current!.getValue() !== (openedRef.current?.text ?? "")));
    return () => {
      sub.dispose();
      editor.current?.getModel()?.dispose();
      editor.current?.dispose();
    };
  }, []);
  // Load the stored text once, and again only on an explicit reload, so a background refresh never replaces what you are typing.
  useEffect(() => {
    if (!spec.data || opened || !editor.current) return;
    openedRef.current = spec.data;
    setOpened(spec.data);
    editor.current.setValue(spec.data.text);
    setDirty(false);
  }, [spec.data, opened]);

  const save = () =>
    action.run(async () => {
      const saved = await api<StoredSpec>(`/api/projects/${projectId}/spec`, {
        method: "PUT",
        body: { text: editor.current!.getValue(), since: opened?.updatedAt ?? null },
      });
      openedRef.current = saved;
      setOpened(saved);
      setDirty(false);
    });
  const reload = () => {
    setOpened(null);
    spec.reload();
  };
  const changedElsewhere = !!(spec.data && opened && spec.data.updatedAt !== opened.updatedAt);
  return (
    <main style={{ padding: "22px 36px 24px", display: "flex", flexDirection: "column", gap: 12, height: "calc(100vh - 61px)", boxSizing: "border-box" }}>
      <div className="mono muted" style={{ fontSize: 12.5 }}>
        <Link to={`/p/${projectId}`}>{projectId}</Link> / spec
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h1 className="serif" style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>
          Spec
        </h1>
        <span className="muted" style={{ fontSize: 13 }}>
          {opened?.updatedAt ? `last changed by ${BY[opened.updatedBy ?? ""] ?? opened.updatedBy} · ${when(opened.updatedAt, null, false)}` : "no spec yet"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "baseline" }}>
          {dirty && (
            <span className="mono s-lamp" style={{ fontSize: 12 }}>
              unsaved
            </span>
          )}
          <button type="button" className="btn sm" onClick={reload} disabled={action.busy}>
            Reload
          </button>
          <button type="button" className="btn sm lamp" onClick={() => void save()} disabled={action.busy || !dirty}>
            Save
          </button>
        </span>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: -4 }}>
        The planner reads this before every plan, and saving asks it to look again. The watchman edits it a section at a time from your conversations.
      </div>
      {changedElsewhere && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          Changed by {BY[spec.data!.updatedBy ?? ""] ?? spec.data!.updatedBy} since you opened it. Reload to see it; saving now is refused.
        </div>
      )}
      {(action.error || spec.error) && (
        <div className="s-bell" style={{ fontSize: 13 }}>
          {action.error ?? spec.error}
        </div>
      )}
      <div ref={host} style={{ flexGrow: 1, minHeight: 300, border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }} />
    </main>
  );
}
