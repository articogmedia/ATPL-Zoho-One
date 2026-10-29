"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CalendarClock, CheckCircle2, FileText, MapPin, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { updateVisitAction } from "@/app/actions/crm";
import { workForTab, type User, type Visit, type WorkTab } from "@/lib/domain";

const TABS: { id: WorkTab; label: string }[] = [
  { id: "assigned", label: "Assigned" },
  { id: "progress", label: "In Progress" },
  { id: "upcoming", label: "Upcoming Visits" },
  { id: "completed", label: "Completed" },
];

export function VisitsClient({ user, visits, executives, today }: { user: User; visits: Visit[]; executives: string[]; today: string }) {
  const [tab, setTab] = useState<WorkTab>("assigned");
  const [exec, setExec] = useState("all");
  const isManager = user.role === "Manager";
  const open = [...workForTab(user, visits, "assigned", today, exec), ...workForTab(user, visits, "progress", today, exec)];
  const todays = open.filter((v) => v.isVisit && v.date === today);
  const list = workForTab(user, visits, tab, today, exec);

  return (
    <div className="space-y-6">
      {isManager && (
        <label className="flex max-w-sm flex-col gap-1 text-sm font-medium">Executive
          <select className={fieldClass} value={exec} onChange={(e) => setExec(e.target.value)}>
            <option value="all">All executives</option>
            {executives.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}

      <section className="rounded-xl border-2 border-primary bg-accent p-4">
        <h2 className="mb-3 text-lg font-semibold">Today&apos;s visits ({todays.length})</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {todays.map((v) => <Item key={v.id} v={v} showExec={isManager} />)}
          {!todays.length && <p className="text-sm text-muted-foreground">No visits today.</p>}
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <Button key={t.id} variant={tab === t.id ? "default" : "outline"} className="h-11 shrink-0" onClick={() => setTab(t.id)}>
            {t.label} ({workForTab(user, visits, t.id, today, exec).length})
          </Button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((v) => <Item key={v.id} v={v} showExec={isManager} />)}
        {!list.length && <p className="text-sm text-muted-foreground">Nothing here.</p>}
      </div>
    </div>
  );
}

function Item({ v, showExec }: { v: Visit; showExec: boolean }) {
  const [mode, setMode] = useState<"none" | "complete" | "reschedule">("none");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(v.date);
  const [time, setTime] = useState(v.time);
  const [pending, start] = useTransition();

  const send = (patch: Record<string, string>, ok: string) => start(async () => {
    const res = await updateVisitAction({ id: v.id, ...patch });
    if (res.ok) { toast.success(ok); setMode("none"); } else toast.error(res.error);
  });
  const quote = v.leadId ? { pathname: "/quotations", query: { lead: v.leadId } } : "/quotations";

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm">
      <div className="flex justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">{v.customer}</div>
          <div className="flex items-start gap-1 text-sm text-muted-foreground"><MapPin className="mt-0.5 h-4 w-4 shrink-0" />{[v.address, v.area].filter(Boolean).join(", ") || "No address"}</div>
        </div>
        <StatusBadge status={v.status} />
      </div>
      <div className="text-sm">
        <div><b>{v.type}</b> · {v.date} at {v.time}{showExec && ` · ${v.executive}`}</div>
        {(v.nextAction || v.followUp) && <div className="text-muted-foreground">Next: {v.nextAction}{v.followUp && ` (follow-up ${v.followUp})`}</div>}
        {v.notes && <div className="mt-1 italic">Notes: {v.notes}</div>}
      </div>

      {mode === "complete" && (
        <div className="space-y-2">
          <textarea className={`${fieldClass} h-20 py-2`} placeholder="Visit notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          <Button className="h-11 w-full" disabled={pending} onClick={() => send({ status: "Completed", ...(notes.trim() ? { notes: notes.trim() } : {}) }, "Visit marked completed")}>Save as completed</Button>
        </div>
      )}
      {mode === "reschedule" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input type="date" aria-label="New date" className={fieldClass} value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" aria-label="New time" className={fieldClass} value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <Button className="h-11 w-full" disabled={pending || !date || !time} onClick={() => send({ date, time }, "Rescheduled")}>Save new time</Button>
        </div>
      )}

      {v.status !== "Completed" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-11" disabled={pending || v.status === "In Progress"} onClick={() => send({ status: "In Progress" }, "Work started")}><Play className="h-4 w-4" />Start Work</Button>
          <Button variant="outline" className="h-11" onClick={() => setMode(mode === "complete" ? "none" : "complete")}><CheckCircle2 className="h-4 w-4" />Mark Completed</Button>
          <Button variant="outline" className="h-11" onClick={() => setMode(mode === "reschedule" ? "none" : "reschedule")}><CalendarClock className="h-4 w-4" />Reschedule</Button>
          <Button asChild className="h-11"><Link href={quote}><FileText className="h-4 w-4" />Quotation</Link></Button>
        </div>
      ) : (
        <Button asChild variant="outline" className="h-11"><Link href={quote}><FileText className="h-4 w-4" />Create Quotation</Link></Button>
      )}
    </div>
  );
}
