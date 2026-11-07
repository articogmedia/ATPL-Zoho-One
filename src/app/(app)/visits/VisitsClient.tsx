"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CalendarClock, CalendarDays, CheckCircle2, ClipboardList, FileText, LoaderCircle, MapPin, Phone, Play, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { fieldClass } from "@/components/ui-bits";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { getAssignableUsersAction, updateVisitAction } from "@/app/actions/crm";
import { normalizePhone, workForTab, type User, type Visit, type WorkTab } from "@/lib/domain";
import type { PerfRange } from "@/lib/domain";

const CallLeadModal = dynamic(
  () => import("@/components/leads/call-lead-modal").then((module) => module.CallLeadModal),
  { ssr: false },
);

type VisitPatch = Partial<Pick<Visit, "status" | "date" | "time" | "followUp" | "notes">>;

const TABS: { id: WorkTab; label: string; empty: string }[] = [
  { id: "assigned", label: "Tasks", empty: "No assigned tasks right now. New work will appear here." },
  { id: "progress", label: "In Progress", empty: "Nothing is in progress. Start an assigned task when you’re ready." },
  { id: "upcoming", label: "Upcoming Visits", empty: "No upcoming visits. Scheduled visits will appear here." },
  { id: "completed", label: "Completed", empty: "No completed work yet. Finished tasks will appear here." },
];

type Summary = { leads: number; calls: number; visits: number; quotes: number; won: number; conversion: number };

