"use client";

import { useEffect, useState } from "react";
import { getView, subscribe } from "@/lib/identity/wallet";
import type { WalletView } from "@/lib/identity/types";

/**
 * Subscribe a component to the process-wide wallet singleton. Re-renders on every
 * create/unlock/lock/passport change. The view never carries seeds or handles —
 * only the public did + passport list (PRD-DID §8).
 */
export function useWallet(): WalletView {
  const [view, setView] = useState<WalletView>(() => getView());
  useEffect(() => {
    // Re-sync once on mount in case the wallet changed before we subscribed.
    setView(getView());
    return subscribe(() => setView(getView()));
  }, []);
  return view;
}
