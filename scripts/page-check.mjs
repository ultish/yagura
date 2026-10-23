// Headless Chrome over the DevTools protocol, for review screenshots and a page-load probe; no browser driver needed.
//   READY=<css selector> node scripts/page-check.mjs shot <url> <night|day> <out.png> [width]   full-page shot once the selector exists
//   FILL='[["#sel","text"],...]' sets those inputs before the shot (React-safe); CLICK='["#sel","sel|2",...]' clicks them after (sel|n is the nth match)
//   node scripts/page-check.mjs paint <url> <runs>   ms until the unit page's first timeline entry exists, per load, and the median
//   WIDTHS=390,700,1000 node scripts/page-check.mjs widths <origin> [/path,/path]   each page at each width: how far it scrolls sideways and which elements stick out (exit 1 if any does)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [mode, url, a, b, c] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--no-first-run", "about:blank"],
  {
    stdio: "ignore",
  },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${port}/json`)
    .then((r) => r.json())
    .then((ts) => ts.find((t) => t.type === "page"))
    .catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const waits = new Map();
const events = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waits.has(msg.id)) waits.get(msg.id)(msg);
  else events.push(msg);
});
const send = (method, params = {}) =>
  new Promise((r) => {
    waits.set(++id, (msg) => r(msg.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
const load = async (u) => {
  events.length = 0;
  await send("Page.navigate", { url: u });
  for (let i = 0; i < 100 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(50);
};
await send("Page.enable");
await send("Runtime.enable");

if (mode === "shot") {
  const width = Number(c ?? 1280);
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
  const rendered = `new Promise(r => { const t = setInterval(() => { if (document.querySelector(${JSON.stringify(process.env.READY ?? ".story-entry")})) { clearInterval(t); setTimeout(r, 600); } }, 50); })`;
  await load(url);
  await evaluate(rendered);
  await evaluate(`localStorage.setItem("yagura.theme", ${JSON.stringify(a)})`);
  await load(url);
  await evaluate(
    `new Promise(r => { const t = setInterval(() => { if (document.querySelector(${JSON.stringify(process.env.READY ?? ".story-entry")})) { clearInterval(t); setTimeout(r, 600); } }, 50); })`,
  );
  if (process.env.FILL) {
    await evaluate(`(${JSON.stringify(JSON.parse(process.env.FILL))}).forEach(([sel, val]) => {
      const el = document.querySelector(sel);
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    })`);
  }
  if (process.env.CLICK) {
    await evaluate(
      `(${JSON.stringify(JSON.parse(process.env.CLICK))}).forEach((spec) => { const [sel, n = "0"] = spec.split("|"); document.querySelectorAll(sel)[Number(n)]?.click(); })`,
    );
  }
  if (process.env.FILL || process.env.CLICK) await sleep(500);
  const scroll = await evaluate(`[document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollHeight]`);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: scroll[2], scale: 1 } });
  writeFileSync(b, Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ out: b, scrollWidth: scroll[0], innerWidth: scroll[1], height: scroll[2] }));
} else if (mode === "paint") {
  const runs = Number(a ?? 10);
  const times = [];
  await load(url);
  for (let i = 0; i < runs; i++) {
    await load(url);
    const fcp = await evaluate(
      `new Promise(r => { const f = () => { const e = performance.getEntriesByName('first-contentful-paint')[0]; const ready = document.querySelector('.story-entry, .story-ledger, .unit-now'); if (e && ready) r(Math.round(performance.now())); else setTimeout(f, 10); }; f(); })`,
    );
    times.push(fcp);
  }
  const sorted = [...times].sort((x, y) => x - y);
  console.log(JSON.stringify({ times, median: sorted[Math.floor(sorted.length / 2)] }));
} else if (mode === "widths") {
  const widths = (process.env.WIDTHS ?? "390,700,1000").split(",").map(Number);
  const api = (path) => fetch(new URL(path, url)).then((r) => r.json());
  const found = [];
  if (!a) {
    const projects = await api("/api/projects").catch(() => []);
    const first = projects[0]?.project?.id;
    if (first) found.push(`/p/${first}`, `/p/${first}/prompts`, `/p/${first}/spec`);
    const unit = first ? (await api(`/api/projects/${first}`).catch(() => ({ units: [] }))).units?.find((u) => u.type === "work") : null;
    if (unit) found.push(`/p/${first}/u/${unit.seq}`);
    const repos = await api("/api/repos").catch(() => []);
    const repo = repos[0]?.repo?.id ?? repos[0]?.id;
    if (repo) found.push(`/r/${repo}`);
    const envs = await api("/api/environments").catch(() => []);
    const env = envs[0]?.environment?.id ?? envs[0]?.id;
    if (env) found.push(`/e/${env}`);
    const threads = await api("/api/threads").catch(() => []);
    if (threads[0]) found.push(`/talk/${threads[0].id}`);
  }
  const paths = a
    ? a.split(",")
    : ["/", "/talk", "/projects", "/projects/new", "/agents", "/gates", "/repos", "/environments", "/settings", "/prompts", "/search?q=a", ...found];
  const probe = `(() => {
    const iw = document.documentElement.clientWidth;
    const out = [];
    document.querySelectorAll("body *").forEach((e) => {
      const b = e.getBoundingClientRect();
      if (!(b.width > 0 && b.right > iw + 2)) return;
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(p).overflowX)) return;
      const c = typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : "";
      out.push(e.tagName.toLowerCase() + c + ":" + Math.round(b.right));
    });
    return { over: document.documentElement.scrollWidth - iw, sticking: [...new Set(out)].slice(0, 4) };
  })()`;
  let bad = 0;
  for (const width of widths) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const path of paths) {
      await load(new URL(path, url).href);
      await sleep(1800);
      const r = await evaluate(probe);
      if (r.over > 0) bad++;
      console.log(
        `${String(width).padStart(5)}  ${r.over > 0 ? "OVER " + String(r.over).padStart(4) : "ok       "}  ${path}${r.over > 0 ? "  " + r.sticking.join(" ") : ""}`,
      );
    }
  }
  ws.close();
  chrome.kill();
  process.exit(bad ? 1 : 0);
}
ws.close();
chrome.kill();
process.exit(0);
