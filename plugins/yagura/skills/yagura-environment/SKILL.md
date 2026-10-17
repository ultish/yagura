---
name: yagura-environment
description: Use when the developer asks you to write, fill in, or review a yagura environment (its answers, values, or a template file to import). Not for yagura briefs; those load their own role skill.
---

# yagura environment

An environment tells yagura's agents how things run on one machine or network: how tests run, how libraries are published, what must never happen. The developer describes it in plain words and values; yagura's doctor agent turns that into commands and proves them. Your job is to write that description well, as a template file the developer imports. You do not write commands for yagura to run; the doctor does that from the repos.

## How to work

1. **Read before asking.** Look at the repos the environment is for: build files, CI config, scripts, READMEs. Find how tests run, what gets published and where, and any internal URLs, registries, or mirrors named there. Ask the developer only for what the repos do not show.
2. **Write answers as plain sentences**, the way you would tell a new teammate. "Tests run with `gradle test`, not the wrapper; the wrapper is blocked here." Name the tool and the quirk, not a script path. Leave a question empty rather than guess.
3. **Put machine facts in values**, not in prose: `NEXUS_URL`, `REGISTRY_PUSH`, a mirror host. Each has a short note that tells an agent what it is for.
4. **Never write a secret.** Passwords, tokens, and keys do not go in a template. Name where agents find them instead ("credentials are in ~/.gradle/gradle.properties as nexusUsername and nexusPassword").
5. **Say what you could not tell.** End your reply with a short list of what you guessed, what you left empty, and what the developer should check.

## The file

Write one YAML file. These are all the keys; unknown keys are rejected.

```yaml
name: work-gradle # lowercase words and dashes, starts with a letter, up to 40 characters
description: Gradle repos behind the internal Nexus
provider: local-process # local-process unless the developer runs on Kubernetes (kube-namespace)
providerConfig: {} # empty for local-process
capacity: 1 # how many agents may use this environment at once
answers: # every key optional; plain words
  tests: Tests run with `gradle test`, not the wrapper.
  publish: Libraries publish as snapshots to the internal Nexus; never a release.
  images: ""
  run: ""
  never: Never publish a release version; never delete anything from Nexus.
  other: ""
values:
  - name: NEXUS_URL # letters, digits, underscore
    value: http://nexus.internal:8081
    note: Base URL of the Maven repository manager
    ask: false # true: a fact about one machine; whoever applies the template is asked for their own
```

The answer keys are `tests` (how tests run), `publish` (how libraries are published, and where), `images` (how images are built and pushed), `run` (how the app is run or deployed), `never` (what agents must never do here), and `other`. Values you mark `ask: true` keep your text as an example and are asked for again when someone applies the template.

## Getting it into yagura

- **Dashboard:** Environments page, then Import a template, paste the YAML. Then apply the template to create the environment.
- **CLI:** `yagura template import file.yaml`, then `yagura template apply <name> --id <environment id>`.
- Then ask for the doctor (Environments page, or `yagura env doctor <id>`). It proves the actions and reports what works, what fails, and what it could not tell; fix the answers and run it again.
