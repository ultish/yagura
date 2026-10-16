// Headless Chrome over the DevTools protocol, for review screenshots and a page-load probe; no browser driver needed.
//   READY=<css selector> node scripts/page-check.mjs shot <url> <night|day> <out.png> [width]   full-page shot once the selector exists
//   node scripts/page-check.mjs paint <url> <runs>   ms until the unit page's first timeline entry exists, per load, and the median
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
}
ws.close();
chrome.kill();
process.exit(0);
