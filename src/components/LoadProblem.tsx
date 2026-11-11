"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LoadProblem({ summary, hint, reference }: { summary: string; hint?: string; reference?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <section role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <h2 className="font-semibold">{summary}</h2>
      {hint && <p className="mt-1 text-sm">{hint}</p>}
      {reference && <p className="mt-1 text-xs opacity-80">Reference: <span className="font-mono">{reference}</span></p>}
      <Button type="button" variant="outline" className="mt-4" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        <RotateCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />Retry
      </Button>
    </section>
  );
}
