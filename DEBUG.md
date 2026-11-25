# Debugging yagura

## An agent fails only when yagura starts it

Use `scripts/agent-probe.mjs` when an agent works from your shell but fails inside yagura, for example the planner, while the watchman works.

The probe starts `claude` the way yagura starts a planner:

- the same flags (`-p`, stream-json in and out, `--permission-mode bypassPermissions`, yagura's `--plugin-dir`, `--disallowed-tools`)
- the prompt on stdin as stream-json
- a git checkout as the working directory

It does not start the daemon and does not touch `~/.yagura`. Each run starts one real session: it is short, but it uses your account.

### Before you start

1. Pull and build:

   ```sh
   git pull
   pnpm install
   pnpm -r build
   ```

2. Find the program yagura runs for `claude`:

   ```sh
   yagura settings | grep harness.claude.bin
   ```

   If `scripts/setup.sh` found that `claude` is a shell function or alias, this is the wrapper it wrote, usually `~/.local/bin/yagura-claude`. Use that path below.

### Run it

Run these from the yagura repo, in order. Stop at the first one that works.

```sh
W=~/.local/bin/yagura-claude

# 1. Like the planner: a git checkout, a skill loaded through the Skill tool.
node scripts/agent-probe.mjs $W

# 2. Outside a git checkout, the way the watchman runs.
node scripts/agent-probe.mjs $W --plain

# 3. No Skill call: the prompt only asks for a reply.
node scripts/agent-probe.mjs $W --prompt "reply with the single word ok"

# 4. Fewer flags.
node scripts/agent-probe.mjs $W --without=--plugin-dir --without=--disallowed-tools --prompt "reply with the single word ok"
```

Other options:

- `--model <model>` passes `--model`. The default is no model, the same as yagura's default.
- `--plugin-dir <dir>` adds another plugin folder.
- `--without=<flag>` drops one of yagura's flags and its value. You can use it more than once.

### Read the output

Each run prints:

- `INIT`: the Claude Code version, model, permission mode and plugins. It appears once the session has started.
- `CALL`: each tool the agent called.
- `RESULT`: how the session ended.
- `exit`: the exit code.
- `stderr`: all of it, not only the tail.
- `kept in`: the folder that holds `stdout.jsonl` and `stderr.txt`.

| What you see          | Where to look                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1 fails, 2 works      | Something reacts to running inside a git repo: your shell rc file, the `claude` function, or a proxy it starts.   |
| 1 and 2 fail, 3 works | The request that loads a skill fails. Look at anything between `claude` and the network, such as a proxy wrapper. |
| 1 to 3 fail, 4 works  | One of the two dropped flags is the trigger. Run 4 again with only one `--without` to find which.                 |
| 4 fails too           | Run your `claude` by hand with the same flags as the `argv:` line, adding them one at a time.                     |
| No `INIT` line        | `claude` failed while starting, before any request. The flags or the wrapper are the cause.                       |
| 1 works               | The probe does not recreate the failure. The cause is in the real brief or the daemon's environment.              |

### Shell wrappers

`setup.sh` writes a wrapper that starts your `claude` function through an interactive shell (`bash -ic`), because yagura starts agents without a shell. Two things follow:

- `bash: cannot set terminal process group` and `bash: no job control in this shell` on stderr are expected. An interactive shell without a terminal prints them on every start, so they are not the error.
- Everything your rc file does runs before every agent, in the agent's working directory. For the planner and workers that is a git checkout.

## Other places to look

- The daemon log: `~/.yagura/logs/daemon.log`. Start the daemon with `yagura daemon --debug`, or set `YAGURA_DEBUG=1`, for git, forge and agent detail.
- An agent's session: `~/.yagura/projects/<project>/logs/u<unit>.<attempt>.jsonl` is the raw stream-json of that run.
- Which Node runs the agents: `cat ~/.yagura/bin/yagura`. Agents run `yagura` through this file, which names the Node the daemon was started with. If it is older than the Node in your shell, restart the daemon.
