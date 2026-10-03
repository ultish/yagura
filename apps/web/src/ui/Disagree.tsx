import { useState } from "react";
import { api } from "../api";
import { Inline } from "../lib/markdown";
import { Link } from "./Link";
import { useAction } from "./rows";

// One way to say "I disagree", wherever the thing is shown: a story line, the repo browser's panel, a file in a diff.
export interface DisagreeOption {
  ref: string;
  text: string;
  // Code quotes are shown as typed, not read as markdown.
  plain?: boolean;
}

const field = { background: "var(--bg)", border: "1px solid var(--btnline)", borderRadius: 4, padding: "7px 10px", fontSize: 14, width: "100%" } as const;

export function DisagreeButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn sm story-disagree" type="button" onClick={onClick}>
      Disagree…
    </button>
  );
}

export function DisagreeForm({
  unit,
  options,
  initial,
  hint,
  where,
  onDone,
}: {
  unit: { projectId: string; seq: number };
  options: DisagreeOption[];
  initial?: string;
  hint?: string;
  // Set where the unit's story is not in view: after recording, say where the disagreement went.
  where?: boolean;
  onDone: () => void;
}) {
  const [ref, setRef] = useState(initial ?? options[0]!.ref);
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<"follow-up" | "note">("follow-up");
  const [recorded, setRecorded] = useState(false);
  const save = useAction();
  const id = `disagree-${options[0]!.ref}`;
  if (recorded)
    return (
      <div className="story-form">
        Recorded on U{unit.seq}.{" "}
        {action === "follow-up" ? "The planner will plan a follow-up unit for it." : "Later verifiers of this repo will read it as context."}{" "}
        <Link to={`/p/${unit.projectId}/u/${unit.seq}`}>See it in U{unit.seq}'s story →</Link>{" "}
        <button type="button" className="diff-open" onClick={onDone}>
          Close
        </button>
      </div>
    );
  return (
    <form
      className="story-form"
      onSubmit={(e) => {
        e.preventDefault();
        const about = options.find((o) => o.ref === ref)!.text;
        void save.run(async () => {
          await api(`/api/projects/${unit.projectId}/units/${unit.seq}/disagreements`, { body: { ref, about, reason, action } });
          if (where) setRecorded(true);
          else onDone();
        });
      }}
    >
      <fieldset>
        <legend>About which part?</legend>
        {options.map((o) => (
          <label key={o.ref} className="story-choice">
            <input type="radio" name={`${id}-about`} checked={ref === o.ref} onChange={() => setRef(o.ref)} />
            <span className={o.plain ? "mono" : undefined}>{o.plain ? o.text : <Inline text={o.text} />}</span>
          </label>
        ))}
        {hint && <div className="muted">{hint}</div>}
      </fieldset>
      <label className="story-field">
        Why
        <textarea
          id={`${id}-why`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          rows={3}
          placeholder="What is wrong, in your words. It is kept with the decision and shown to the agents that act on it."
          style={field}
        />
      </label>
      <fieldset>
        <legend>What should happen</legend>
        <label className="story-choice">
          <input type="radio" name={`${id}-then`} checked={action === "follow-up"} onChange={() => setAction("follow-up")} />
          <span>Plan a follow-up unit that fixes it forward (trunk is never rewritten)</span>
        </label>
        <label className="story-choice">
          <input type="radio" name={`${id}-then`} checked={action === "note"} onChange={() => setAction("note")} />
          <span>Only record it: later verifiers of this repo read it as context</span>
        </label>
      </fieldset>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm lamp" type="submit" disabled={save.busy || !reason.trim()}>
          Record disagreement
        </button>
        <button className="btn sm" type="button" onClick={onDone}>
          Cancel
        </button>
        {save.error && <span className="s-bell">{save.error}</span>}
      </div>
    </form>
  );
}