function dateAfter(date: string, days: number) {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

function displayDate(date: string) {
  if (!date) return "Not set";
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function VisitsClient({ user, visits, executives, executivesUnavailable: initiallyUnavailable = false, today, performance, callWarning, visitsWarning }: {
  user: User;
  visits: Visit[];
  executives: string[];
  executivesUnavailable?: boolean;
  today: string;
  performance?: { week: Summary; month: Summary };
  callWarning?: string;
  visitsWarning?: string;
}) {
  const [tab, setTab] = useState<WorkTab>("assigned");
  const [exec, setExec] = useState("all");
  const [executiveNames, setExecutiveNames] = useState(executives);
  const [executivesUnavailable, setExecutivesUnavailable] = useState(initiallyUnavailable);
  const [loadingExecutives, setLoadingExecutives] = useState(false);
  const [visitRows, setVisitRows] = useState(visits);
  const visitRowsRef = useRef(visitRows);
  const tabRef = useRef(tab);
  visitRowsRef.current = visitRows;
  tabRef.current = tab;
  const [range, setRange] = useState<PerfRange>("week");
  const isManager = user.role === "Manager";
  const summary = performance?.[range === "week" ? "week" : "month"];

  const reloadExecutives = async () => {
    if (loadingExecutives) return;
    setLoadingExecutives(true);
    try {
      const result = await getAssignableUsersAction();
      if (!result.ok || !result.data?.length) {
        setExecutivesUnavailable(true);
        toast.error(result.ok ? "No active team members were returned." : result.error);
        return;
      }
      setExecutiveNames(result.data.map((member) => member.name));
      setExecutivesUnavailable(false);
    } finally {
      setLoadingExecutives(false);
    }
  };

  const applyOptimisticUpdate = useCallback((id: string, patch: VisitPatch) => {
    const previous = visitRowsRef.current.find((visit) => visit.id === id);
    if (!previous) return () => {};
    setVisitRows((current) => current.map((visit) => visit.id === id
      ? { ...visit, ...patch, done: patch.status === "Completed" || (patch.status === undefined && visit.done) }
      : visit));
    let nextTab: WorkTab | undefined;
    if (patch.status === "In Progress") nextTab = "progress";
    else if (patch.status === "Completed") nextTab = "completed";
    else if (patch.date && previous.isVisit && previous.status !== "Completed" && patch.date >= today) nextTab = "upcoming";
    const previousTab = tabRef.current;
    if (nextTab) setTab(nextTab);
    return () => {
      setVisitRows((current) => current.map((visit) => visit.id === id ? previous : visit));
      if (nextTab) setTab(previousTab);
    };
  }, [today]);

  const workByTab = useMemo(
    () => Object.fromEntries(TABS.map(({ id }) => [id, workForTab(user, visitRows, id, today, exec)])) as Record<WorkTab, Visit[]>,
    [user, visitRows, today, exec],
  );
  const open = useMemo(() => [...workByTab.assigned, ...workByTab.progress], [workByTab]);
  const todays = useMemo(() => open.filter((visit) => visit.isVisit && visit.date === today), [open, today]);
  const list = workByTab[tab];
  const activeTab = TABS.find((item) => item.id === tab)!;

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <div>
        <h1 className="min-w-0 text-xl font-bold sm:text-2xl">My Work &amp; Site Visits</h1>
      </div>
      {callWarning && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{callWarning}</div>}
      {visitsWarning && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Zoho task data warning: {visitsWarning}</div>}
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
        <div className="max-w-sm">
          <label className="flex flex-col gap-1 text-sm font-medium">Executive
            <SelectField value={exec} onValueChange={setExec} options={[{ value: "all", label: "All executives" }, ...executiveNames.map((name) => ({ value: name, label: name }))]} />
          </label>
          {executivesUnavailable && <Button type="button" variant="outline" className="mt-2 h-11" disabled={loadingExecutives} onClick={() => void reloadExecutives()}>{loadingExecutives ? <><LoaderCircle className="h-4 w-4 animate-spin" />Retrying…</> : "Retry loading team members"}</Button>}
        </div>
      )}

      <section className="min-w-0 rounded-xl border border-primary/30 bg-accent p-3 shadow-sm sm:p-4">
        <h2 className="mb-3 text-lg font-semibold">Today&apos;s visits ({todays.length})</h2>
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
          {todays.map((visit) => <Item key={`today-${visit.id}`} v={visit} today={today} onOptimisticChange={applyOptimisticUpdate} />)}
          {!todays.length && <p className="text-sm text-muted-foreground">No visits today.</p>}
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <Button key={item.id} variant={tab === item.id ? "default" : "outline"} className="h-11" onClick={() => setTab(item.id)}>
            {item.label} ({workByTab[item.id].length})
          </Button>
        ))}
      </div>

      <div id="work-list" className="grid min-w-0 grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((visit) => <Item key={visit.id} v={visit} today={today} onOptimisticChange={applyOptimisticUpdate} />)}
        {!list.length && <p className="col-span-full rounded-xl border border-dashed bg-card px-4 py-8 text-center text-sm text-muted-foreground">{activeTab.empty}</p>}
      </div>
    </div>
  );
}

