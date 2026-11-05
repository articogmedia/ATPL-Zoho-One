"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, FileText, LoaderCircle, MapPin, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { updateVisitAction } from "@/app/actions/crm";
import { workForTab, type User, type Visit, type WorkTab } from "@/lib/domain";
import type { PerfRange } from "@/lib/domain";

const TABS: { id: WorkTab; label: string }[] = [
  { id: "assigned", label: "Tasks" },
  { id: "progress", label: "In Progress" },
  { id: "upcoming", label: "Upcoming Visits" },
  { id: "completed", label: "Completed" },
];

type Summary = { leads: number; calls: number; visits: number; quotes: number; won: number; conversion: number };
export function VisitsClient({ user, visits, executives, today, performance, callWarning }: { user: User; visits: Visit[]; executives: string[]; today: string; performance?: { week: Summary; month: Summary }; callWarning?: string }) {
  const [tab, setTab] = useState<WorkTab>("assigned");
  const [exec, setExec] = useState("all");
  const router = useRouter();
  const onStatusChanged = (status: "In Progress" | "Completed") => {
    setTab(status === "In Progress" ? "progress" : "completed");
    router.refresh();
  };
  const isManager = user.role === "Manager";
  const workByTab = useMemo(
    () => Object.fromEntries(TABS.map(({ id }) => [id, workForTab(user, visits, id, today, exec)])) as Record<WorkTab, Visit[]>,
    [user, visits, today, exec],
  );
  const open = [...workByTab.assigned, ...workByTab.progress];
  const todays = open.filter((v) => v.isVisit && v.date === today);
  const list = workByTab[tab];
  const [range, setRange] = useState<PerfRange>("week");
  const summary = performance?.[range === "week" ? "week" : "month"];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="min-w-0 text-xl font-bold sm:text-2xl">My Work &amp; Site Visits</h1>
      </div>
      {callWarning && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{callWarning}</div>}
      {performance && summary && <section aria-label="My Performance" className="rounded-xl border bg-card p-3 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold">My Performance</h2>
          <div className="flex gap-1" role="group" aria-label="Performance period">
            <Button size="sm" variant={range === "week" ? "default" : "outline"} onClick={() => setRange("week")}>This Week</Button>
            <Button size="sm" variant={range === "month" ? "default" : "outline"} onClick={() => setRange("month")}>This Month</Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            ["Leads Assigned", summary.leads], ["Calls Made", summary.calls], ["Visits Completed", summary.visits],
            ["Quotations Sent", summary.quotes], ["Won", summary.won], ["Conversion %", `${summary.conversion}%`],
          ].map(([label, value]) => <div key={String(label)} className="rounded-lg bg-secondary p-2.5"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-bold">{value}</div></div>)}
        </div>
      </section>}
      {isManager && (
        <label className="flex max-w-sm flex-col gap-1 text-sm font-medium">Executive
          <SelectField value={exec} onValueChange={setExec} options={[{ value: "all", label: "All executives" }, ...executives.map((name) => ({ value: name, label: name }))]} />
        </label>
      )}

      <section className="rounded-xl border border-primary/30 bg-accent p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Today&apos;s visits ({todays.length})</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {todays.map((v) => <Item key={v.id} v={v} showExec={isManager} today={today} onStatusChanged={onStatusChanged} />)}
          {!todays.length && <p className="text-sm text-muted-foreground">No visits today.</p>}
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <Button key={t.id} variant={tab === t.id ? "default" : "outline"} className="h-11 shrink-0" onClick={() => setTab(t.id)}>
            {t.label} ({workByTab[t.id].length})
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((v) => <Item key={v.id} v={v} showExec={isManager} today={today} onStatusChanged={onStatusChanged} />)}
        {!list.length && <p className="text-sm text-muted-foreground">Nothing here.</p>}
      </div>
    </div>
  );
}

