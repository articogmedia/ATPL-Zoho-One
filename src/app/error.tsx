"use client";

import { RouteError } from "@/components/RouteError";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <RouteError error={error} reset={reset} title="This page didn’t load" />
    </div>
  );
}
