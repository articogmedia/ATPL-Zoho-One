"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Something went wrong</h1>
      <p className="mt-2 text-muted-foreground">Please try again. Your work in Zoho CRM has not been removed.</p>
      <Button type="button" className="mt-6" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
