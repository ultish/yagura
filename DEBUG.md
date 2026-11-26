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
- `--claude-debug` writes Claude Code's own debug log, which includes stack traces, to `claude-debug.log` in the probe's folder. At the end it prints the log's error lines and its last 25 lines. Add it to whichever run fails: the stack trace shows which program threw the error, `claude` or something your wrapper starts. If no log appears, the wrapper does not pass `--debug-file` on to `claude`.
- `--extra=<arg>` adds any other argument after yagura's. You can use it more than once.
- `--brief <file>` sends a file as the prompt, for example the real brief of the round that failed. `--cwd <dir>` runs in that folder instead of a new empty repo. See [Replay a real round](#replay-a-real-round).

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
| 1 works               | The probe does not recreate the failure. Replay the real round next: see below.                                   |

### Replay a real round

If the probe works but the planner still fails, send the probe the failing round's real brief, in a copy of the project's repo:

```sh
ls -t ~/.yagura/projects/<project>/briefs/ | head
git clone ~/.yagura/repos/<repo>/origin.git /tmp/replay
node scripts/agent-probe.mjs $W --brief ~/.yagura/projects/<project>/briefs/u<unit>.<attempt>.md --cwd /tmp/replay --claude-debug
```

Use a clone, never a checkout yagura is working in. With a real brief the agent does real work, with `bypassPermissions`. Its `yagura` commands that record anything are refused, because the probe has no attempt token.

### Shell wrappers

Yagura starts agents without a shell, so it can't call a `claude` shell function. `setup.sh` writes `~/.local/bin/yagura-claude` for you to fill in: export what the function sets, then `exec` the real binary with `"$@"`. Until you edit it, it prints `edit … first` and exits 1.

Don't start the function through an interactive shell (`bash -ic 'claude "$@"'`). Older versions of `setup.sh` wrote that wrapper. It worked for the watchman but the planner failed with `Fatal error: e.toLowerCase is not a function`. Running `setup.sh` again replaces that wrapper. If you see `bash: cannot set terminal process group` or `bash: no job control in this shell` in an agent's stderr, you still have it.

## Other places to look

- The daemon log: `~/.yagura/logs/daemon.log`. Start the daemon with `yagura daemon --debug`, or set `YAGURA_DEBUG=1`, for git, forge and agent detail.
- An agent's session, in `~/.yagura/projects/<project>/logs/`:
  - `u<unit>.<attempt>.jsonl`: the raw stream-json of that run.
  - `u<unit>.<attempt>.stderr`: everything the agent wrote to stderr. The failure reason on the dashboard shows only the tail, without the shell's job-control lines.
  - `u<unit>.<attempt>.cmd`: a script that starts the same session again: the same folder, command and input (saved beside it in `.stdin`), and the variables yagura set. Values of environment variables and tokens are not kept, only their names. Running it starts a real session in that folder, so only run it after the unit is finished, and remember a checkout may already have been removed.
- Which Node runs the agents: `cat ~/.yagura/bin/yagura`. Agents run `yagura` through this file, which names the Node the daemon was started with. If it is older than the Node in your shell, restart the daemon.
