"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, History, Phone, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { addLeadAction, getLeadHistoryAction, saveLeadUpdateAction, scheduleVisitAction } from "@/app/actions/crm";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAssignLeads, leadsForTab, todayIST,
  type Lead, type LeadSource, type LeadStatus, type LeadTab, type LeadUpdate, type User,
} from "@/lib/domain";

type Props = { user: User; leads: Lead[]; executives: string[] };

const TABS: { id: LeadTab; label: string }[] = [
  { id: "fresh", label: "Fresh Leads to Call" },
  { id: "callback", label: "Call Back" },
  { id: "mine", label: "My Leads" },
  { id: "all", label: "All Leads" },
];

export function LeadsClient({ user, leads, executives }: Props) {
  const isExec = user.role === "Sales Executive";
  const [tab, setTab] = useState<LeadTab>(isExec ? "mine" : "fresh");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<LeadSource | "All">("All");
  const [adding, setAdding] = useState(false);
  const rows = leadsForTab(user, leads, tab, search, source);
  const count = (t: LeadTab) => leadsForTab(user, leads, t).length;

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold ${tab === t.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground"}`}>
            {t.label} <span className="opacity-75">({count(t.id)})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
          <input className={`${fieldClass} pl-10`} placeholder="Search name, company or mobile" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Search leads" />
        </div>
        <select aria-label="Filter by source" className={`${fieldClass} sm:w-48`} value={source}
          onChange={(e) => setSource(e.target.value as LeadSource | "All")}>
          <option value="All">All sources</option>
          {LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}
        </select>
        {!isExec && <Button className="h-12" onClick={() => setAdding((a) => !a)}><Plus className="mr-1 h-4 w-4" />Add Lead</Button>}
      </div>

      {adding && <AddLead onDone={() => setAdding(false)} />}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-muted-foreground">No leads here.</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map((l) => <LeadCard key={l.id} lead={l} user={user} executives={executives} />)}
        </div>
      )}
    </div>
  );
}

