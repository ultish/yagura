import { useEffect, useMemo, useRef, useState } from "react";
import { api, navigate, usePath, useQuery } from "../api";
import { groupHits, highlight, type FindResult } from "../lib/search";
import { Link } from "./Link";

export function Marked({ text, query }: { text: string; query: string }) {
  return <>{highlight(text, query).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

const PER_KIND = 3;

// Results drop down while the box has focus; a result opens its page, "all results" opens the results page.
export function SearchBox() {
  const path = usePath();
  const urlQ = useQuery().get("q") ?? "";
  const [q, setQ] = useState(path === "/search" ? urlQ : "");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [result, setResult] = useState<FindResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (path === "/search") setQ(urlQ);
  }, [path, urlQ]);

  useEffect(() => {
    if (!q.trim()) return setResult(null);
    let stale = false;
    const t = setTimeout(() => {
      api<FindResult>(`/api/find?q=${encodeURIComponent(q)}&per=${PER_KIND}`)
        .then((r) => !stale && (setResult(r), setSel(0)))
        .catch(() => undefined);
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => (result ? groupHits(result) : []), [result]);
  const flat = groups.flatMap((g) => g.hits);
  const all = `/search?q=${encodeURIComponent(q.trim())}`;
  const go = (to: string) => {
    setOpen(false);
    input.current?.blur();
    navigate(to);
  };
  const shown = open && q.trim() !== "" && result !== null && result.query === q.trim();

  return (
    <div className="search" role="search">
      <label htmlFor="search" className="sr-only">
        Search yagura
      </label>
      <input
        id="search"
        ref={input}
        className="mono"
        value={q}
        placeholder="Search: words, a commit, an issue, U3"
        autoComplete="off"
        role="combobox"
        aria-expanded={shown}
        aria-controls="search-results"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setSel((s) => Math.min(s + 1, flat.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter" && q.trim()) {
            e.preventDefault();
            go(shown && flat[sel] ? flat[sel]!.href : all);
          }
        }}
      />
      <kbd className="search-key">/</kbd>
      {shown && (
        <div id="search-results" className="search-drop" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {!result.total && <div className="search-empty">Nothing matches “{q.trim()}”.</div>}
          {groups.map((g) => (
            <div key={g.kind} className="search-group">
              <div className="search-gh">
                {g.label} · {g.count}
              </div>
              {g.hits.map((h) => {
                const i = flat.indexOf(h);
                return (
                  <Link
                    key={`${h.kind}:${h.href}:${i}`}
                    to={h.href}
                    role="option"
                    aria-selected={i === sel}
                    className="search-row"
                    onMouseEnter={() => setSel(i)}
                    onClick={() => setOpen(false)}
                  >
                    <span className="search-ref mono">{h.ref}</span>
                    <span className="search-text">
                      <Marked text={h.kind === "handoff" || h.kind === "message" || h.kind === "review" ? h.text : h.title} query={q} />
                    </span>
                    <span className="search-meta mono">{h.meta}</span>
                  </Link>
                );
              })}
            </div>
          ))}
          <div className="search-foot mono">
            <span>↑↓ to move · Enter to open · Esc to close</span>
            <Link to={all} onClick={() => setOpen(false)}>
              all {result.total} results →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
