import { useEffect, useId, useRef, useState } from "react";
import { api, type Suggestion } from "../api";
import { mentionQuery } from "../lib/mention";


export function MentionInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api<Suggestion[]>(`/api/mentions?q=${encodeURIComponent(open.query)}`).then(
        (s) => {
          if (cancelled) return;
          setItems(s.slice(0, 8));
          setActive(0);
        },
        () => !cancelled && setItems([]),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open?.start, open?.query]);

  const refresh = (text: string) => {
    const caret = ref.current?.selectionStart ?? text.length;
    setOpen(mentionQuery(text, caret));
  };

  const pick = (s: Suggestion) => {
    if (!open) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, open.start)}@${s.token} ${value.slice(caret)}`;
    onChange(next);
    setOpen(null);
    requestAnimationFrame(() => {
      const pos = open.start + s.token.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const showList = open !== null && items.length > 0;
  return (
    <div style={{ position: "relative", flexGrow: 1 }}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${id}-opt-${active}` : undefined}
        rows={Math.min(8, Math.max(1, value.split("\n").length))}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value);
        }}
        onClick={() => refresh(value)}
        onBlur={() => setTimeout(() => setOpen(null), 150)}
        onKeyDown={(e) => {
          if (showList) {
            if (e.key === "ArrowDown") return e.preventDefault(), setActive((a) => (a + 1) % items.length);
            if (e.key === "ArrowUp") return e.preventDefault(), setActive((a) => (a - 1 + items.length) % items.length);
            if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pick(items[active]!);
            if (e.key === "Escape") return e.preventDefault(), setOpen(null);
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (value.trim()) onSubmit();
          }
        }}
        style={{ width: "100%", resize: "none", fontSize: 15, lineHeight: 1.45, background: "var(--bg)", border: `1px solid ${showList ? "var(--amber)" : "var(--btnline)"}`, borderRadius: 4, padding: "10px 12px" }}
      />
      {showList && (
        <ul id={`${id}-list`} role="listbox" aria-label="Mentions" style={{ position: "absolute", left: 0, bottom: "calc(100% + 6px)", width: "min(520px, 100%)", margin: 0, padding: "6px 0", listStyle: "none", background: "var(--panel)", border: "1px solid var(--btnline)", borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,.35)", zIndex: 10 }}>
          {items.map((s, i) => (
            <li
              key={s.token}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              style={{ display: "flex", gap: 10, padding: "7px 12px", cursor: "pointer", background: i === active ? "var(--line2)" : "transparent" }}
            >
              <span className="mono" style={{ fontSize: 13, color: "var(--amber)", minWidth: 130, flexShrink: 0 }}>
                {s.token}
              </span>
              <span style={{ fontSize: 13, color: "var(--soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
