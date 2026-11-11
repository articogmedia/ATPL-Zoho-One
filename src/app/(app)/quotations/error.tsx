"use client";
import { AppErrorState } from "@/components/AppErrorState";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorState title="Quotations could not load" message="Please try again. Your saved offers are unchanged." error={error} reset={reset} />;
}