function Item({ v, showExec, today, onStatusChanged }: { v: Visit; showExec: boolean; today: string; onStatusChanged: (status: "In Progress" | "Completed") => void }) {
  const [mode, setMode] = useState<"none" | "complete" | "reschedule">("none");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(v.date);
  const [time, setTime] = useState(v.time);
  const [followUp, setFollowUp] = useState(v.followUp);
  const [savingAction, setSavingAction] = useState<"start" | "complete" | "reschedule" | null>(null);

  const send = async (patch: Record<string, string>, ok: string, action: "start" | "complete" | "reschedule", changedStatus?: "In Progress" | "Completed") => {
    if (savingAction) return;
    setSavingAction(action);
    try {
      const res = await updateVisitAction({ id: v.id, ...patch });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(ok);
      if (changedStatus) onStatusChanged(changedStatus);
      setMode("none");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update this task.");
    } finally {
      setSavingAction(null);
    }
  };
  const linkedLeadId = String(v.leadId ?? "").trim();
  const quote = linkedLeadId ? { pathname: "/quotations", query: { lead: linkedLeadId } } : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="min-w-0">
        <div className="min-w-0">
          <div className="truncate font-semibold">{v.customer}</div>
          {(v.address || v.area) && <div className="flex items-start gap-1 text-sm text-muted-foreground"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /><span className="truncate">{[v.address, v.area].filter(Boolean).join(", ")}</span></div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {v.date < today && v.status !== "Completed" && <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">Overdue</span>}
        <StatusBadge status={v.status} />
      </div>
      <div className="space-y-0.5 text-sm">
        <div className="font-medium">{v.type}</div>
        <div className="text-muted-foreground">{v.date}{v.time ? ` · ${v.time}` : ""}{showExec && ` · ${v.executive}`}</div>
        {(v.nextAction || v.followUp) && <div className="text-muted-foreground">Next: {v.nextAction}{v.followUp && ` (follow-up ${v.followUp})`}</div>}
        {v.notes && <div className="mt-1 italic">Notes: {v.notes}</div>}
      </div>

      {mode === "complete" && (
        <div className="space-y-2">
          <textarea className={`${fieldClass} h-20 py-2`} placeholder="Visit notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          <Button variant="outline" className="h-11 w-full" disabled={savingAction !== null} onClick={() => void send({ status: "Completed", ...(notes.trim() ? { notes: notes.trim() } : {}) }, "Moved to Completed", "complete", "Completed")}>
            {savingAction === "complete" && <LoaderCircle className="animate-spin" />}Save as completed
          </Button>
        </div>
      )}
      {mode === "reschedule" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input type="date" aria-label="New date" className={fieldClass} value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" aria-label="New time" className={fieldClass} value={time} onChange={(e) => setTime(e.target.value)} />
            <input type="date" aria-label="Follow-up date" className={fieldClass} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
          </div>
          <Button variant="outline" className="h-11 w-full" disabled={savingAction !== null || !date || !time} onClick={() => void send({ date, time, followUp }, "Rescheduled", "reschedule")}>
            {savingAction === "reschedule" && <LoaderCircle className="animate-spin" />}Save new time
          </Button>
        </div>
      )}

      {quote
        ? <Button asChild className="h-11 w-full"><Link href={quote}><FileText className="h-4 w-4" />Quotation</Link></Button>
        : <Button className="h-11 w-full" disabled title="No customer linked to this task"><FileText className="h-4 w-4" />Quotation</Button>}
      {v.status !== "Completed" && <div className="grid grid-cols-3 gap-2 max-[379px]:grid-cols-2">
        <span title={v.status === "In Progress" ? "Work is already in progress" : undefined}>
          <Button variant="outline" className="flex-col gap-1 px-2 py-2 text-xs" title={v.status === "In Progress" ? "Work is already in progress" : undefined} disabled={savingAction !== null || v.status === "In Progress"} onClick={() => void send({ status: "In Progress" }, "Moved to In Progress", "start", "In Progress")}>
            {savingAction === "start" ? <LoaderCircle className="animate-spin" /> : <Play className="h-4 w-4" />}Start Work
          </Button>
        </span>
        <Button variant="outline" className="flex-col gap-1 px-2 py-2 text-xs" disabled={savingAction !== null} onClick={() => setMode(mode === "complete" ? "none" : "complete")}><CheckCircle2 className="h-4 w-4" />Mark Completed</Button>
        <Button variant="outline" className="flex-col gap-1 px-2 py-2 text-xs" disabled={savingAction !== null} onClick={() => setMode(mode === "reschedule" ? "none" : "reschedule")}>
          {savingAction === "reschedule" ? <LoaderCircle className="animate-spin" /> : <CalendarClock className="h-4 w-4" />}Reschedule
        </Button>
      </div>}
    </div>
  );
}
