import { useEffect, type RefObject } from "react";

/** Closes a popover on outside pointer-down or Escape; returns focus to `returnFocus` on Escape. */
export function useDismiss(
  open: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t && refs.some((r) => r.current?.contains(t) === true)) return;
      onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      returnFocus?.current?.focus();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
    // refs are stable objects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}

/** True when keyboard focus is in a text-entry control (shortcuts must not fire there). */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "TEXTAREA" ||
    (tag === "INPUT" && !["checkbox", "radio", "button"].includes((el as HTMLInputElement).type)) ||
    el.isContentEditable
  );
}
