#!/bin/sh
# Phase 6 demo: a library and an app in two repos, Reposilite (docker) standing in for Nexus, fake agents.
#   scripts/demo-publish.sh up        set everything up and start the daemon
#   scripts/demo-publish.sh release   play CI: publish lib's trunk as 1.5.0
#   scripts/demo-publish.sh status    units, publications, and what the repository holds
#   scripts/demo-publish.sh down      stop the daemon and Reposilite
# Needs docker, gradle, java, curl, sqlite3. Everything lives in $DEMO (default /tmp/yagura-demo-publish).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEMO=${DEMO:-/tmp/yagura-demo-publish}
PORT=${YAGURA_PORT:-7300}
REPO_PORT=8088
export YAGURA_HOME=$DEMO/home
export YAGURA_PORT=$PORT
export MAVEN_REPO=http://localhost:$REPO_PORT MAVEN_USER=admin MAVEN_PASSWORD=secret
Y() { node "$ROOT/apps/cli/dist/main.js" "$@"; }
git_() { git -c user.name=demo -c user.email=demo@localhost "$@"; }

up() {
  [ -f "$ROOT/apps/cli/dist/main.js" ] || (cd "$ROOT" && pnpm -r build)
  down quiet
  rm -rf "$DEMO" && mkdir -p "$DEMO"

  docker run -d --name yg-reposilite -p $REPO_PORT:8080 -e REPOSILITE_OPTS="--token admin:secret" dzikoysk/reposilite:latest >/dev/null
  i=0; until curl -sf -o /dev/null "$MAVEN_REPO/"; do i=$((i + 1)); [ $i -lt 60 ] || { echo "Reposilite did not start"; exit 1; }; sleep 2; done

  cd "$DEMO"
  mkdir -p lib-seed/src/main/java/com/example/lib lib-seed/.agents/verify
  cat > lib-seed/settings.gradle <<'EOF'
rootProject.name = 'lib'
EOF
  printf 'group=com.example\nversion=1.5.0-SNAPSHOT\n' > lib-seed/gradle.properties
  cat > lib-seed/build.gradle <<'EOF'
plugins {
    id 'java-library'
    id 'maven-publish'
}

publishing {
    publications { maven(MavenPublication) { from components.java } }
    repositories {
        maven {
            url = version.toString().endsWith('SNAPSHOT') ? "${System.getenv('MAVEN_REPO')}/snapshots" : "${System.getenv('MAVEN_REPO')}/releases"
            allowInsecureProtocol = true
            credentials {
                username = System.getenv('MAVEN_USER')
                password = System.getenv('MAVEN_PASSWORD')
            }
        }
    }
}
EOF
  cat > lib-seed/src/main/java/com/example/lib/Greeter.java <<'EOF'
package com.example.lib;

public final class Greeter {
    public static String greet(String name) {
        return "Hello, " + name;
    }
}
EOF
  cat > lib-seed/.agents/verify/verify.json <<'EOF'
{
  "provider": "local-process",
  "checks": [{ "name": "build", "command": "gradle -q build", "tier": "unit-verified", "timeoutSeconds": 600 }],
  "publish": {
    "version": "sed -n 's/^version=//p' gradle.properties",
    "command": "gradle -q publish -Pversion=\"$YAGURA_VERSION\"",
    "suffix": "-SNAPSHOT",
    "available": "case \"$YAGURA_VERSION\" in *-SNAPSHOT) curl -sf -o /dev/null \"$MAVEN_REPO/snapshots/com/example/lib/$YAGURA_VERSION/maven-metadata.xml\";; *) curl -sf -o /dev/null \"$MAVEN_REPO/releases/com/example/lib/$YAGURA_VERSION/lib-$YAGURA_VERSION.pom\";; esac",
    "unpublish": "curl -sf -u \"$MAVEN_USER:$MAVEN_PASSWORD\" -X DELETE \"$MAVEN_REPO/snapshots/com/example/lib/$YAGURA_VERSION\""
  }
}
EOF

  mkdir -p app-seed/src/main/java/com/example/app app-seed/.agents/verify
  echo "rootProject.name = 'app'" > app-seed/settings.gradle
  cat > app-seed/build.gradle <<'EOF'
plugins { id 'application' }

def pins = new Properties()
def pinFile = file('app/deps.txt')
if (pinFile.exists()) pinFile.withInputStream { pins.load(it) }

repositories {
    maven { url = "${System.getenv('MAVEN_REPO')}/releases"; allowInsecureProtocol = true }
    maven { url = "${System.getenv('MAVEN_REPO')}/snapshots"; allowInsecureProtocol = true }
}

dependencies {
    implementation "com.example:lib:${pins.getProperty('lib', '1.4.0')}"
}

application { mainClass = 'com.example.app.Main' }
EOF
  cat > app-seed/src/main/java/com/example/app/Main.java <<'EOF'
package com.example.app;

import com.example.lib.Greeter;

public final class Main {
    public static void main(String[] args) {
        System.out.println(Greeter.greet("app"));
    }
}
EOF
  cat > app-seed/.agents/verify/verify.json <<'EOF'
{
  "provider": "local-process",
  "checks": [{ "name": "build", "command": "gradle -q build --refresh-dependencies", "tier": "unit-verified", "timeoutSeconds": 600 }]
}
EOF
  for r in lib app; do
    printf '.gradle/\nbuild/\n' > $r-seed/.gitignore
    (cd $r-seed && git init -q -b main && git add -A && git_ commit -qm init)
    git clone -q --bare $r-seed $r.git
  done

  echo "publishing lib 1.4.0 (already released) and checking app builds on it..."
  (cd lib-seed && gradle -q publish -Pversion=1.4.0)
  (cd app-seed && gradle -q build)

  cat > fake-claude.sh <<EOF
#!/bin/sh
FAKE_MODE=engine FAKE_DELAY_MS=\${FAKE_DELAY_MS:-3000} exec node "$ROOT/packages/core/src/harness/fixtures/fake-agent.mjs" "\$@"
EOF
  chmod +x fake-claude.sh
  Y set harness.claude.bin "\"$DEMO/fake-claude.sh\"" >/dev/null
  Y set forge.poll_seconds 5 >/dev/null
  Y repo add "$DEMO/lib.git" --id lib --land push >/dev/null
  Y repo add "$DEMO/app.git" --id app --land push >/dev/null
  Y env add local --provider local-process --capacity 2 >/dev/null
  Y env value set local MAVEN_REPO "$MAVEN_REPO" --note "Reposilite standing in for Nexus" >/dev/null
  Y env value set local MAVEN_USER "$MAVEN_USER" >/dev/null
  Y env value set local MAVEN_PASSWORD "$MAVEN_PASSWORD" >/dev/null
  Y project new demo --goal "lib gains a feature that app uses" --predicate "both landed" --repo lib --repo app --merge human --env local >/dev/null
  Y unit add demo --repo lib --goal "write lib" --write 'lib/**' --accept "lib file exists" --verify true >/dev/null
  Y unit add demo --repo app --goal "write app against lib's change" --write 'app/**' --accept "app file exists" --verify true --needs 1:source >/dev/null

  nohup node "$ROOT/apps/cli/dist/main.js" daemon > "$DEMO/daemon.log" 2>&1 &
  echo $! > "$DEMO/daemon.pid"
  cat <<EOF

Running. Open http://127.0.0.1:$PORT/p/demo
  1. U1 (lib) verifies; a test build lands in Reposilite:  $MAVEN_REPO/#/snapshots/com/example/lib
  2. U2 (app) builds on that test version and is verified.
  3. Answer the land gate for U1 (bell, or: YAGURA_HOME=$YAGURA_HOME yagura gate answer <id> land).
  4. U2 now waits for lib 1.5.0 to be released. Play CI:   scripts/demo-publish.sh release
  5. Within ~5 s yagura re-pins U2 to 1.5.0 and verifies it again; land U2's gate. The test build is deleted.
Log: tail -f $DEMO/daemon.log     State: scripts/demo-publish.sh status     Stop: scripts/demo-publish.sh down
EOF
}

