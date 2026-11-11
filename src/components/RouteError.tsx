"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export function RouteError({ error, reset, title = "This page could not load" }: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    console.error("[route-error]", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center px-6 text-center" role="alert">
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      <p className="mt-2 text-muted-foreground">Please try again. Your work in Zoho CRM has not been removed.</p>
      {error.digest && <p className="mt-2 text-xs text-muted-foreground">Reference: <span className="font-mono">{error.digest}</span></p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button type="button" onClick={reset}>Try again</Button>
        <Button asChild variant="outline"><Link href="/home">Go to Home</Link></Button>
      </div>
    </main>
  );
}
