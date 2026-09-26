import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { acquireDaemonLock, claudeAdapter, Engine, layout, loadBootstrap, openStore, type Bootstrap } from "@yagura/core";
import { createApp } from "./server.js";

export { createApp } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadOrCreateToken(boot: Bootstrap): string {
  if (existsSync(boot.tokenFile)) return readFileSync(boot.tokenFile, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(boot.tokenFile, `${token}\n`);
  chmodSync(boot.tokenFile, 0o600);
  return token;
}

export async function startDaemon(cli: string[]): Promise<void> {
  const boot = loadBootstrap();
  const db = openStore(layout(boot).db);
  const release = acquireDaemonLock(boot);
  const token = LOOPBACK.has(boot.bind) ? null : loadOrCreateToken(boot);
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const engine = new Engine({ db, boot, adapters: { claude: claudeAdapter }, cli }, { log });
  const app = createApp({ db, boot, token });
  const server = serve({ fetch: app.fetch, hostname: boot.bind, port: boot.port });
  log(`yagura daemon on http://${boot.bind}:${boot.port}${token ? ` (token in ${boot.tokenFile})` : ""}, home ${boot.home}`);

  const abort = new AbortController();
  const shutdown = () => {
    if (abort.signal.aborted) return;
    log("shutting down: stopping running agents");
    abort.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await engine.runForever(abort.signal);
  } finally {
    server.close();
    release();
    db.close();
    log("stopped");
  }
}
