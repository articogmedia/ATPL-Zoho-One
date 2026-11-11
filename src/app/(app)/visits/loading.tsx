
import { CalendarClock, ClipboardList, MapPin } from "lucide-react";

export default function Loading() {
  return (
    <main
      className="mx-auto w-full max-w-[1600px] space-y-6 p-4 sm:p-6"
      aria-label="Loading site visits"
      aria-busy="true"
    >
      <header className="flex items-center gap-3">
        <div className="rounded-xl bg-primary/10 p-3">
          <CalendarClock className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-2">
          <div className="h-6 w-52 animate-pulse rounded bg-muted" />
          <div className="h-4 w-64 animate-pulse rounded bg-muted" />
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {["Tasks", "Upcoming Visits", "Completed"].map((item) => (
          <div key={item} className="rounded-xl border bg-card p-5">
            <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            <div className="mt-4 h-8 w-12 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-semibold">Your assigned work</h2>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((item) => (
            <article
              key={item}
              className="space-y-4 rounded-xl border bg-card p-5"
            >
              <div className="flex justify-between">
                <div className="h-5 w-36 animate-pulse rounded bg-muted" />
                <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
              </div>

              <div className="h-4 w-24 animate-pulse rounded bg-muted" />

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                </div>
              </div>

              <div className="h-10 w-full animate-pulse rounded-lg bg-muted" />
            </article>
          ))}
        </div>
      </section>

      <p className="text-center text-sm text-muted-foreground">
        Connecting to your work records…
      </p>
    </main>
  );
}
