#!/usr/bin/env node
// A stand-in kubectl for tests: namespaces are directories under FAKE_KUBE_DIR, every call is appended to its log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_KUBE_DIR;
let args = process.argv.slice(2);
appendFileSync(join(dir, "log"), `${args.join(" ")}\n`);
if (args[0] === "--context") args = args.slice(2);
const ns = (name) => join(dir, "ns", name);
const fail = (msg) => {
  process.stderr.write(`Error from server: ${msg}\n`);
  process.exit(1);
};
const [verb, kind, name] = args;
if (process.env.FAKE_KUBE_DOWN) fail("the server could not be reached");

if (verb === "config" && kind === "current-context") console.log("fake-ctx");
else if (verb === "version") console.log(JSON.stringify({ serverVersion: { gitVersion: "v1.32.0+fake" } }));
else if (verb === "auth") console.log("yes");
else if (verb === "create" && kind === "namespace") {
  if (existsSync(ns(name))) fail(`namespaces "${name}" already exists`);
  mkdirSync(ns(name), { recursive: true });
  writeFileSync(join(ns(name), "labels.json"), "{}");
} else if (verb === "label" && kind === "namespace") {
  if (!existsSync(ns(name))) fail(`namespaces "${name}" not found`);
  const labels = JSON.parse(readFileSync(join(ns(name), "labels.json"), "utf8"));
  for (const kv of args.slice(3)) labels[kv.split("=")[0]] = kv.split("=")[1];
  writeFileSync(join(ns(name), "labels.json"), JSON.stringify(labels));
} else if (verb === "get" && kind === "namespace") {
  if (!existsSync(ns(name))) {
    if (args.includes("--ignore-not-found")) process.exit(0);
    fail(`namespaces "${name}" not found`);
  }
  const jsonpath = args.find((a) => a.startsWith("jsonpath="));
  if (jsonpath) process.stdout.write(JSON.parse(readFileSync(join(ns(name), "labels.json"), "utf8")).yagura ?? "");
  else console.log(args.includes("name") ? `namespace/${name}` : name);
} else if (verb === "delete" && kind === "namespace") {
  if (!existsSync(ns(name))) fail(`namespaces "${name}" not found`);
  rmSync(ns(name), { recursive: true });
} else if (verb === "delete") process.exit(0);
else fail(`fake kubectl does not know: ${args.join(" ")}`);
