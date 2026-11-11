"use client";
import { AppErrorState } from "@/components/AppErrorState";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorState title="Home could not load" message="Please try again. Your dashboard data is unchanged." error={error} reset={reset} />;
}
