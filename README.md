<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="yagura-dark.png" />
    <img src="yagura-light.png" alt="yagura 櫓" width="120" />
  </picture>
</p>

# yagura 櫓

Yagura runs coding agents on long engineering projects while you stay in charge. You give a project a goal. A daemon splits it into small units, runs an agent on each one in its own git worktree, and has a fresh agent judge the result against test runs the daemon recorded itself. Each unit ends as one pull request, and nothing merges until the judge approves it and, by default, you do too.

It runs as one daemon per developer, with no cloud service. The target is a developer's own RHEL 9 VM on an air-gapped network. You drive it from a web dashboard. The full design is in [`docs/DESIGN.md`](docs/DESIGN.md).

## Install

You need Node 26 (`.nvmrc` pins it), pnpm 11, git 2.38 or newer, a logged-in `claude` CLI, and `gh` or `glab` for pull or merge requests.

```sh
git clone https://github.com/ultish/yagura && cd yagura
scripts/setup.sh
yagura start
```

`scripts/setup.sh` checks Node, pnpm and git, runs `pnpm install` and the build, and links `yagura` into `~/.local/bin`. It adds one marked block to your `~/.zshrc` or `~/.bashrc` that puts that directory on your PATH. It then reports whether `claude`, `gh` and `glab` are installed and logged in. You can run it again at any time. `--no-rc` leaves your rc files alone and prints the PATH line instead, `--bin <dir>` changes where the link goes, and `--uninstall` removes the link and the block.

`yagura start` runs the engine and the dashboard in the background on `http://127.0.0.1:7300`. `yagura status` shows whether it runs, `yagura stop` stops it, and `yagura restart` does both. The log is `daemon.log` in the state directory. `yagura daemon` runs it in your terminal instead, which is what a systemd unit wants. State lives in `~/.yagura`, or in `YAGURA_HOME` if you set it. While you experiment, point `YAGURA_HOME` at a scratch directory so you don't mix test runs into your real home.

`yagura --help` lists the everyday commands, and `yagura help all` lists every one.

### On an air-gapped machine

`pnpm install` needs a package registry, so point pnpm at your internal mirror or copy a populated pnpm store to the machine. Build elsewhere and run `scripts/setup.sh --no-build` if you can't install there at all. `better-sqlite3` compiles natively, so the machine needs `gcc`, `make` and Python. After any Node switch, run `pnpm rebuild better-sqlite3`. I haven't run this path end to end on the target VM yet.

## Configure

### Plugins

Yagura's own skills need no install. The daemon passes `plugins/yagura` to every agent session, so keep the cloned folder where it is.

Agents use your whole `claude` setup, and the default method comes from the [pstack](https://github.com/ultish/pstack-claude) plugins. Install them once, inside `claude`:

```
/plugin marketplace add ultish/pstack-claude
/plugin install pstack@pstack-claude
/plugin install cursor-team-kit@pstack-claude
```

With no internet, clone `pstack-claude` onto the machine and give `/plugin marketplace add` the path on disk. Any other plugin or skill your work needs goes into the same `claude`, and every agent gets it. To make yagura stop a unit whose worker skipped a skill, list that skill in the `skills.work` setting.

### Your `claude` command

Yagura starts `claude` as a program, without a shell. If `claude` is a function or alias in your `.bashrc`, as it is when a proxy is wrapped around it, yagura can't see it. `scripts/setup.sh` detects this and writes `~/.local/bin/yagura-claude`, which runs your function in an interactive shell. Set `harness.claude.bin` to that path in Settings. If your rc file prints anything at startup, that text mixes into the agent's output. In that case, copy what the function does into the wrapper instead.

### Environments

An environment tells agents how things run: how tests run, where libraries are published, what must never happen. You describe it in plain words, and a doctor agent turns the description into commands and proves them.

You can fill one in on the Environments page, or let an LLM session do it. In the session that's working on your project, say:

> Read `<this repo>/plugins/yagura/skills/yagura-environment/SKILL.md` and create a yagura environment for this project.

It reads your project, then creates the environment with the `yagura` command, so `yagura` has to be on its PATH.

### GitLab

Log in with `glab auth login --hostname <host>`, then add the host to the `forge.glab_hosts` setting. Repos from that host merge through merge requests. Any other host needs you to pick GitHub or GitLab when you add the repo.

### Models and budget

All settings are on the Settings page. Models default to the `claude` default. To pick one per role, set `role.worker.model`, `role.judge.model`, `role.lead.model`, `role.planner.model` and `role.doctor.model`. `project.budget_usd` caps what one project can spend.

### Reaching the dashboard from another machine

The daemon listens on localhost. To open it from another machine, start it with `YAGURA_BIND=<hostname>` (or `0.0.0.0`) and `YAGURA_PORT`, and open that port in the firewall. Beyond localhost the dashboard asks for the token in `$YAGURA_HOME/token`. Browser notifications need HTTPS, or Chrome's `unsafely-treat-insecure-origin-as-secure` flag for that address.

`yagura start` keeps running after you close the terminal. On a Mac, wrap it as `caffeinate -is yagura daemon` to keep the machine awake. For systemd, run `yagura daemon` in a user service.

## Set up a project in the dashboard

### 1. Add the repos

On the Repos page, paste a git URL and press Add repo. "Merge via" says how finished work gets in. Detect handles github.com and any GitLab host you listed. For any other address, pick GitHub pull requests or GitLab merge requests. Push straight to main skips review, so use it only where that's fine.

<img src="docs/img/repos.png" alt="The Repos page with the add form filled in for an internal GitLab repo" width="720" />

### 2. Describe the environment

On the Environments page, add one with provider `local-process` to start. On its Answers tab, say how tests run and how libraries are published, then press Save and run the doctor. Put machine facts such as `NEXUS_URL` on the Values tab. The Actions tab shows the commands the doctor proved.

<img src="docs/img/environment.png" alt="An environment's Answers tab with the questions filled in" width="720" />

### 3. Create the project

Go to Projects, then New project. Write the goal and how anyone can tell it is done. Tick the repos the project may change, or add one from the same page. Pick the environment. Choose whether you approve each merge, which is the default, or let yagura merge once the judge approves and CI passes. You can also describe the goal on the Talk page and press Go on the proposal it makes.

<img src="docs/img/new-project.png" alt="The New project page filled in for a project across two repos" width="720" />

### 4. Watch it run

The Projects page lists units as they move. Gates shows the questions agents have for you. On Agents you can read a running agent's work, steer it, or stop it. A stuck unit can be retried or cancelled, and the andon button on a project stops everything.

Logging in to `claude`, `gh` and `glab`, `yagura project set` and `yagura unit requeue` are CLI only for now.
