"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

export function HomeCountFailure() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex items-center gap-1" aria-label="Count unavailable">
      <span className="min-w-8 text-center text-sm font-bold" aria-label="Count unavailable">-</span>
      <button
        type="button"
        aria-label="Retry count"
        title="Retry count"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
        className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
      >
        <RotateCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
      </button>
    </span>
  );
}
