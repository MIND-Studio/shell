"use client";

/**
 * Copy-with-auto-clear (PRD §4.1).
 *
 * Browser honesty: a page cannot read the clipboard's prior contents without an
 * explicit (and unusual) permission/user gesture, so we cannot reliably
 * "restore" what was there before. The defensible behavior is therefore:
 * write the secret, and after `ms`, CLEAR the clipboard — but only if it still
 * holds the value we wrote (so we don't stomp on something the user copied in
 * the meantime). We make a best-effort attempt to read it back for that check;
 * if reading is denied, we clear unconditionally (fail safe — never leave a
 * secret lingering).
 */

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export const DEFAULT_CLEAR_MS = 30_000;

export async function copyWithAutoClear(
  text: string,
  ms: number = DEFAULT_CLEAR_MS
): Promise<void> {
  await navigator.clipboard.writeText(text);

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    pendingTimer = null;
    try {
      // Only clear if our value is still on the clipboard.
      let current: string | null = null;
      try {
        current = await navigator.clipboard.readText();
      } catch {
        current = null; // read denied — fail safe and clear anyway
      }
      if (current === null || current === text) {
        await navigator.clipboard.writeText("");
      }
    } catch {
      /* best-effort; some browsers block background clipboard writes */
    }
  }, ms);
}

/** Cancel a pending auto-clear (e.g. on lock/unmount). */
export function cancelAutoClear(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}
