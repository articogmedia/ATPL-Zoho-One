"use client";
import { Button } from "@/components/ui/button";
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="rounded-xl border bg-card p-6 text-center"><h2 className="font-semibold">Quotations could not load</h2><Button className="mt-4" onClick={reset}>Try again</Button></div>;
}
