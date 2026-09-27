import type { ReactNode } from "react";
import { Link } from "../ui/Link";
import { mentionHref } from "./mention";

function inline(text: string, known: ReadonlySet<string> | null, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*(?:[^*]|\*(?!\*))+?\*\*)|(?<![\w@])@(thread:\d+|repo:[a-z][a-z0-9-]*|[a-z][a-z0-9-]*(?:\/U\d+(?:\.\d+)?)?)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={k}>{inline(m[2].slice(2, -2), known, k)}</b>);
    else {
      const token = m[3]!.replace(/[-.]+$/, "");
      const project = token.split(/[/:]/)[0]!;
      const href = mentionHref(token);
      const trusted = token.includes(":") || !known || known.has(project);
      if (href && trusted)
        out.push(
          <Link key={k} className="mention" to={href}>
            @{token}
          </Link>,
        );
      else if (trusted)
        out.push(
          <span key={k} className="mention">
            @{token}
          </span>,
        );
      else out.push(`@${token}`);
      if (token.length < m[3]!.length) out.push(m[3]!.slice(token.length));
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, known = null }: { text: string; known?: ReadonlySet<string> | null }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(" "), known, `p${blocks.length}`)}</p>);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={`c${blocks.length}`}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push(<h4 key={`h${blocks.length}`}>{inline(heading[1]!, known, `h${blocks.length}`)}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) item += ` ${lines[i++]!.trim()}`;
        items.push(item);
      }
      const k = `l${blocks.length}`;
      const children = items.map((it, j) => <li key={j}>{inline(it, known, `${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
    i++;
  }
  flush();
  return <div className="md">{blocks}</div>;
}

export function Inline({ text, known = null }: { text: string; known?: ReadonlySet<string> | null }) {
  return <>{inline(text, known, "i")}</>;
}
