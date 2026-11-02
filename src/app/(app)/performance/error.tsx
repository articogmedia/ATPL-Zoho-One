"use client";
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="rounded-xl border bg-card p-6 text-center"><h2 className="font-semibold">Performance could not load</h2><button className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={reset}>Try again</button></div>;
}
