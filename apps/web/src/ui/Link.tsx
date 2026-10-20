import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../api";

export function Link({ to, keepScroll, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; keepScroll?: boolean }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to, keepScroll);
  };
  return <a href={to} onClick={click} {...rest} />;
}
