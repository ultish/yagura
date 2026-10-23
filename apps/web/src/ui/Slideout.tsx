import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

// A panel that slides in over the page from one edge. It is a modal <dialog>, so the browser holds focus inside it, closes it on Escape,
// dims and blocks the page behind it, and the backdrop closes it with a click. The caller keeps `open` and a button that sets it.
export function Slideout({
  id,
  open,
  onClose,
  label,
  side = "right",
  children,
}: {
  id?: string;
  open: boolean;
  onClose: () => void;
  label: string;
  side?: "left" | "right";
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      id={id}
      ref={dialog}
      className={`slideout slideout-${side}`}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="slideout-panel">
        <div className="slideout-head">
          <span className="serif slideout-title">{label}</span>
          <button type="button" className="slideout-close" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose}>
            <X size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <div className="slideout-body">{children}</div>
      </div>
    </dialog>
  );
}
