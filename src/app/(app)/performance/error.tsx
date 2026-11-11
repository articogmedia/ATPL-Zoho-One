"use client";
import { AppErrorState } from "@/components/AppErrorState";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorState title="Performance could not load" message="Please try again. Sales records are unchanged." error={error} reset={reset} />;
}
