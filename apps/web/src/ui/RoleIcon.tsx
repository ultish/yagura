import {
  Binoculars,
  Cog,
  Eye,
  Hammer,
  GitMerge,
  Map as MapIcon,
  MessageSquareReply,
  Package,
  PackageCheck,
  Pin,
  ShieldCheck,
  User,
  type LucideIcon,
} from "lucide-react";

// Keyed by the names roleOf returns and by a story entry's actor; neutral colour, since colour carries state (amber alive, vermilion needs you, pine landed).
const ICONS: Record<string, LucideIcon> = {
  planner: MapIcon,
  plan: MapIcon,
  worker: Hammer,
  work: Hammer,
  verifier: ShieldCheck,
  verify: ShieldCheck,
  reviewer: Eye,
  review: Eye,
  "review triage": MessageSquareReply,
  "review-triage": MessageSquareReply,
  rebase: GitMerge,
  "pack writer": Package,
  pack: Package,
  "pack proof": PackageCheck,
  "re-pin": Pin,
  watchman: Binoculars,
  person: User,
  you: User,
  yagura: Cog,
};

export function RoleIcon({ role, size = "1.15em" }: { role: string; size?: number | string }) {
  const Icon = ICONS[role.toLowerCase().trim()];
  return Icon ? <Icon className="role-icon" size={size} strokeWidth={1.75} aria-hidden="true" /> : null;
}

export function RoleLabel({ role, text }: { role: string; text?: string }) {
  return (
    <span className="role-label">
      <RoleIcon role={role} />
      {text ?? role}
    </span>
  );
}
