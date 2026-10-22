---
name: yagura-environment
description: Use when the developer asks you to create, fill in, or review a yagura environment from the project you are working in. You create it in their yagura with the yagura command. Not for yagura briefs; those load their own role skill.
---

# yagura environment

An environment tells yagura's agents how things run on one machine or network: how tests run, how libraries are published, what must never happen. One environment can serve many projects. The developer describes it in plain words and values; yagura's doctor agent turns that into commands and proves them. Your job is to create that environment in the developer's yagura with the `yagura` command, from what you can see in the project you are working in. You do not write commands for yagura to run; the doctor does that from the repos.

## How to work

1. **Read before asking.** Look at the repos the environment is for: build files, CI config, scripts, READMEs. Find how tests run, what gets published and where, and any internal URLs, registries, or mirrors named there. Ask the developer only for what the repos do not show. Ask one thing at a time. The first question is usually only the environment id.
2. **Repo facts go in; machine facts are leads.** What you read in the repo (build files, CI, README) you may write down. What you find outside it (`~/.gradle`, `~/.m2`, `~/.docker`, shell profiles) only tells you what exists on this machine, not that this project uses it. Do not write it into the environment. List it for the developer ("found on your machine, not used by the repo: a Nexus URL and Jib credentials") and add it only if they confirm. Do not ask "is this for this repo only?"; the word is ambiguous. If scope matters, ask which projects will use the environment.
3. **Write answers as plain sentences**, the way you would tell a new teammate. "Tests run with `gradle test`, not the wrapper; the wrapper is blocked here." Name the tool and the quirk, not a script path. State only what a file shows. Do not write a guess as a fact; leave it out and put it in your closing list.
4. **Fill every answer.** If a question does not apply, write `Not needed: <reason>` ("Not needed: this is a library, not an app."). A blank answer reads as forgotten, and the doctor cannot tell it from one nobody has done yet.
5. **Put machine facts in values**, not in prose: `NEXUS_URL`, `REGISTRY_PUSH`, a mirror host. Each has a short note that tells an agent what it is for. Add a value only for something the project uses.
6. **Never write a secret.** Passwords, tokens, and keys do not go in a template. Name where agents find them instead ("credentials are in ~/.gradle/gradle.properties as nexusUsername and nexusPassword").
7. **Say what you could not tell.** End your reply with a short list of what you guessed, what you found outside the repo and did not add, and what the developer should check.

## What the project is

The kind of project decides which answers apply. Check against it before you ask.

- **Library:** `tests` is the test command. `publish` says where it publishes and, if CI does the publishing (a release or publish workflow), that agents do not publish it. `never` follows from that: agents do not publish. `images` and `run` are "Not needed: this is a library."
- **Application or service:** `run` says how it starts or deploys. `images` says how the image is built and pushed, if it is.
- **Tooling or scripts:** usually only `tests`; the rest are "Not needed".

## Create it

Run these yourself with the `yagura` command, in the developer's normal yagura home (do not set `YAGURA_HOME`). If `yagura` is not found, tell the developer instead of installing anything. Ask for the environment id if they have not given one; ids are lowercase words and dashes, 2 to 40 characters, starting with a letter. Check whether it exists first with `yagura env answers <id>`, which says "not found" for a new id; `yagura env add` on an id that exists fails.

```sh
yagura env add <id> --provider local-process --capacity 1
yagura env answer <id> tests   --text "Tests run with ./gradlew test on JDK 17; this is what CI runs."
yagura env answer <id> publish --text "Published to Maven Central by the GitHub Actions publish workflow on a release. Agents do not publish it."
yagura env answer <id> never   --text "Never publish; CI does that. Never bump the version or cut a release without asking."
yagura env answer <id> images  --text "Not needed: this is a library, so no images are built."
yagura env answer <id> run     --text "Not needed: this is a library, not an app."
yagura env value set <id> JAVA_VERSION 17 --note "JDK major version CI uses for build and tests"
```

- `--provider` says where agents run their work. `local-process` runs them on this machine; `kube-namespace` runs them in Kubernetes pods and also needs `--context` or `--pool`. Use `local-process` and tell the developer you did, unless the repos show Kubernetes. Do not ask.
- The answer keys are `tests` (how tests run), `publish` (how libraries are published, and where), `images` (how images are built and pushed), `run` (how the app is run or deployed), `never` (what agents must never do here), and `other`. `yagura env answer` replaces that answer.
- Value names are letters, digits, and underscores. `yagura env value set` replaces a value of the same name; `yagura env value rm <id> <NAME>` removes one. `yagura env presets` lists bundles of common values (a registry, Kafka, Helm, a Maven mirror); `yagura env preset <id> <preset>` adds one.
- Show the developer what you created with `yagura env answers <id>` and `yagura env values <id>`.

If the environment already exists, read it first with those two commands and change only what is wrong or missing.

## Then

- The doctor turns the answers into proven commands. It runs once a project uses the environment, or when you ask: `yagura env doctor <id>` (it needs at least one project on that environment; if there is none, tell the developer to create one in the dashboard, Projects, New project). `yagura env actions <id>` then shows what it proved.
- To share an environment with a teammate instead, `yagura template save <id> <name>` and `yagura template export <name>` give a YAML file they import in the dashboard (Environments, Import a template).
