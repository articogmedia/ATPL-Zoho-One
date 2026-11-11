"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PageLoadError({ message = "This page is taking longer than usual to load.", reference }: { message?: string; reference?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <section role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
    <h2 className="font-semibold">We could not load this page yet</h2>
    <p className="mt-1 text-sm">{message}</p>
    {reference && <p className="mt-2 text-xs">Reference: {reference}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        <RotateCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} />Try again
      </Button>
      <Button asChild variant="outline"><Link href="/home">Go to Home</Link></Button>
    </div>
  </section>;
}
