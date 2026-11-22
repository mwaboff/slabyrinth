import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  // not inside a closed <details> (only its summary shows) or a hidden part
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.closest("[hidden]") === null && el.closest("details:not([open]) > :not(summary)") === null,
  );
}

/**
 * A modal dialog's keyboard: focus moves in on open (the element marked `data-autofocus`, else the first control) and
 * back where it was on close; Tab and Shift+Tab stay inside; Escape closes. It listens on the document, so it still
 * works after the focused control went away (a step that turned to done); a dialog opened above it (focus inside
 * another dialog) gets the keys instead.
 */
export function useModal(dialog: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    if (!root) return;
    (root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root)[0] ?? root).focus();
    const key = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      if (active !== null && active !== document.body && !root.contains(active)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables(root);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const outside = active === null || !root.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (prev?.isConnected === true) prev.focus();
    };
    // the dialog element and onClose (a store action) are stable for the modal's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
