"use client";

import { RouteError } from "@/components/RouteError";

export default function HomeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} title="Home could not load" />;
}
