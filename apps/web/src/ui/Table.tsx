import { useLayoutEffect, useRef, type ReactNode } from "react";
import { navigate } from "../api";

export interface Col {
  label: string;
  // Pixels; the one column left without a width takes what the others leave.
  width?: number;
  num?: boolean;
}

export type Tone = "bell" | "lamp" | "pine" | "muted";

// A list of things, one line each. Columns keep their widths from one table to the next, so a page with several lists lines up.
export function Table({ cols, children }: { cols: Col[]; children: ReactNode }) {
  const min = cols.reduce((n, c) => n + (c.width ?? 320), 0);
  const table = useRef<HTMLTableElement>(null);
  // On a phone a row is a card and each cell names its column; the cells are the pages' own, so the labels are written onto them here.
  useLayoutEffect(() => {
    table.current?.querySelectorAll("tbody tr").forEach((tr) => [...tr.children].forEach((td, i) => td.setAttribute("data-label", cols[i]?.label ?? "")));
  });
  return (
    <div className="tbl-scroll">
      <table ref={table} className="tbl" style={{ minWidth: min }}>
        <colgroup>
          {cols.map((c) => (
            <col key={c.label} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {cols.map((c) => (
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
