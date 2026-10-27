import { useState } from "react";
import { hasStoredToken, saveToken } from "../api";

export function TokenGate() {
  const [value, setValue] = useState("");
  const [tried] = useState(hasStoredToken);
  return (
    <main style={{ padding: 36, maxWidth: 560 }}>
      <h1 className="serif">Sign in</h1>
      <p className="muted">
        This yagura listens beyond localhost, so it wants its token. It is in the file <span className="mono">token</span> in yagura's home folder on the
        machine it runs on, and <span className="mono">yagura start</span> and <span className="mono">yagura status</span> print it in a link.
      </p>
      {tried && <p className="s-bell">That token was not accepted. Check it and try again.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) saveToken(value);
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          type="password"
          className="mono"
          aria-label="Token"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: "1 1 280px", minWidth: 0, background: "var(--bg2)", border: "1px solid var(--btnline)", borderRadius: 5, padding: "8px 10px" }}
        />
        <button type="submit" className="btn bell" disabled={!value.trim()}>
          Sign in
        </button>
      </form>
    </main>
  );
}
