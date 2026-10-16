import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The variable a worker's session carries naming the one branch it may push; without it the mirror takes no push.
export const PUSH_BRANCH_VAR = "YAGURA_PUSH_BRANCH";

const PRE_RECEIVE = `#!/bin/sh
# Installed by yagura: a worker may push only its own unit's branch, and only forward.
while read old new ref; do
  if [ -z "$${PUSH_BRANCH_VAR}" ]; then
    echo "yagura: this copy takes pushes only from a unit's worker" >&2
    exit 1
  fi
  if [ "$ref" != "refs/heads/$${PUSH_BRANCH_VAR}" ]; then
    echo "yagura: you may push only $${PUSH_BRANCH_VAR}, not \${ref#refs/heads/}" >&2
    exit 1
  fi
  case $new in *[!0]*) ;; *)
    echo "yagura: $${PUSH_BRANCH_VAR} cannot be deleted" >&2
    exit 1 ;;
  esac
  case $old in *[!0]*)
    if ! git merge-base --is-ancestor "$old" "$new"; then
      echo "yagura: $${PUSH_BRANCH_VAR} only moves forward; merge instead of rebasing, and never force-push" >&2
      exit 1
    fi ;;
  esac
done
`;

const POST_RECEIVE = `#!/bin/sh
# Installed by yagura: an accepted push goes on to the forge at once, which backs the work up off this machine.
while read old new ref; do
  GIT_TERMINAL_PROMPT=0 git push --quiet origin "$new:$ref" ||
    echo "yagura: the push did not reach the forge; yagura pushes the branch again at hand-off" >&2
done
`;

export function installRelay(mirror: string): void {
  const hooks = join(mirror, "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const [name, body] of [
    ["pre-receive", PRE_RECEIVE],
    ["post-receive", POST_RECEIVE],
  ] as const) {
    writeFileSync(join(hooks, name), body);
    chmodSync(join(hooks, name), 0o755);
  }
}
