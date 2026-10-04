#!/bin/sh
# Phase 6 demo, npm: a library and an app in two repos, a hosted npm repository in your own Nexus, fake agents.
#   NEXUS_USER=admin NEXUS_PASSWORD=... scripts/demo-publish-npm.sh up     set everything up and start the daemon
#   scripts/demo-publish-npm.sh status                                      units, publications, and what Nexus holds
#   scripts/demo-publish-npm.sh down                                        stop the daemon (Nexus is left alone)
#   GITHUB=1 ...                                                            land through pull requests on ${GH_OWNER:-ultish}/yagura-demo-lib and yagura-demo-app (private, scratch; they are reset on each up)
#   REAL=1 ...                                                              the same with real Haiku agents (a few dollars), human land gates, and real goals
# NEXUS_URL (default http://localhost:8081) and NEXUS_NPM_REPO (default npm) name the registry. Needs node, npm, curl, sqlite3.
# Everything lives in $DEMO (default /tmp/yagura-demo-npm); the registry credentials go into $DEMO/npmrc, never into a repo.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REAL=${REAL:-}
GITHUB=${GITHUB:-}
GH_OWNER=${GH_OWNER:-ultish}
DEMO=${DEMO:-/tmp/yagura-${REAL:+real-}${GITHUB:+gh-}demo-npm}
PORT=${YAGURA_PORT:-${GITHUB:+7303}}
PORT=${PORT:-${REAL:+7302}}
PORT=${PORT:-7301}
NEXUS_URL=${NEXUS_URL:-http://localhost:8081}
NEXUS_NPM_REPO=${NEXUS_NPM_REPO:-npm}
REGISTRY=$NEXUS_URL/repository/$NEXUS_NPM_REPO/
export YAGURA_HOME=$DEMO/home
export YAGURA_PORT=$PORT
export NPM_CONFIG_USERCONFIG=$DEMO/npmrc
Y() { node "$ROOT/apps/cli/dist/main.js" "$@"; }
git_() { git -c user.name=demo -c user.email=demo@localhost "$@"; }

up() {
  : "${NEXUS_USER:?set NEXUS_USER}" "${NEXUS_PASSWORD:?set NEXUS_PASSWORD}"
  [ -f "$ROOT/apps/cli/dist/main.js" ] || (cd "$ROOT" && pnpm -r build)
  # yagura's database module is built for one Node version; a different one fails at the first yagura command, so check before anything is set up.
  node -e "require(require.resolve('better-sqlite3', { paths: ['$ROOT/packages/core'] }))" > /dev/null 2>&1 || {
    echo "yagura's database module was built for a different Node than this one ($(node -v))."
    echo "Either run this with the Node you built with, or rebuild it for this one:  (cd $ROOT && pnpm rebuild better-sqlite3)"
    exit 1
  }
  down quiet
  rm -rf "$DEMO" && mkdir -p "$DEMO"
  curl -sf -m 5 -u "$NEXUS_USER:$NEXUS_PASSWORD" -o /dev/null "$NEXUS_URL/service/rest/v1/status" || { echo "cannot reach Nexus at $NEXUS_URL with that user"; exit 1; }

  AUTH=$(printf '%s:%s' "$NEXUS_USER" "$NEXUS_PASSWORD" | base64)
  HOSTPATH=${REGISTRY#*://}
  cat > "$DEMO/npmrc" <<EOF
registry=$REGISTRY
//$HOSTPATH:_auth=$AUTH
EOF
  chmod 600 "$DEMO/npmrc"

  cd "$DEMO"
  mkdir -p lib-seed/.agents/verify app-seed/.agents/verify
  cat > lib-seed/package.json <<'EOF'
{ "name": "@demo/lib", "version": "1.5.0", "main": "index.js" }
EOF
  cat > lib-seed/index.js <<'EOF'
exports.greet = (name) => `Hello, ${name}`;
EOF
  cat > lib-seed/.agents/verify/verify.json <<'EOF'
{
  "provider": "local-process",
  "checks": [{ "name": "load", "command": "node -e \"require('./index.js').greet('x')\"", "tier": "unit-verified" }],
  "publish": {
    "version": "node -p \"require('./package.json').version\"",
    "command": "npm version --no-git-tag-version --allow-same-version \"$YAGURA_VERSION\" >/dev/null && npm publish --tag yg",
    "suffix": "",
    "available": "npm view \"@demo/lib@$YAGURA_VERSION\" version | grep -qx \"$YAGURA_VERSION\""
  }
}
EOF
  cat > app-seed/package.json <<'EOF'
{ "name": "@demo/app", "version": "1.0.0", "dependencies": { "@demo/lib": "1.4.0" } }
EOF
  cat > app-seed/index.js <<'EOF'
console.log(require('@demo/lib').greet('app'));
EOF
  cat > app-seed/.agents/verify/check.sh <<'EOF'
set -e
pin=$(sed -n 's/^lib=//p' app/deps.txt 2>/dev/null || true)
tmp=$(mktemp -d)
cp package.json index.js "$tmp"/
[ -f package-lock.json ] && cp package-lock.json "$tmp"/
cd "$tmp"
if [ -n "$pin" ]; then npm install --no-audit --no-fund "@demo/lib@$pin" > /dev/null; else npm install --no-audit --no-fund > /dev/null; fi
node index.js
EOF
  cat > app-seed/.agents/verify/verify.json <<'EOF'
{
  "provider": "local-process",
  "checks": [{ "name": "installs-and-runs", "command": "sh .agents/verify/check.sh", "tier": "unit-verified", "timeoutSeconds": 300 }]
}
EOF
  for r in lib app; do
    printf 'node_modules/\n' > $r-seed/.gitignore
    (cd $r-seed && git init -q -b main && git add -A && git_ commit -qm init)
    if [ -n "$GITHUB" ]; then
      url="https://github.com/$GH_OWNER/yagura-demo-$r.git"
      gitgh() { git -c credential.helper='!gh auth git-credential' "$@"; }
      # A fresh run starts from the seed: yagura's own branches from an earlier run (which also closes their pull requests) go first.
      # (a push needs a repository to run in, so this happens inside the seed)
      (
        cd $r-seed
        for b in $(gitgh ls-remote --heads "$url" 'yg/*' | sed 's#.*refs/heads/##'); do gitgh push -q "$url" --delete "$b"; done
        gitgh push -q -f "$url" main
      )
    else
      git clone -q --bare $r-seed $r.git
    fi
  done

  echo "publishing @demo/lib 1.4.0 (already released) and checking the app installs it..."
  mkdir -p release14 && cp lib-seed/package.json lib-seed/index.js release14/
  (cd release14 && npm version --no-git-tag-version --allow-same-version 1.4.0 >/dev/null && { npm view @demo/lib@1.4.0 version >/dev/null 2>&1 || npm publish >/dev/null; })
  (cd app-seed && sh .agents/verify/check.sh)

  if [ -z "$REAL" ]; then
  cat > fake-claude.sh <<EOF
#!/bin/sh
FAKE_MODE=engine FAKE_DELAY_MS=\${FAKE_DELAY_MS:-3000} exec node "$ROOT/packages/core/src/harness/fixtures/fake-agent.mjs" "\$@"
EOF
  chmod +x fake-claude.sh
  Y set harness.claude.bin "\"$DEMO/fake-claude.sh\"" >/dev/null
  else
    for r in watchman planner worker verifier reviewer manager; do Y set role.$r.model '"claude-haiku-4-5-20251001"' >/dev/null; done
    Y set project.budget_usd 4 >/dev/null
  fi
  Y set forge.poll_seconds 5 >/dev/null
  if [ -n "$GITHUB" ]; then
    Y repo add "https://github.com/$GH_OWNER/yagura-demo-lib.git" --id lib >/dev/null
    Y repo add "https://github.com/$GH_OWNER/yagura-demo-app.git" --id app >/dev/null
  else
    Y repo add "$DEMO/lib.git" --id lib --land push >/dev/null
    Y repo add "$DEMO/app.git" --id app --land push >/dev/null
  fi
  Y env add local --provider local-process --capacity 2 >/dev/null
  Y env value set local NPM_CONFIG_USERCONFIG "$DEMO/npmrc" --note "npm config with the registry and its login" >/dev/null
  Y project new demo --goal "lib gains a feature that app uses" --predicate "both landed" --repo lib --repo app --merge human --env local >/dev/null
  if [ -z "$REAL" ]; then
  Y unit add demo --repo lib --goal "write lib" --write 'lib/**' --accept "lib file exists" --verify true >/dev/null
  Y unit add demo --repo app --goal "write app against lib's change" --write 'app/**' --accept "app file exists" --verify true --needs 1:source >/dev/null
  else
  Y unit add demo --repo lib --goal "Add a shout(name) function to index.js that returns the greeting for name in upper case with an exclamation mark, e.g. shout('app') returns 'HELLO, APP!'. Keep greet as it is, and add a test that runs with node." --write 'index.js' --write 'test/**' --accept "shout('app') === 'HELLO, APP!'" --accept "greet('app') still returns 'Hello, app'" --verify "node -e \"if (require('./index.js').shout('app') !== 'HELLO, APP!') process.exit(1)\"" --description "the app wants a louder greeting" >/dev/null
  Y unit add demo --repo app --goal "Make the app print shout('app') from @demo/lib instead of greet('app'). The library change is a published test build: pin @demo/lib in package.json to exactly the version READONLY gives, and run npm install to update package-lock.json." --write 'index.js' --write 'package.json' --write 'package-lock.json' --accept "node index.js prints HELLO, APP!" --accept "package.json pins @demo/lib to exactly the published test version" --verify "sh .agents/verify/check.sh" --needs 1:source >/dev/null
  fi

  nohup node "$ROOT/apps/cli/dist/main.js" daemon > "$DEMO/daemon.log" 2>&1 &
  echo $! > "$DEMO/daemon.pid"
  cat <<EOF

${REAL:+Real Haiku agents, budget \$4, merge by hand: nothing lands until you answer each land gate.}
Running. Open http://127.0.0.1:$PORT/p/demo
  1. U1 (lib) verifies; a test build @demo/lib@1.5.0-yg-demo-u1-<sha> is published to $REGISTRY under the yg tag (never latest).
  2. U2 (app) installs that exact version from the registry and is verified.
  3. Answer the land gate for U1, then U2's (bell, or: YAGURA_HOME=$YAGURA_HOME yagura gate answer <id> land).
  U2 lands pinned to U1's test build; nothing is released or deleted.${GITHUB:+ Each land gate answered opens or merges a pull request on GitHub.}
Log: tail -f $DEMO/daemon.log     State: scripts/demo-publish-npm.sh status     Stop: scripts/demo-publish-npm.sh down
EOF
}

status() {
  Y show demo 2>&1 | head -12
  echo; echo "publications:"
  sqlite3 "$YAGURA_HOME/yagura.db" "select 'U'||unit_id, kind, state, coalesce(version,'') from publications"
  echo; echo "open gates:"; Y gates 2>&1 | head
  echo; echo "registry:"
  npm dist-tag ls @demo/lib 2>&1 | sed 's/^/  dist-tag /'
  npm view @demo/lib versions 2>&1 | sed 's/^/  versions /'
  [ -d "$DEMO/chk" ] && rm -rf "$DEMO/chk"
  APP=$DEMO/app.git; [ -n "$GITHUB" ] && APP=https://github.com/$GH_OWNER/yagura-demo-app.git
  if git -c credential.helper='!gh auth git-credential' clone -q "$APP" "$DEMO/chk" 2>/dev/null; then
    echo; echo "app's trunk pins: $(cat "$DEMO/chk/app/deps.txt" 2>/dev/null || node -p "require('$DEMO/chk/package.json').dependencies['@demo/lib']")"
  fi
}

down() {
  [ -f "$DEMO/daemon.pid" ] && kill "$(cat "$DEMO/daemon.pid")" 2>/dev/null || true
  [ "${1:-}" = quiet ] || echo "stopped (files kept in $DEMO; Nexus untouched)"
}

"${1:-up}" "${2:-}"
