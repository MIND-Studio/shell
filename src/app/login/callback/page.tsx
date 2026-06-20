"use client";

import { Button } from "@mind-studio/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getPlatform } from "@/lib/platform";
import { consumeReturnTo } from "@/lib/solid/auth";

export default function LoginCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Consume the OIDC code, then SPA-navigate to the returnTo. `router.replace`
    // (not window.location) keeps the in-memory @inrupt session alive.
    // `platform.auth.completeLogin` (web) shares one single-flight
    // handleIncomingRedirect with `ensureSession`, so the shell's session-aware
    // components (mounted on this route too) can't redeem the one-time code a
    // second time (HARD rule #3).
    getPlatform()
      .then((p) => p.auth.completeLogin())
      .then((info) => {
        if (!info.isLoggedIn) {
          setError("Sign-in did not complete. Please try again.");
          return;
        }
        router.replace(consumeReturnTo());
      })
      .catch((e) => setError(String(e)));
  }, [router]);

  return (
    <section className="mx-auto grid h-screen max-w-md place-items-center px-6 text-center">
      <div>
        {error ? (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-destructive">
              Login failed
            </p>
            <p className="mt-3 break-all font-mono text-sm">{error}</p>
            <Button asChild variant="outline" className="mt-6">
              <Link href="/connect">Try again</Link>
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">Finishing sign-in…</p>
        )}
      </div>
    </section>
  );
}
