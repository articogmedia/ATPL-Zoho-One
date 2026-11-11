"use client";
import { AppErrorState } from "@/components/AppErrorState";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorState title="Leads could not load" message="Please try again. Your Zoho leads are unchanged." error={error} reset={reset} />;
}
