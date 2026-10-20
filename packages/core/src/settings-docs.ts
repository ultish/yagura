import type { SettingKey } from "./config.js";

// How the dashboard presents each setting. A new setting does not compile until it has an entry here.
export const SETTING_GROUPS = [
  "Agents and models",
  "Skills",
  "Capacity",
  "Time limits and tries",
  "Budget",
  "Git and merging",
  "Issues",
  "Verification guide",
  "Test deployments",
  "The watchman",
  "The claude command",
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

export interface SettingDoc {
  group: SettingGroup;
  title: string;
  // One or two plain sentences: what it does and what happens when it changes.
  help: string;
  // A value as a person would type it; shown under the help and as the box's placeholder.
  example?: string;
  // Rarely changed: shown folded under "Advanced" in its group.
  advanced?: true;
  // A list whose entries can contain spaces is typed one per line.
  lines?: true;
  // A fixed set of values, shown as a choice instead of a text box.
  options?: readonly string[];
}

const HARNESS = "The agent program that runs this role. Leave it as claude unless another harness is wired in.";

export const SETTING_DOCS: Record<SettingKey, SettingDoc> = {
  "role.planner.model": {
    group: "Agents and models",
    title: "Planner model",
    help: "The model that splits a project's goal into units. Empty uses claude's own default.",
    example: "claude-opus-5-5",
  },
  "role.worker.model": {
    group: "Agents and models",
    title: "Worker model",
    help: "The model that writes the code for each unit. Empty uses claude's own default. A cheaper model costs less per unit but gets more things wrong.",
    example: "claude-sonnet-5-5",
  },
  "role.judge.model": {
    group: "Agents and models",
    title: "Judge model",
    help: "The model that checks each unit before you are asked to merge it. It defaults to Sonnet because a Haiku judge once approved stale guide pages. Empty uses the harness default, which suits an internal endpoint that names models differently.",
    example: "claude-sonnet-5-5",
  },
  "role.lead.model": {
    group: "Agents and models",
    title: "Unit lead model",
    help: "The model for the unit lead, the agent that steps in when a unit needs a decision, such as a failing CI run, a review comment or repeated rejections. Empty uses claude's own default.",
    example: "claude-sonnet-5-5",
  },
  "role.doctor.model": {
    group: "Agents and models",
    title: "Doctor model",
    help: "The model for the doctor, which runs an environment's answers to prove they work. Empty uses claude's own default.",
    example: "claude-haiku-4-5-20251001",
  },
  "role.planner.harness": { group: "Agents and models", title: "Planner harness", help: HARNESS, example: "claude", advanced: true },
  "role.worker.harness": { group: "Agents and models", title: "Worker harness", help: HARNESS, example: "claude", advanced: true },
  "role.lead.harness": { group: "Agents and models", title: "Unit lead harness", help: HARNESS, example: "claude", advanced: true },
  "role.judge.harness": { group: "Agents and models", title: "Judge harness", help: HARNESS, example: "claude", advanced: true },
  "role.doctor.harness": { group: "Agents and models", title: "Doctor harness", help: HARNESS, example: "claude", advanced: true },

  "skills.work": {
    group: "Skills",
    title: "Skills every worker must load",
    help: "Skill names a worker has to load before it starts. Work that skipped one is sent back (see the next setting). Separate names with spaces or commas.",
    example: "pstack:principle-prove-it-works pstack:tdd",
  },
  "skills.scaffold": {
    group: "Skills",
    title: "Extra skills for scaffold units",
    help: "Skills a worker must also load when its unit builds a new project's skeleton.",
    example: "pstack:architect",
  },
  "method.enforce_required_skills": {
    group: "Skills",
    title: "Send back work that skipped a required skill",
    help: "On by default. Turn it off if a required skill cannot be installed on this machine.",
  },

  max_parallel_agents: {
    group: "Capacity",
    title: "Agents running at once, everywhere",
    help: "The ceiling across every project. Raise it only if your machine and your account's rate limit can take more.",
    example: "4",
  },
  max_parallel_per_harness: {
    group: "Capacity",
    title: "Agents running at once per harness",
    help: "The ceiling for one agent program, such as claude, across every project.",
    example: "4",
  },
  "project.max_in_flight": {
    group: "Capacity",
    title: "Agents running at once in this project",
    help: "How many of the project's units may have an agent working at the same moment. Lower it to stop one project taking every slot.",
    example: "2",
  },

  "timebox.plan_seconds": {
    group: "Time limits and tries",
    title: "Planner time limit",
    help: "How long the planner may work on a plan before yagura stops it, in seconds.",
    example: "900 (15 minutes)",
  },
  "timebox.work_seconds": {
    group: "Time limits and tries",
    title: "Worker time limit",
    help: "How long a worker may spend on one try of a unit before yagura stops it, in seconds.",
    example: "1800 (30 minutes)",
  },
  "timebox.judge_seconds": {
    group: "Time limits and tries",
    title: "Judge time limit",
    help: "How long a judge may take to check a unit before yagura stops it, in seconds.",
    example: "1200 (20 minutes)",
  },
  "timebox.doctor_seconds": {
    group: "Time limits and tries",
    title: "Doctor time limit",
    help: "How long the doctor may spend proving an environment on one repo, in seconds.",
    example: "1200 (20 minutes)",
  },
  max_attempts: {
    group: "Time limits and tries",
    title: "Tries per unit",
    help: "How many times a unit is built before it is marked stuck and waits for you.",
    example: "2",
  },
  "judge.max_rounds": {
    group: "Time limits and tries",
    title: "Judge rejections before the unit lead steps in",
    help: "How many times in a row the judge may send a unit back for changes before the unit lead is woken to decide what to do.",
    example: "3",
  },
  "lead.max_decisions_per_unit": {
    group: "Time limits and tries",
    title: "Unit lead decisions per unit",
    help: "How many decisions a unit's lead may make on its own before the unit waits for you.",
    example: "4",
  },
  "work.resume_on_rejection": {
    group: "Time limits and tries",
    title: "Continue the worker's session after a rejection",
    help: "On: when the judge sends a unit back, the same worker session carries on with the findings and keeps its context. Off: a fresh worker starts each time.",
  },
  "work.resume_max_context": {
    group: "Time limits and tries",
    title: "Start a fresh worker when the old one is nearly full",
    help: "If the rejected session already used more than this share of its context window, a fresh worker starts instead. 0.6 means 60%.",
    example: "0.6",
    advanced: true,
  },
  "gates.timeout_hours": {
    group: "Time limits and tries",
    title: "Hours before an unanswered question takes its default",
    help: "Questions to you, such as 'merge this?', have a default answer. If nobody replies in this many hours, the default is taken; for a merge question it is Hold, so nothing merges by itself. Empty: wait for you forever.",
    example: "24",
  },

  "project.budget_usd": {
    group: "Budget",
    title: "Spending limit, in dollars",
    help: "Once the project's agents have spent this much, nothing new starts and running agents finish. Empty: no limit.",
    example: "25",
  },
  "project.budget_hours": {
    group: "Budget",
    title: "Time limit, in hours",
    help: "Wall-clock hours since the project became active. At 70% no new work starts but verified work still lands; at 100% everything stops. Empty: no limit.",
    example: "8",
  },

  "git.author_name": {
    group: "Git and merging",
    title: "Commit author name",
    help: "The name on the commits yagura lands.",
    example: "yagura",
  },
  "git.author_email": {
    group: "Git and merging",
    title: "Commit author email",
    help: "The email on the commits yagura lands.",
    example: "yagura@yourcompany.com",
  },
  "git.branch_prefix": {
    group: "Git and merging",
    title: "Branch prefix",
    help: "Unit branches are named <prefix>/<project>/u<number>, so this decides what they start with.",
    example: "yagura",
  },
  "forge.repo": {
    group: "Git and merging",
    title: "Name of the repo on its forge",
    help: "Only needed when yagura cannot read the name from the repo's URL, such as a self-hosted or renamed repo. Written as [host/]owner/name. Empty: read it from the URL.",
    example: "gitlab.internal/team/payments",
  },
  "forge.glab_hosts": {
    group: "Git and merging",
    title: "GitLab hosts",
    help: "Hosts whose repos are merged through merge requests. Add your internal GitLab here and 'Detect' will recognise it when you add a repo. Separate hosts with spaces or commas.",
    example: "gitlab.internal gitlab.corp.example.com",
  },
  "forge.poll_seconds": {
    group: "Git and merging",
    title: "How often to check the forge",
    help: "Seconds between checks of an open pull or merge request (CI results, review comments, a merge done by hand) and of watched issues.",
    example: "30",
  },
  "retro.watch_minutes": {
    group: "Git and merging",
    title: "Watch trunk after a merge, in minutes",
    help: "After a unit lands, keep watching trunk's CI and for anyone reverting it for this long. 0 turns the watch off.",
    example: "60",
  },
  "project.auto_revert": {
    group: "Git and merging",
    title: "Revert when trunk CI breaks",
    help: "If CI on trunk fails after one of yagura's landings, revert the change instead of fixing forward. Off by default.",
  },
  "project.reference_repos": {
    group: "Git and merging",
    title: "Reference repos",
    help: "Registered repos that already do something the way you want it done. Workers get a read-only copy to follow. Use repo ids, separated by spaces or commas.",
    example: "billing-service",
  },
  "forge.timeout_seconds": {
    group: "Git and merging",
    title: "Give up on a gh or glab call after",
    help: "Seconds one call to gh or glab may take before yagura abandons it and tries again at the next check.",
    example: "120",
    advanced: true,
  },
  "forge.gh_bin": {
    group: "Git and merging",
    title: "gh command",
    help: "The GitHub CLI yagura runs. Change it if gh is installed somewhere yagura cannot find it.",
    example: "/usr/local/bin/gh",
    advanced: true,
  },
  "forge.glab_bin": {
    group: "Git and merging",
    title: "glab command",
    help: "The GitLab CLI yagura runs. Change it if glab is installed somewhere yagura cannot find it.",
    example: "/usr/local/bin/glab",
    advanced: true,
  },
  "yagura.url": {
    group: "Git and merging",
    title: "Dashboard link for commit messages",
    help: "Linked from the trailer on landed commits so a reader can find the unit that made them. Empty: no link.",
    example: "http://devbox:7300",
    advanced: true,
  },

  "forge.trusted_authors": {
    group: "Issues",
    title: "Trusted forge users",
    help: "People whose word is yours. Their issues start work with no approval step, their review comments change what a unit must do, and their 'yes' approves the watchman's proposal. An issue from anyone else waits until a trusted user says yes. Type logins separated by spaces or commas.",
    example: "ultish alice",
  },
  "forge.watch_issues": {
    group: "Issues",
    title: "Watch issues on this repo",
    help: "yagura reads issues opened from now on. The watchman replies on each one and proposes the work. A repo with no forge is never watched.",
  },
  "forge.watch_existing_issues": {
    group: "Issues",
    title: "Also take up the issues already open",
    help: "Includes the backlog, up to 1000 issues, not only new ones. Turning it on after watching has started takes up the backlog too. Replies are paced by the daily limit for the whole repo.",
  },
  "issues.max_turns_per_day": {
    group: "Issues",
    title: "Watchman replies per issue, per day",
    help: "Each reply is a model call. Once one issue has used this many in a day, its later comments wait until tomorrow.",
    example: "10",
  },
  "issues.max_repo_turns_per_day": {
    group: "Issues",
    title: "Watchman replies per day, whole repo",
    help: "The most replies all of a repo's issues may use together in a day; the rest wait until tomorrow. Set it low, say 10, to pace a large backlog.",
    example: "10",
  },

  "verify.upkeep_every_merges": {
    group: "Verification guide",
    title: "Check the guide every N merges",
    help: "After this many merges into the repo, yagura adds a unit that re-checks the repo's verification guide against the app. 0: only when a judge reports a stale page or you ask.",
    example: "10",
  },

  "lease.keep": {
    group: "Test deployments",
    title: "Keep what a verification deployed",
    help: "After a unit has been verified, keep the test deployment (a namespace or slot) so you can look at it. never: always clean up. failed: keep it only when verification failed. always: keep every one.",
    example: "failed",
    options: ["never", "failed", "always"],
  },
  "lease.keep_hours": {
    group: "Test deployments",
    title: "Hours a kept deployment lives",
    help: "A deployment kept by the setting above is deleted after this many hours.",
    example: "2",
  },

  "role.watchman.model": {
    group: "The watchman",
    title: "Watchman model",
    help: "The model for the watchman, the assistant you talk to on the Talk page and on issues. Empty uses claude's own default.",
    example: "claude-sonnet-5-5",
  },
  "timebox.watchman_seconds": {
    group: "The watchman",
    title: "Watchman reply time limit",
    help: "How long one watchman reply may take before yagura stops it, in seconds.",
    example: "900 (15 minutes)",
  },
  "role.watchman.harness": { group: "The watchman", title: "Watchman harness", help: HARNESS, example: "claude", advanced: true },
  "watchman.context_tokens": {
    group: "The watchman",
    title: "Size of the watchman's briefing",
    help: "How much background (projects, threads, settings) goes into each reply, counted in tokens. A bigger briefing costs more per reply.",
    example: "40000",
    advanced: true,
  },
  "watchman.session_roll_tokens": {
    group: "The watchman",
    title: "Start a new watchman session after this many tokens",
    help: "Once a conversation's context passes this size, the next reply starts a new session, which keeps cost and drift down.",
    example: "150000",
    advanced: true,
  },
  "harness.claude.watchman_permission_mode": {
    group: "The watchman",
    title: "Watchman permission mode",
    help: "dontAsk refuses every tool the allowed list below does not name, which is the safe choice.",
    example: "dontAsk",
    advanced: true,
  },
  "watchman.allowed_tools": {
    group: "The watchman",
    title: "Tools the watchman may use",
    help: "Claude tool rules, one per line. The defaults let it read yagura's state. The yagura CLI refuses any write from an agent whatever this says.",
    example: "Bash(yagura show:*)",
    advanced: true,
    lines: true,
  },

  "harness.claude.bin": {
    group: "The claude command",
    title: "claude command",
    help: "The program yagura runs. If claude is only a shell function or alias on your machine, point this at a wrapper script; scripts/setup.sh writes one at ~/.local/bin/yagura-claude.",
    example: "/Users/you/.local/bin/yagura-claude",
    advanced: true,
  },
  "harness.claude.permission_mode": {
    group: "The claude command",
    title: "Permission mode for agents",
    help: "Passed to claude as its permission mode. Headless agents cannot answer prompts, so the default lets them run tools without asking.",
    example: "bypassPermissions",
    advanced: true,
  },
  "harness.claude.extra_args": {
    group: "The claude command",
    title: "Extra arguments for every claude run",
    help: "Added to every claude command yagura starts. Separate arguments with spaces.",
    example: "--add-dir /data/shared",
    advanced: true,
  },
};
