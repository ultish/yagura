import { lazy, Suspense, useEffect, useState } from "react";
import { LiveContext, useApi, useLiveVersion, usePath } from "./api";
import { Agent, AgentByNo, UnitAgent } from "./pages/Agent";
import { Prompts } from "./pages/Prompts";
import { Unit } from "./pages/Unit";

// The repo browser carries Monaco, so it loads only when opened.
const Repo = lazy(() => import("./pages/Repo"));
const Spec = lazy(() => import("./pages/Spec"));
import { Agents } from "./pages/Agents";
import { Home } from "./pages/Home";
import { Project } from "./pages/Project";
import { Projects } from "./pages/Projects";
import { Environments } from "./pages/Environments";
import { Environment } from "./pages/Environment";
import { DoctorRun } from "./pages/DoctorRun";
import { Gates } from "./pages/Gates";
import { Repos } from "./pages/Repos";
import { Settings } from "./pages/Settings";
import { Search } from "./pages/Search";
import { Talk } from "./pages/Talk";
import markDark from "./assets/mark-dark.png";
import markLight from "./assets/mark-light.png";
import { Link } from "./ui/Link";
import { BellAlert } from "./ui/BellAlert";
import { SearchBox } from "./ui/SearchBox";

type Theme = "night" | "day";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "day" ? "day" : "night"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("yagura.theme", theme);
    } catch {}
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "night" ? "day" : "night"))];
}

const NAV = [
  { to: "/", label: "The watch", match: (p: string) => p === "/" },
  { to: "/talk", label: "Talk", match: (p: string) => p.startsWith("/talk") },
  { to: "/projects", label: "Projects", match: (p: string) => p === "/projects" || p.startsWith("/p/") },
  { to: "/agents", label: "Agents", match: (p: string) => p.startsWith("/agents") || p.startsWith("/a/") },
  { to: "/gates", label: "Gates", match: (p: string) => p === "/gates" },
  { to: "/repos", label: "Repos", match: (p: string) => p === "/repos" || p.startsWith("/r/") },
  { to: "/environments", label: "Environments", match: (p: string) => p === "/environments" || p.startsWith("/e/") || p.startsWith("/d/") },
  { to: "/settings", label: "Settings", match: (p: string) => p === "/settings" || p === "/prompts" },
];

function Header() {
  const path = usePath();
  const [theme, toggle] = useTheme();
  const health = useApi<{ ok: boolean; home: string }>("/api/health");
  return (
    <header
      style={{ minHeight: 60, display: "flex", alignItems: "center", gap: 36, padding: "0 36px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}
    >
      <Link to="/" aria-label="yagura, the watch" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", textDecoration: "none" }}>
        <img src={theme === "night" ? markDark : markLight} alt="" width={36} height={37} style={{ display: "block" }} />
        <span className="serif" style={{ fontSize: 17, letterSpacing: ".12em" }}>
          yagura
        </span>
      </Link>
      <nav aria-label="Main" style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", flex: "1 1 180px", minWidth: 0 }}>
        {NAV.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            aria-current={n.match(path) ? "page" : undefined}
            style={{ color: n.match(path) ? "var(--text)" : "var(--muted)", fontWeight: n.match(path) ? 700 : 400, textDecoration: "none", fontSize: 14.5 }}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <SearchBox />
      <div className="mono" style={{ fontSize: 12, color: health.error ? "var(--bell-text)" : "var(--muted)" }}>
        {health.error ? "daemon unreachable" : `${location.host}`}
      </div>
      <BellAlert />
      <button
        type="button"
        onClick={toggle}
        aria-label={theme === "night" ? "Switch to daybreak theme" : "Switch to night theme"}
        className="mono"
        style={{ fontSize: 12, border: "1px solid var(--btnline)", background: "transparent", borderRadius: 999, padding: "6px 12px", cursor: "pointer" }}
      >
        {theme === "night" ? "☾ night · daybreak" : "☀ daybreak · night"}
      </button>
    </header>
  );
}

function Routes() {
  const path = usePath();
  let m: RegExpExecArray | null;
  if (path === "/") return <Home />;
  if (path === "/projects") return <Projects />;
  if (path === "/agents") return <Agents />;
  if (path === "/gates") return <Gates />;
  if (path === "/repos") return <Repos />;
  if (path === "/environments") return <Environments />;
  if (path === "/settings") return <Settings />;
  if (path === "/search") return <Search />;
  if ((m = /^\/talk(?:\/(\d+))?\/?$/.exec(path))) return <Talk threadId={m[1] ? Number(m[1]) : null} />;
  if ((m = /^\/a\/(\d+)\/?$/.exec(path))) return <Agent key={m[1]} attemptId={Number(m[1])} />;
  if ((m = /^\/p\/([a-z][a-z0-9-]*)\/spec\/?$/.exec(path)))
    return (
      <Suspense
        fallback={
          <main style={{ padding: 36 }} className="muted">
            Loading the editor…
          </main>
        }
      >
        <Spec key={m[1]} projectId={m[1]!} />
      </Suspense>
    );
  if (path === "/prompts") return <Prompts key={path} projectId={null} />;
  if ((m = /^\/p\/([a-z][a-z0-9-]*)\/prompts\/?$/.exec(path))) return <Prompts key={path} projectId={m[1]!} />;
  if ((m = /^\/p\/([a-z][a-z0-9-]*)\/a\/(\d+)\/?$/.exec(path))) return <AgentByNo key={path} projectId={m[1]!} agentNo={Number(m[2])} />;
  if ((m = /^\/p\/([a-z][a-z0-9-]*)\/u\/(\d+)\/(\d+)\/?$/.exec(path))) return <UnitAgent projectId={m[1]!} seq={Number(m[2])} n={Number(m[3])} />;
  if ((m = /^\/p\/([a-z][a-z0-9-]*)\/u\/(\d+)\/?$/.exec(path))) return <Unit key={path} projectId={m[1]!} seq={Number(m[2])} />;
  if ((m = /^\/p\/([a-z][a-z0-9-]*)\/?$/.exec(path))) return <Project id={m[1]!} />;
  if ((m = /^\/e\/([a-z][a-z0-9-]*)\/?$/.exec(path))) return <Environment key={m[1]} id={m[1]!} />;
  if ((m = /^\/d\/(\d+)\/?$/.exec(path))) return <DoctorRun key={m[1]} id={Number(m[1])} />;
  if ((m = /^\/r\/([a-z][a-z0-9-]*)\/?$/.exec(path)))
    return (
      <Suspense
        fallback={
          <main style={{ padding: 36 }} className="muted">
            Loading the editor…
          </main>
        }
      >
        <Repo key={m[1]} id={m[1]!} />
      </Suspense>
    );
  return (
    <main style={{ padding: 36 }}>
      <h1 className="serif">Nothing here</h1>
      <Link to="/">Back to the watch</Link>
    </main>
  );
}

export function App() {
  const live = useLiveVersion();
  return (
    <LiveContext.Provider value={live}>
      <Header />
      <Routes />
    </LiveContext.Provider>
  );
}
