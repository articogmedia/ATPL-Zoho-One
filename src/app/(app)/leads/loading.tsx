export default function Loading() {
  return <div className="space-y-4" aria-label="Loading leads" role="status">
    <div className="h-8 w-48 animate-pulse rounded bg-secondary" />
    <div className="h-10 animate-pulse rounded bg-secondary" />
    <div className="hidden h-96 animate-pulse rounded-xl bg-secondary md:block" />
    <div className="space-y-2 md:hidden"><div className="h-28 animate-pulse rounded-xl bg-secondary" /><div className="h-28 animate-pulse rounded-xl bg-secondary" /></div>
  </div>;
}
