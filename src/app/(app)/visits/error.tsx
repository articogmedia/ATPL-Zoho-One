"use client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const digest = error.digest;
  return <div className="rounded-xl border bg-card p-6 text-center"><h2 className="font-semibold">Visits could not load</h2><p className="mt-2 text-sm text-muted-foreground">Please try again. Scheduled work is unchanged.</p>{digest ? <p className="mt-2 text-xs text-muted-foreground">Reference: {digest}</p> : null}<button className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={reset}>Try again</button></div>;
}
