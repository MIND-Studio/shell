"use client";

/**
 * Auto-lock (PRD §4.1). On idle timeout, on tab hidden (`visibilitychange`),
 * or on window blur, invoke the supplied `onLock` — which should call the
 * core's `lock(handle)` and drop all decrypted state from memory. The core
 * does the zeroize; this hook only schedules and triggers.
 */

import { useEffect, useRef } from "react";

export const DEFAULT_IDLE_MS = 5 * 60 * 1000; // 5 minutes

const ACTIVITY_EVENTS: (keyof DocumentEventMap)[] = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
];

/**
 * Wire auto-lock while `active` is true. `onLock` is called on idle/hidden/blur.
 * Activity resets the idle timer. The hook re-arms whenever `onLock`/`active`/`idleMs`
 * change; callers should pass a stable `onLock` (e.g. via useCallback).
 */
export function useAutoLock(
  active: boolean,
  onLock: () => void,
  idleMs: number = DEFAULT_IDLE_MS
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockRef = useRef(onLock);
  lockRef.current = onLock;

  useEffect(() => {
    if (!active) return;

    const fire = () => lockRef.current();

    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(fire, idleMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") fire();
    };

    reset();
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, reset, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", fire);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, reset);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", fire);
    };
  }, [active, idleMs]);
}
