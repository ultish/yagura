export interface EnvironmentRow {
  environment: { id: string; name?: string | null };
}

export interface EnvironmentChoice {
  id: string;
  label: string;
}

// The environments a project can run in, as the API lists them. The project's current one is always offered, so the box never shows
// "none" for an environment that is set.
export function environmentChoices(rows: EnvironmentRow[], current: string | null): EnvironmentChoice[] {
  const choices = rows.map(({ environment: e }) => ({ id: e.id, label: e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id }));
  if (current && !choices.some((c) => c.id === current)) choices.push({ id: current, label: `${current} (not found)` });
  return choices;
}
