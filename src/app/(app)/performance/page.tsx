import Link from "next/link";
import { Suspense } from "react";
import { requireSection } from "@/lib/auth/guard";
import type { PerfRange } from "@/lib/domain";
import { PageHeader } from "@/components/ui-bits";
import { beginPagePerf, endPagePerf } from "@/lib/page-perf";
import { PerformanceKpis, PerformanceSectionSkeleton, PerformanceSourceChart, ExecutivePerformanceTable } from "./PerformanceSections";
import { z } from "zod";

export const metadata = { title: "Performance" };
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

const RANGES: { id: PerfRange; label: string }[] = [
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "lastMonth", label: "Last Month" },
];

export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const perf = beginPagePerf("performance");
  const viewer = await requireSection("performance");
  const { range: raw, from: rawFrom, to: rawTo } = await searchParams;
  const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) =>
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  );
  const hasCustomRange = rawFrom !== undefined || rawTo !== undefined;
  const validFrom = rawFrom ? dateSchema.safeParse(rawFrom).success : false;
  const validTo = rawTo ? dateSchema.safeParse(rawTo).success : false;
  const customRange = validFrom && validTo && rawFrom! <= rawTo! ? { from: rawFrom!, to: rawTo! } : undefined;
  const invalidCustomRange = hasCustomRange && !customRange;
  const range: PerfRange = RANGES.some((item) => item.id === raw) ? (raw as PerfRange) : "month";
  endPagePerf(perf);

  const sectionProps = { viewer, range, customRange };
  return (
    <div className="space-y-5">
      <PageHeader title={viewer.role === "Sales Executive" ? "My Performance" : "Performance"} />
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((item) => (
          <Link key={item.id} href={`/performance?range=${item.id}`} scroll={false}
            className={`inline-flex h-11 items-center rounded-lg px-4 text-sm font-semibold transition-colors ${range === item.id ? "bg-primary text-primary-foreground" : "border bg-card hover:bg-secondary"}`}>
            {item.label}
          </Link>
        ))}
      </div>
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">From<input aria-label="Custom range from" className="h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground" type="date" name="from" defaultValue={customRange?.from ?? ""} /></label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">To<input aria-label="Custom range to" className="h-11 rounded-md border border-input bg-background px-2 text-sm text-foreground" type="date" name="to" defaultValue={customRange?.to ?? ""} /></label>
        <button className="h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground" type="submit">Apply date range</button>
        {customRange && <Link className="inline-flex h-11 items-center px-2 text-sm underline" href="/performance">Clear dates</Link>}
      </form>
      {invalidCustomRange && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Enter a valid start and end date; the start date must not be after the end date.</p>}

      <Suspense fallback={<PerformanceSectionSkeleton label="performance KPIs" lines={4} />}>
        <PerformanceKpis {...sectionProps} />
      </Suspense>
      <Suspense fallback={<PerformanceSectionSkeleton label="leads by source" lines={5} />}>
        <PerformanceSourceChart {...sectionProps} />
      </Suspense>
      {viewer.role === "Manager" && <Suspense fallback={<PerformanceSectionSkeleton label="executive performance" lines={6} />}>
        <ExecutivePerformanceTable {...sectionProps} />
      </Suspense>}
    </div>
  );
}
