export function RouteLoading({ title, cards = 3 }: { title: string; cards?: number }) {
  return (
    <div className="space-y-5" aria-label={`Loading ${title}`}>
      <div className="h-8 w-56 animate-pulse rounded-lg bg-secondary" />
      <div className="h-11 w-full animate-pulse rounded-xl bg-card" />
      <div className={`grid gap-3 ${cards > 1 ? "sm:grid-cols-2" : ""}`}>
        {Array.from({ length: cards }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl bg-card shadow-sm" />)}
      </div>
    </div>
  );
}
