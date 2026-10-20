---
name: yagura-environment
description: Use when the developer asks you to create, fill in, or review a yagura environment from the project you are working in. You create it in their yagura with the yagura command. Not for yagura briefs; those load their own role skill.
---

# yagura environment

An environment tells yagura's agents how things run on one machine or network: how tests run, how libraries are published, what must never happen. The developer describes it in plain words and values; yagura's doctor agent turns that into commands and proves them. Your job is to create that environment in the developer's yagura with the `yagura` command, from what you can see in the project you are working in. You do not write commands for yagura to run; the doctor does that from the repos.

## How to work

1. **Read before asking.** Look at the repos the environment is for: build files, CI config, scripts, READMEs. Find how tests run, what gets published and where, and any internal URLs, registries, or mirrors named there. Ask the developer only for what the repos do not show.
2. **Write answers as plain sentences**, the way you would tell a new teammate. "Tests run with `gradle test`, not the wrapper; the wrapper is blocked here." Name the tool and the quirk, not a script path. Leave a question empty rather than guess.
3. **Put machine facts in values**, not in prose: `NEXUS_URL`, `REGISTRY_PUSH`, a mirror host. Each has a short note that tells an agent what it is for.
4. **Never write a secret.** Passwords, tokens, and keys do not go in a template. Name where agents find them instead ("credentials are in ~/.gradle/gradle.properties as nexusUsername and nexusPassword").
5. **Say what you could not tell.** End your reply with a short list of what you guessed, what you left empty, and what the developer should check.

## Create it

Run these yourself with the `yagura` command, in the developer's normal yagura home (do not set `YAGURA_HOME`). If `yagura` is not found, tell the developer instead of installing anything. Ask for the environment id if they have not given one; ids are lowercase words and dashes, 2 to 40 characters, starting with a letter. Check whether it exists first with `yagura env answers <id>`, which says "not found" for a new id; `yagura env add` on an id that exists fails.

```sh
yagura env add <id> --provider local-process --capacity 1
yagura env answer <id> tests   --text "Tests run with gradle test, not the wrapper."
yagura env answer <id> publish --text "Libraries publish as snapshots to the internal Nexus; never a release."
yagura env answer <id> never   --text "Never publish a release version; never delete anything from Nexus."
yagura env value set <id> NEXUS_URL http://nexus.internal:8081 --note "Base URL of the Maven repository manager"
```

- `--provider` is `local-process` unless the developer runs on Kubernetes (`kube-namespace`, which also needs `--context` or `--pool`; ask).
- The answer keys are `tests` (how tests run), `publish` (how libraries are published, and where), `images` (how images are built and pushed), `run` (how the app is run or deployed), `never` (what agents must never do here), and `other`. Answer only what you can say with confidence; an empty answer is fine. `yagura env answer` replaces that answer.
- Value names are letters, digits, and underscores. `yagura env value set` replaces a value of the same name. `yagura env presets` lists bundles of common values (a registry, Kafka, Helm, a Maven mirror); `yagura env preset <id> <preset>` adds one.
- Show the developer what you created with `yagura env answers <id>` and `yagura env values <id>`.

If the environment already exists, read it first with those two commands and change only what is wrong or missing.

## Then

- The doctor turns the answers into proven commands. It runs once a project uses the environment, or when you ask: `yagura env doctor <id>` (it needs at least one project on that environment; if there is none, tell the developer to create one in the dashboard, Projects, New project). `yagura env actions <id>` then shows what it proved.
- To share an environment with a teammate instead, `yagura template save <id> <name>` and `yagura template export <name>` give a YAML file they import in the dashboard (Environments, Import a template).
