import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

// Bundled by Vite, so the editor works on an air-gapped VM: no CDN, workers from our own build.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Monaco needs literal colours, so its themes are read from the dashboard's tokens whenever night or day changes.
export function applyTheme(): void {
  const day = document.documentElement.dataset.theme === "day";
  const name = day ? "yagura-day" : "yagura-night";
  const c = (v: string) => token(v).replace(/^#([0-9a-f]{3})$/i, (_, s: string) => `#${[...s].map((x) => x + x).join("")}`);
  monaco.editor.defineTheme(name, {
    base: day ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: c("--faint").slice(1), fontStyle: "italic" },
      { token: "keyword", foreground: c("--amber").slice(1) },
      { token: "string", foreground: c("--pine").slice(1) },
      { token: "number", foreground: c("--amber-text").slice(1) },
    ],
    colors: {
      "editor.background": c("--bg2"),
      "editor.foreground": c("--text"),
      "editorLineNumber.foreground": c("--faint"),
      "editorLineNumber.activeForeground": c("--soft"),
      "editor.lineHighlightBackground": `${c("--panel")}`,
      "editor.selectionBackground": `${c("--btnline")}`,
      "editorGutter.background": c("--bg2"),
      "editorWidget.background": c("--panel"),
      "scrollbarSlider.background": `${c("--line2")}aa`,
    },
  });
  monaco.editor.setTheme(name);
}

let watching = false;
export function followTheme(): void {
  applyTheme();
  if (watching) return;
  watching = true;
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

export function languageOf(path: string): string {
  const name = path.split("/").at(-1)!.toLowerCase();
  const ext = name.includes(".") ? `.${name.split(".").at(-1)}` : name;
  return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.map((f) => f.toLowerCase()).includes(name))?.id ?? "plaintext";
}

export { monaco };
