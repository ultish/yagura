import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { navigate } from "../api";

import { fitColumns, needed, type Fit } from "../lib/columns";

export interface Col extends Fit {
  num?: boolean;
}

export type Tone = "bell" | "lamp" | "pine" | "muted";

// A list of things, one line each. Columns keep their widths from one table to the next, so a page with several lists lines up.
export function Table({ cols, children }: { cols: Col[]; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  // As the room shrinks the columns leave in their drop order, and once the ones that stay do not fit the rows become cards.
  const [room, setRoom] = useState(Infinity);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const watch = new ResizeObserver(([e]) => setRoom(e!.contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const { shown, cards } = fitColumns(cols, room);
  // The cells are the pages' own: each is labelled with its column for the card layout, and hidden when its column has left.
  useLayoutEffect(() => {
    table.current?.querySelectorAll("tbody tr").forEach((tr) =>
      [...tr.children].forEach((td, i) => {
        td.setAttribute("data-label", cols[i]?.label ?? "");
        (td as HTMLElement).hidden = !shown.includes(cols[i]!);
      }),
    );
  });
  return (
    <div ref={wrap} className={`tbl-scroll${cards ? " tbl-cards" : ""}`}>
      <table ref={table} className="tbl" style={{ minWidth: cards ? 0 : needed(shown) }}>
        <colgroup>
          {shown.map((c) => (
            <col key={c.label} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {shown.map((c) => (
              <th key={c.label} className={c.num ? "tbl-num" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// A row that opens somewhere when it is clicked; the link in its first cell does the same for the keyboard.
export function TableRow({ to, children }: { to?: string; children: ReactNode }) {
  return (
    <tr className={`tbl-row${to ? " go" : ""}`} onClick={to ? () => navigate(to) : undefined}>
      {children}
    </tr>
  );
}

// What something is doing in a few words, with the one colour that says so: vermilion needs you, amber is at work, pine is done.
export function StatusCell({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <td className={`tbl-status tone-${tone}`}>
      <span className="tbl-dot" aria-hidden="true" />
      {children}
    </td>
  );
}

// Text of any length, cut to two lines, with the whole of it on hover.
export function ClampCell({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <td className="tbl-main">
      <div title={title}>{children}</div>
    </td>
  );
}
