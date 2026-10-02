export function mentionHref(token: string): string | null {
  if (token.startsWith("thread:")) return `/talk/${token.slice(7)}`;
  if (token.startsWith("repo:")) return `/repos#${token.slice(5)}`;
  const m = /^([a-z][a-z0-9-]*)(?:\/(?:U(\d+)(?:\.(\d+))?|A(\d+)))?$/.exec(token);
  if (!m) return null;
  if (m[4]) return `/p/${m[1]}/a/${m[4]}`;
  return m[3] ? `/p/${m[1]}/u/${m[2]}/${m[3]}` : m[2] ? `/p/${m[1]}/u/${m[2]}` : `/p/${m[1]}`;
}

export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[\s(])@([a-zA-Z0-9:/.-]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]! } : null;
}
