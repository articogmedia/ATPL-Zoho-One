"use client";

import { AppErrorState } from "@/components/AppErrorState";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorState title="Something went wrong" message="Please try again. Your Zoho CRM work is unchanged." error={error} reset={reset} />;
}
