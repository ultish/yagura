export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function since(iso: string | null | undefined, now: number): string {
  return iso ? duration(now - Date.parse(iso)) : "";
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = d.toTimeString().slice(0, 5);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return sameDay ? hm : `${md} ${hm}`;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export const sha = (s: string | null | undefined, n = 7) => (s ? s.slice(0, n) : "");

export const modelName = (m: string | null | undefined) => (m ? m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2") : "default model");

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const usd = (n: number) => `$${n.toFixed(2)}`;

export const spend = (costUsd: number, budgetUsd: number | null) => (budgetUsd ? `${usd(costUsd)} of ${usd(budgetUsd)}` : `${usd(costUsd)} spent`);
