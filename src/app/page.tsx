"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { resolveEntry } from "@/lib/solid/resume";

/**
 * The apex `/` is a thin router. `resolveEntry()` runs the background-resume
 * decision: an already-in or silently-resumable user goes straight to the shell;
 * a locked-wallet user (`'unlock'`) and a brand-new user (`'connect'`) both land
 * on /connect, which renders the right surface. The shell itself also guards for
 * a session, so this is just a fast first hop.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    resolveEntry()
      .then((state) => router.replace(state === "in" ? "/shell" : "/connect"))
      .catch(() => router.replace("/connect"));
  }, [router]);

  return (
    <section className="grid h-screen place-items-center">
      <p className="text-muted-foreground">Loading Mind Shell…</p>
    </section>
  );
}
