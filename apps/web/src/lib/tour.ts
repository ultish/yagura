import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

export const TOUR_SEEN_KEY = "yagura.tour";

// The tour points only at the header, so it reads the same on any page and on an empty install.
export const TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: "How yagura works",
      description:
        "You give a project a goal. Yagura splits it into units, an agent builds each one on its own branch, and a fresh agent judges it against test runs yagura recorded itself. Nothing merges until you say so. It takes about a minute.",
    },
  },
  {
    element: '[data-tour="repos"]',
    popover: { title: "1. Add your repos", description: "Paste a git URL. Yagura keeps its own copy, and agents work on separate branches of it." },
  },
  {
    element: '[data-tour="environments"]',
    popover: {
      title: "2. Say how tests run",
      description: "Describe the machine: how tests run and how libraries are published. The doctor runs each answer to prove it before agents rely on it.",
    },
  },
  {
    element: '[data-tour="projects"]',
    popover: {
      title: "3. Create a project",
      description:
        "Write the goal and how anyone can tell it is done, and tick the repos it may change. Each unit then moves from plan to work to judge to merge.",
    },
  },
  {
    element: '[data-tour="talk"]',
    popover: { title: "Or describe it in Talk", description: "Say what you want in plain words. Yagura proposes a project, and you press Go." },
  },
  {
    element: '[data-tour="gates"]',
    popover: {
      title: "4. Decide what merges",
      description: "A unit the judge approves waits here for you: merge it, hold it, or send it back. Questions from agents land here too.",
      side: "bottom",
    },
  },
  {
    element: '[data-tour="help"]',
    popover: { title: "Replay it any time", description: "This button runs the tour again." },
  },
];

export function tourSeen(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(TOUR_SEEN_KEY) !== null;
  } catch {
    return true;
  }
}

export function markTourSeen(storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(TOUR_SEEN_KEY, "1");
  } catch {}
}

// A step whose target is on screen points at it. One whose target is hidden (the links sit in the menu on a narrow screen) keeps its text as a centred note.
export function stepsFor(shown: (selector: string) => boolean): DriveStep[] {
  return TOUR_STEPS.map((s) => {
    if (!s.element || shown(s.element as string)) return s;
    const { element: _gone, ...rest } = s;
    return { ...rest, popover: { ...s.popover, description: `${s.popover?.description ?? ""} It is in the menu at the top.` } };
  });
}

export function startTour(): void {
  const shown = (selector: string) => (document.querySelector(selector)?.getClientRects().length ?? 0) > 0;
  driver({ showProgress: true, allowClose: true, overlayOpacity: 0.55, popoverClass: "yagura-tour", steps: stepsFor(shown) }).drive();
}
