import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { navigate, useApi, type BellItem } from "../api";
import { announce, faviconHref, newItems, tabTitle } from "../lib/bellalert";

// Rings outside the page: the tab's title carries the count, its icon gets a lamp (and, while the tab is hidden, blinks
// slowly unless motion is reduced), and a new item raises a desktop notification when this tab is not the one in view.
export function BellAlert() {
  const items = useApi<BellItem[]>("/api/bell").data;
  const count = items?.length ?? 0;
  const seen = useRef<Set<string> | null>(null);
  const supported = typeof Notification !== "undefined";
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(supported ? Notification.permission : "unsupported");

  useEffect(() => {
    document.title = tabTitle(count);
  }, [count]);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.href = faviconHref(count > 0);
    if (!count) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let on = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      if (timer) clearInterval(timer);
      timer = null;
      link.href = faviconHref(true);
      if (document.hidden && !calm)
        timer = setInterval(() => {
          on = !on;
          link.href = faviconHref(on);
        }, 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (timer) clearInterval(timer);
    };
  }, [count]);

  useEffect(() => {
    if (!items) return;
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.id));
      return;
    }
    const fresh = newItems(seen.current, items);
    for (const i of items) seen.current.add(i.id);
    if (permission !== "granted" || document.hasFocus()) return;
    for (const item of fresh) {
      const a = announce(item);
      const n = new Notification(a.title, { body: a.body, tag: item.id, icon: faviconHref(true) });
      n.onclick = () => {
        window.focus();
        navigate(a.href);
        n.close();
      };
    }
  }, [items, permission]);

  if (permission !== "default") return null;
  return (
    <button
      type="button"
      className="mono"
      title="Show a desktop notification when something needs you and this tab is in the background"
      onClick={() => void Notification.requestPermission().then(setPermission)}
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        fontSize: 12,
        border: "1px solid var(--btnline)",
        background: "transparent",
        borderRadius: 999,
        padding: "6px 12px",
        cursor: "pointer",
      }}
    >
      <Bell size={13} strokeWidth={1.75} aria-hidden="true" />
      notify me
    </button>
  );
}