release() {
  rm -rf "$DEMO/ci" && git clone -q "$DEMO/lib.git" "$DEMO/ci"
  (cd "$DEMO/ci" && git log --oneline | head -1 && gradle -q publish -Pversion=1.5.0)
  echo "published lib 1.5.0 from lib's trunk, as CI would"
}

status() {
  Y show demo 2>&1 | head -12
  echo; echo "publications:"
  sqlite3 "$YAGURA_HOME/yagura.db" "select 'U'||unit_id, kind, state, coalesce(version,'') from publications"
  echo; echo "open gates:"; Y gates 2>&1 | head
  echo; echo "snapshots in the repository:"
  curl -s "$MAVEN_REPO/api/maven/details/snapshots/com/example/lib" | grep -o '"name":"[^"]*SNAPSHOT"' || echo "  (none)"
  [ -d "$DEMO/chk" ] && rm -rf "$DEMO/chk"
  if git clone -q "$DEMO/app.git" "$DEMO/chk" 2>/dev/null && [ -f "$DEMO/chk/app/deps.txt" ]; then echo; echo "app's trunk pins: $(cat "$DEMO/chk/app/deps.txt")"; fi
}

down() {
  [ -f "$DEMO/daemon.pid" ] && kill "$(cat "$DEMO/daemon.pid")" 2>/dev/null || true
  docker rm -f yg-reposilite >/dev/null 2>&1 || true
  [ "${1:-}" = quiet ] || echo "stopped (files kept in $DEMO)"
}

"${1:-up}" "${2:-}"
