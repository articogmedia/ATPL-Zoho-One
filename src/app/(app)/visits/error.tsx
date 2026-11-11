"use client";
import { AppErrorState } from "@/components/AppErrorState";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorState title="Visits could not load" message="Please try again. Scheduled work is unchanged." error={error} reset={reset} />;
}
