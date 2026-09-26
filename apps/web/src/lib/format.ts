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
  return sameDay ? hm : `${d.toISOString().slice(5, 10)} ${hm}`;
}

export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export const sha = (s: string | null | undefined, n = 7) => (s ? s.slice(0, n) : "");

export const modelName = (m: string | null | undefined) => (m ? m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2") : "default model");

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
