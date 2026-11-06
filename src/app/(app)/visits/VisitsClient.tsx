"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, FileText, LoaderCircle, MapPin, Phone, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { CallLeadModal } from "@/components/leads/call-lead-modal";
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
    <div className="min-w-0 max-w-full space-y-6">
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

      <section className="min-w-0 rounded-xl border border-primary/30 bg-accent p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Today&apos;s visits ({todays.length})</h2>
        <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 xl:grid-cols-3">
          {todays.map((v) => <Item key={v.id} v={v} showExec={isManager} today={today} onStatusChanged={onStatusChanged} onCallSaved={() => router.refresh()} />)}
          {!todays.length && <p className="text-sm text-muted-foreground">No visits today.</p>}
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button key={t.id} variant={tab === t.id ? "default" : "outline"} className="h-11" onClick={() => setTab(t.id)}>
            {t.label} ({workByTab[t.id].length})
          </Button>
        ))}
      </div>

      <div id="work-list" className="grid min-w-0 grid-cols-1 items-stretch gap-6 md:grid-cols-2 xl:grid-cols-3">
        {list.map((v) => <Item key={v.id} v={v} showExec={isManager} today={today} onStatusChanged={onStatusChanged} onCallSaved={() => router.refresh()} />)}
        {!list.length && <p className="text-sm text-muted-foreground">Nothing here.</p>}
      </div>
    </div>
  );
}

function Item({ v, showExec, today, onStatusChanged, onCallSaved }: { v: Visit; showExec: boolean; today: string; onStatusChanged: (status: "In Progress" | "Completed") => void; onCallSaved: () => void }) {
  const [mode, setMode] = useState<"none" | "complete" | "reschedule">("none");
  const [callOpen, setCallOpen] = useState(false);
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
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="min-w-0 break-words font-semibold">{v.customer}</div>
      <div className="flex w-fit max-w-full flex-wrap items-center gap-1">
        {v.date < today && v.status !== "Completed" && <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">Overdue</span>}
        <StatusBadge status={v.status} />
      </div>
      <div className="min-w-0 break-words font-medium">{v.type}</div>
      <div className="min-w-0 break-words text-sm text-muted-foreground">
        <div>{v.date}{v.time ? ` · ${v.time}` : ""}{showExec && ` · ${v.executive}`}</div>
        {(v.address || v.area) && <div className="mt-1 flex min-w-0 items-start gap-1"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{[v.address, v.area].filter(Boolean).join(", ")}</span></div>}
        {v.nextAction && <div className="mt-1 break-words">Next: {v.nextAction}</div>}
        {v.followUp && <div className="mt-1 break-words">Follow-up: {v.followUp}</div>}
        {v.notes && <div className="mt-1 break-words italic">Notes: {v.notes}</div>}
      </div>

      {mode === "complete" && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingAction) setMode("none"); }}>
          <section role="dialog" aria-modal="true" aria-labelledby={`complete-title-${v.id}`} className="w-full max-w-md space-y-3 rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:pb-5">
            <h3 id={`complete-title-${v.id}`} className="font-semibold">Mark this task completed?</h3>
            <p className="text-sm text-muted-foreground">Confirm completion for {v.customer}.</p>
            <textarea aria-label="Completion notes" className={`${fieldClass} min-h-20 py-2`} placeholder="Visit notes (optional)" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={savingAction !== null} onClick={() => setMode("none")}>Cancel</Button>
              <Button type="button" className="h-11" disabled={savingAction !== null} onClick={() => void send({ status: "Completed", ...(notes.trim() ? { notes: notes.trim() } : {}) }, "Moved to Completed", "complete", "Completed")}>
                {savingAction === "complete" && <LoaderCircle className="h-[18px] w-[18px] animate-spin" />}Confirm completed
              </Button>
            </div>
          </section>
        </div>
      )}
      {mode === "reschedule" && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingAction) setMode("none"); }}>
          <section role="dialog" aria-modal="true" aria-labelledby={`reschedule-title-${v.id}`} className="w-full max-w-md space-y-3 rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:pb-5">
            <h3 id={`reschedule-title-${v.id}`} className="font-semibold">Reschedule task</h3>
            <label className="block text-sm font-medium">Visit date<input type="date" aria-label="New date" className={`${fieldClass} mt-1`} value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block min-w-0 text-sm font-medium">Time<input type="time" aria-label="New time" className={`${fieldClass} mt-1 min-w-0`} value={time} onChange={(e) => setTime(e.target.value)} /></label>
              <label className="block min-w-0 text-sm font-medium">Follow-up date<input type="date" aria-label="Follow-up date" className={`${fieldClass} mt-1 min-w-0`} value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></label>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={savingAction !== null} onClick={() => setMode("none")}>Cancel</Button>
              <Button type="button" className="h-11" disabled={savingAction !== null || !date || !time} onClick={() => void send({ date, time, followUp }, "Rescheduled", "reschedule")}>
                {savingAction === "reschedule" && <LoaderCircle className="h-[18px] w-[18px] animate-spin" />}Save new date
              </Button>
            </div>
          </section>
        </div>
      )}

      {callOpen && <CallLeadModal lead={{ id: v.leadId, name: v.customer, phone: v.phone ?? "" }} onClose={() => setCallOpen(false)} onSaved={() => {
        setCallOpen(false);
        onCallSaved();
      }} />}
      {v.phone && <Button type="button" variant="outline" className="h-11 w-full" onClick={() => setCallOpen(true)}><Phone className="h-4 w-4" />Call lead</Button>}

      {quote
        ? <Button asChild className="h-11 w-full min-w-0 whitespace-normal"><Link href={quote}><FileText className="h-4 w-4" />Quotation</Link></Button>
        : <Button className="h-11 w-full min-w-0 whitespace-normal" disabled title="No customer linked to this task"><FileText className="h-4 w-4" />Quotation</Button>}
      {v.status !== "Completed" && <div className="mt-auto grid w-full min-w-0 grid-cols-3 gap-2">
        <Button type="button" variant="outline" className="flex h-16 min-w-0 flex-col items-center justify-center gap-1 whitespace-normal rounded-xl border px-2 text-center text-xs font-medium leading-tight transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" title={v.status === "In Progress" ? "Work is already in progress" : undefined} disabled={savingAction !== null || v.status === "In Progress"} onClick={() => void send({ status: "In Progress" }, "Moved to In Progress", "start", "In Progress")}>
            {savingAction === "start" ? <LoaderCircle className="!size-[18px] animate-spin" /> : <Play className="!size-[18px]" />}<span>Start Work</span>
          </Button>
        <Button type="button" variant="outline" className="flex h-16 min-w-0 flex-col items-center justify-center gap-1 whitespace-normal rounded-xl border px-2 text-center text-xs font-medium leading-tight transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" disabled={savingAction !== null} onClick={() => setMode(mode === "complete" ? "none" : "complete")}><CheckCircle2 className="!size-[18px]" /><span>Mark<br />Completed</span>
        </Button>
        <Button type="button" variant="outline" className="flex h-16 min-w-0 flex-col items-center justify-center gap-1 whitespace-normal rounded-xl border px-2 text-center text-xs font-medium leading-tight transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed" disabled={savingAction !== null} onClick={() => setMode(mode === "reschedule" ? "none" : "reschedule")}>
          {savingAction === "reschedule" ? <LoaderCircle className="!size-[18px] animate-spin" /> : <CalendarClock className="!size-[18px]" />}<span>Reschedule</span>
        </Button>
      </div>}
    </article>
  );
}
