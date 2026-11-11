"use client";

import { RouteError } from "@/components/RouteError";

export default function PerformanceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} title="Performance could not load" />;
}