function LeadCard({ lead, user, executives }: { lead: Lead; user: User; executives: string[] }) {
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [remarks, setRemarks] = useState("");
  const [assignee, setAssignee] = useState(lead.assignedTo ?? "");
  const [history, setHistory] = useState<LeadUpdate[] | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [pending, start] = useTransition();
  const canAssign = canAssignLeads(user.role);
  const canSchedule = user.role !== "Calling Team" && !!lead.assignedTo;

  const save = () => start(async () => {
    const res = await saveLeadUpdateAction({ id: lead.id, status, remarks, ...(canAssign ? { assignedTo: assignee || null } : {}) });
    if (res.ok) { setRemarks(""); setHistory(null); toast.success(`Saved update for ${lead.name}`); } else toast.error(res.error);
  });

  const loadHistory = async (open: boolean) => {
    if (!open || history) return;
    const res = await getLeadHistoryAction(lead.id);
    if (res.ok) setHistory(res.data ?? []); else toast.error(res.error);
  };

  return (
    <article className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-bold">{lead.name}</h3>
          {lead.company && <p className="text-sm text-muted-foreground">{lead.company}</p>}
          <p className="mt-1 text-xs text-muted-foreground">{lead.source} · {lead.area || "No area"} · Created {lead.createdOn}</p>
          <p className="text-xs text-muted-foreground">Owner: <span className="font-semibold text-foreground">{lead.assignedTo ?? "Unassigned"}</span></p>
        </div>
        <StatusBadge status={lead.status} />
      </div>

      {lead.remarks && <p className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">{lead.remarks}</p>}

      <a href={`tel:${lead.phone.replace(/\s/g, "")}`} className="flex h-12 items-center justify-center gap-2 rounded-lg bg-success font-semibold text-success-foreground">
        <Phone className="h-5 w-5" /> Call {lead.phone}
      </a>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm font-medium">Update Result
          <select className={`${fieldClass} mt-1`} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)}>
            {LEAD_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        {canAssign && (
          <label className="text-sm font-medium">Assign to Sales Executive
            <select className={`${fieldClass} mt-1`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {executives.map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
        )}
      </div>
      <textarea className={`${fieldClass} h-20 py-2`} placeholder="Remarks from this call…" value={remarks}
        onChange={(e) => setRemarks(e.target.value)} aria-label="Remarks" maxLength={500} />
      <Button className="h-12 w-full" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>

      {canSchedule && (
        <>
          <Button variant="outline" className="h-11 w-full" onClick={() => setScheduling((s) => !s)}>
            <CalendarPlus className="h-4 w-4" /> Schedule site visit / work
          </Button>
          {scheduling && <ScheduleForm lead={lead} onDone={() => setScheduling(false)} />}
        </>
      )}

      <details className="text-sm" onToggle={(e) => loadHistory(e.currentTarget.open)}>
        <summary className="flex cursor-pointer items-center gap-1 font-semibold text-primary"><History className="h-4 w-4" /> History</summary>
        <ul className="mt-2 space-y-1 border-l-2 border-border pl-3">
          {history === null && <li className="text-muted-foreground">Loading…</li>}
          {history?.length === 0 && <li className="text-muted-foreground">No history yet.</li>}
          {history?.map((h, i) => (
            <li key={i}><span className="text-muted-foreground">{h.date} · {h.user}:</span> {h.note}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}

const VISIT_TYPES = ["Site survey", "Room inspection", "Demo visit", "Installation check", "Collect advance", "Follow-up call", "Prepare quotation"];

function ScheduleForm({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [f, setF] = useState({ type: VISIT_TYPES[0]!, date: todayIST(), time: "11:00", nextAction: "" });
  const [pending, start] = useTransition();
  const isVisit = !["Follow-up call", "Prepare quotation"].includes(f.type);

  const submit = () => start(async () => {
    const res = await scheduleVisitAction({ leadId: lead.id, executive: lead.assignedTo ?? undefined, isVisit, ...f });
    if (res.ok) { toast.success("Scheduled"); onDone(); } else toast.error(res.error);
  });

  return (
    <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
      <select aria-label="Type" className={fieldClass} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
        {VISIT_TYPES.map((t) => <option key={t}>{t}</option>)}
      </select>
      <input aria-label="Next action" className={fieldClass} placeholder="Next action" value={f.nextAction} maxLength={200} onChange={(e) => setF({ ...f, nextAction: e.target.value })} />
      <input aria-label="Date" type="date" className={fieldClass} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
      <input aria-label="Time" type="time" className={fieldClass} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
      <Button className="h-11 sm:col-span-2" onClick={submit} disabled={pending || !f.date || !f.time}>{pending ? "Saving…" : `Schedule for ${lead.assignedTo}`}</Button>
    </div>
  );
}

function AddLead({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", company: "", phone: "", area: "", source: "Meta Ads" as LeadSource, remarks: "" });
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form className="grid gap-2 rounded-xl border border-border bg-card p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!f.name.trim() || !f.phone.trim()) return;
        start(async () => {
          const res = await addLeadAction(f);
          if (res.ok) { toast.success("Lead added"); onDone(); } else toast.error(res.error);
        });
      }}>
      <input className={fieldClass} placeholder="Lead name *" value={f.name} onChange={set("name")} maxLength={120} />
      <input className={fieldClass} placeholder="Company" value={f.company} onChange={set("company")} maxLength={160} />
      <input className={fieldClass} placeholder="Mobile number *" value={f.phone} onChange={set("phone")} inputMode="tel" />
      <input className={fieldClass} placeholder="Area" value={f.area} onChange={set("area")} maxLength={120} />
      <select className={fieldClass} value={f.source} onChange={set("source")}>{LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}</select>
      <input className={fieldClass} placeholder="Remarks" value={f.remarks} onChange={set("remarks")} maxLength={500} />
      <Button type="submit" className="h-12 sm:col-span-2" disabled={pending}>{pending ? "Adding…" : "Add Lead"}</Button>
    </form>
  );
}