const Item = memo(function Item({ v, today, onOptimisticChange }: {
  v: Visit;
  today: string;
  onOptimisticChange: (id: string, patch: VisitPatch) => () => void;
}) {
  const [mode, setMode] = useState<"none" | "complete" | "reschedule">("none");
  const [callOpen, setCallOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(v.date);
  const [time, setTime] = useState(v.time);
  const [followUp, setFollowUp] = useState(v.followUp);
  const [rescheduleNote, setRescheduleNote] = useState("");
  const [savingAction, setSavingAction] = useState<"start" | "complete" | "reschedule" | null>(null);
  const phone = normalizePhone(v.phone ?? "");
  const whatsappHref = phone.length === 10
    ? `https://wa.me/91${phone}?text=${encodeURIComponent(`Hi ${v.customer}, following up on your ${v.type.toLowerCase()}.`)}`
    : undefined;
  const linkedLeadId = String(v.leadId ?? "").trim();
  const quote = linkedLeadId ? { pathname: "/quotations", query: { lead: linkedLeadId } } : null;
  const dateIsValid = Boolean(date && date >= today);

  const send = async (patch: VisitPatch, ok: string, action: "start" | "complete" | "reschedule") => {
    if (savingAction) return;
    setSavingAction(action);
    const rollback = onOptimisticChange(v.id, patch);
    try {
      const result = await updateVisitAction({ id: v.id, ...patch });
      if (!result.ok) {
        rollback();
        toast.error(result.error);
        return;
      }
      toast.success(ok);
      setMode("none");
    } catch (error) {
      rollback();
      toast.error(error instanceof Error ? error.message : "Could not update this task.");
    } finally {
      setSavingAction(null);
    }
  };

  const openReschedule = () => {
    setDate(v.date);
    setTime(v.time);
    setFollowUp(v.followUp);
    setRescheduleNote("");
    setMode("reschedule");
  };
  const saveReschedule = () => {
    if (!dateIsValid || !time || savingAction) return;
    const patch: VisitPatch = {
      date,
      time,
      ...(followUp ? { followUp } : {}),
      ...(rescheduleNote.trim() ? { notes: rescheduleNote.trim() } : {}),
    };
    void send(patch, `Rescheduled to ${displayDate(date)} ${time}`, "reschedule");
  };

  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 break-words font-bold leading-snug">{v.customer}</h3>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {v.date < today && v.status !== "Completed" && <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">Overdue</span>}
          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
            v.status === "Completed" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : v.status === "In Progress" ? "border-blue-200 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-slate-100 text-slate-700"
          }`}>{v.status}</span>
        </div>
      </div>

      <p className="break-words text-sm font-semibold text-foreground/90">{v.type}</p>

      <div className="grid gap-2 text-sm text-muted-foreground">
        <InfoLine icon={CalendarDays}>{displayDate(v.date)}{v.time ? ` · ${v.time}` : ""}</InfoLine>
        <InfoLine icon={UserRound}>{v.executive || "Unassigned"}</InfoLine>
        {v.nextAction && <InfoLine icon={ClipboardList}>{v.nextAction}</InfoLine>}
        {v.followUp && <InfoLine icon={CalendarClock}>Follow-up {displayDate(v.followUp)}</InfoLine>}
        {(v.address || v.area) && <InfoLine icon={MapPin}>{[v.address, v.area].filter(Boolean).join(", ")}</InfoLine>}
        {v.notes && <p className="break-words pl-6 text-xs italic text-muted-foreground/80">{v.notes}</p>}
      </div>

      {v.status === "Assigned" && (
        <Button type="button" className="mt-auto h-11 w-full" disabled={savingAction !== null} onClick={() => void send({ status: "In Progress" }, "Moved to In Progress", "start")}>
          {savingAction === "start" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {savingAction === "start" ? "Starting…" : "Start Work"}
        </Button>
      )}
      {v.status === "In Progress" && (
        <Button type="button" className="mt-auto h-11 w-full" disabled={savingAction !== null} onClick={() => setMode("complete")}>
          {savingAction === "complete" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Mark Completed
        </Button>
      )}

      <div className="grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-4">
        <Button type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] sm:flex-row sm:gap-1 sm:text-xs" disabled={!v.phone || savingAction !== null} onClick={() => setCallOpen(true)} aria-label="Call">
          <Phone className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">Call</span>
        </Button>
        {whatsappHref
          ? <Button asChild type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] text-[#087443] hover:bg-[#25D366]/10 sm:flex-row sm:gap-1 sm:text-xs">
            <a href={whatsappHref} target="_blank" rel="noreferrer" aria-label="WhatsApp" title="WhatsApp"><WhatsAppIcon className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">WhatsApp</span></a>
          </Button>
          : <Button type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] sm:flex-row sm:gap-1 sm:text-xs" disabled aria-label="WhatsApp unavailable" title="No mobile number on this lead">
            <WhatsAppIcon className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">WhatsApp</span>
          </Button>}
        {quote
          ? <Button asChild type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] sm:flex-row sm:gap-1 sm:text-xs">
            <Link href={quote}><FileText className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">Quotation</span></Link>
          </Button>
          : <Button type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] sm:flex-row sm:gap-1 sm:text-xs" disabled title="No customer linked to this task">
            <FileText className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">Quotation</span>
          </Button>}
        <Button type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] sm:flex-row sm:gap-1 sm:text-xs" disabled={savingAction !== null || v.status === "Completed"} onClick={openReschedule}>
          {savingAction === "reschedule" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4 shrink-0" />}<span className="min-w-0 truncate">Reschedule</span>
        </Button>
      </div>

      {mode === "complete" && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingAction) setMode("none"); }}>
          <section role="dialog" aria-modal="true" aria-labelledby={`complete-title-${v.id}`} className="w-full max-w-md space-y-3 rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:pb-5">
            <h3 id={`complete-title-${v.id}`} className="font-semibold">Mark this task completed?</h3>
            <p className="text-sm text-muted-foreground">Confirm completion for {v.customer}.</p>
            <textarea aria-label="Completion notes" className={`${fieldClass} min-h-20 py-2`} placeholder="Visit notes (optional)" value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={savingAction !== null} onClick={() => setMode("none")}>Cancel</Button>
              <Button type="button" className="h-11" disabled={savingAction !== null} onClick={() => void send({ status: "Completed", ...(notes.trim() ? { notes: notes.trim() } : {}) }, "Moved to Completed", "complete")}>
                {savingAction === "complete" && <LoaderCircle className="h-4 w-4 animate-spin" />}Confirm completed
              </Button>
            </div>
          </section>
        </div>
      )}
      {mode === "reschedule" && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingAction) setMode("none"); }}>
          <section role="dialog" aria-modal="true" aria-labelledby={`reschedule-title-${v.id}`} className="max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:pb-5">
            <div>
              <h3 id={`reschedule-title-${v.id}`} className="font-semibold">Reschedule task</h3>
              <p className="mt-1 text-sm text-muted-foreground">{v.customer}</p>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Quick date choices">
              {[["Today", 0], ["Tomorrow", 1], ["Next week", 7]].map(([label, offset]) => {
                const quickDate = dateAfter(today, Number(offset));
                return <Button key={label} type="button" variant={date === quickDate ? "default" : "outline"} className="h-10" disabled={savingAction !== null} onClick={() => setDate(quickDate)}>{label}</Button>;
              })}
            </div>
            <label className="block text-sm font-medium">New date
              <input type="date" aria-label="New date" min={today} className={`${fieldClass} mt-1`} value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            {date && !dateIsValid && <p role="alert" className="text-sm text-destructive">Choose today or a future date.</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="block min-w-0 text-sm font-medium">New time
                <input type="time" aria-label="New time" className={`${fieldClass} mt-1 min-w-0`} value={time} onChange={(event) => setTime(event.target.value)} />
              </label>
              <label className="block min-w-0 text-sm font-medium">Follow-up date
                <input type="date" aria-label="Follow-up date" min={today} className={`${fieldClass} mt-1 min-w-0`} value={followUp} onChange={(event) => setFollowUp(event.target.value)} />
              </label>
            </div>
            <label className="block text-sm font-medium">Reason / notes <span className="font-normal text-muted-foreground">(optional)</span>
              <textarea aria-label="Reason or notes" className={`${fieldClass} mt-1 min-h-20 py-2`} placeholder="Add context for the schedule change" value={rescheduleNote} maxLength={1000} onChange={(event) => setRescheduleNote(event.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={savingAction !== null} onClick={() => setMode("none")}>Cancel</Button>
              <Button type="button" className="h-11" disabled={savingAction !== null || !dateIsValid || !time} onClick={saveReschedule}>
                {savingAction === "reschedule" && <LoaderCircle className="h-4 w-4 animate-spin" />}Save new date
              </Button>
            </div>
          </section>
        </div>
      )}

      {callOpen && <CallLeadModal lead={{ id: v.leadId, name: v.customer, phone: v.phone ?? "" }} onClose={() => setCallOpen(false)} onSaved={() => setCallOpen(false)} />}
    </article>
  );
});

function InfoLine({ icon: Icon, children }: { icon: typeof CalendarDays; children: ReactNode }) {
  return <div className="flex min-w-0 items-start gap-2"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/75" /><span className="min-w-0 break-words">{children}</span></div>;
}
