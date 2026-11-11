"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function AppErrorState({ title, message, error, reset }: {
  title: string;
  message: string;
  error?: Error & { digest?: string };
  reset?: () => void;
}) {
  const router = useRouter();
  const [reference, setReference] = useState("");
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!error?.digest) setReference(crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase());
  }, [error?.digest]);
  return <section role="alert" className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center rounded-xl border border-border bg-card p-6 text-center">
    <h1 className="text-xl font-semibold">{title}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{message}</p>
    <p className="mt-2 text-xs text-muted-foreground">Reference: {(error?.digest ?? reference) || "Preparing"}</p>
    <div className="mt-5 flex flex-wrap justify-center gap-2">
      <Button type="button" disabled={pending} onClick={() => startTransition(() => reset ? reset() : router.refresh())}>Try again</Button>
      <Button asChild variant="outline"><Link href="/home">Go to Home</Link></Button>
    </div>
  </section>;
}
