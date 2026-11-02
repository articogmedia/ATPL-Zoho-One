"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, Clock3, History, Phone, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { addLeadAction, getLeadHistoryAction, saveLeadUpdateAction, scheduleVisitAction } from "@/app/actions/crm";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAssignLeads, leadsForTab, todayIST,
  type Lead, type LeadSource, type LeadStatus, type LeadTab, type LeadUpdate, type User,
} from "@/lib/domain";

type Props = { user: User; leads: Lead[]; executives: string[]; canAssign: boolean };
type DrawerMode = "edit" | "history" | "schedule";

const TABS: { id: LeadTab; label: string }[] = [
  { id: "fresh", label: "Fresh Leads to Call" },
  { id: "callback", label: "Call Back" },
  { id: "mine", label: "My Leads" },
  { id: "all", label: "All Leads" },
];

export function LeadsClient({ user, leads, executives, canAssign }: Props) {
  const isExec = user.role === "Sales Executive";
  const [tab, setTab] = useState<LeadTab>(isExec ? "mine" : "fresh");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [source, setSource] = useState<LeadSource | "All">("All");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(1), [tab, debouncedSearch, source]);

  const filtered = useMemo(
    () => leadsForTab(user, leads, tab, debouncedSearch, source),
    [user, leads, tab, debouncedSearch, source],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const visible = filtered.slice((page - 1) * 25, page * 25);
  const count = (id: LeadTab) => leadsForTab(user, leads, id, debouncedSearch, source).length;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Manage Leads</h1>
          <p className="mt-1 text-muted-foreground">Review enquiries, assign ownership, and track follow-ups.</p>
        </div>
        {!isExec && <Button className="h-10 shrink-0" onClick={() => setAdding((value) => !value)}><Plus /> <span className="hidden sm:inline">Add Lead</span><span className="sm:hidden">Add</span></Button>}
      </div>

      <div className="flex gap-2 overflow-x-auto border-b pb-2" role="tablist" aria-label="Lead views">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`shrink-0 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
          >
            {item.label} <span className="ml-1 opacity-75">({count(item.id)})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search leads</span>
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <input className={`${fieldClass} h-10 pl-9 text-sm`} placeholder="Search name, company or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className="sm:w-44">
          <span className="sr-only">Filter by source</span>
          <select aria-label="Filter by source" className={`${fieldClass} h-10 text-sm`} value={source} onChange={(event) => setSource(event.target.value as LeadSource | "All")}>
            <option value="All">All sources</option>
            {LEAD_SOURCES.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
      </div>

      {adding && <AddLead onDone={() => setAdding(false)} executives={executives} canAssign={canAssign} />}

      {visible.length === 0 ? (
        <EmptyState filtered={filtered.length !== leads.length || !!debouncedSearch || source !== "All"} onClear={() => { setSearch(""); setSource("All"); }} />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-border bg-card shadow-sm md:block">
            <table className="w-full text-left">
              <thead className="bg-secondary text-xs uppercase tracking-wide text-secondary-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">Lead</th><th className="px-3 py-3 font-semibold">Phone</th>
                  <th className="px-3 py-3 font-semibold">Source</th><th className="px-3 py-3 font-semibold">Created</th>
                  <th className="px-3 py-3 font-semibold">Status</th><th className="px-3 py-3 font-semibold">Owner</th><th className="px-4 py-3 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((lead) => <DesktopRow key={lead.id} lead={lead} onOpen={() => setSelected(lead)} />)}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 md:hidden">
            {visible.map((lead) => <MobileRow key={lead.id} lead={lead} onOpen={() => setSelected(lead)} />)}
          </div>
          <Pagination page={page} pageCount={pageCount} total={filtered.length} onChange={setPage} />
        </>
      )}

      {selected && (
        <LeadDrawer
          lead={selected}
          executives={executives}
          canAssign={canAssignLeads(user.role)}
          onClose={() => setSelected(null)}
          onSaved={() => {
            const fresh = leads.find((lead) => lead.id === selected.id);
            if (fresh) setSelected(fresh);
          }}
          onNext={(lead) => setSelected(lead)}
          nextLead={visible[visible.findIndex((lead) => lead.id === selected.id) + 1]}
        />
      )}
    </div>
  );
}

function DesktopRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  return (
    <tr className="group cursor-pointer hover:bg-secondary/50" onClick={onOpen}>
      <td className="max-w-56 px-4 py-3"><div className="truncate font-semibold">{lead.name}</div>{lead.company && <div className="truncate text-xs text-muted-foreground">{lead.company}</div>}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.phone || "—"}</td>
      <td className="whitespace-nowrap px-3 py-3">{lead.source}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.createdOn || "—"}</td>
      <td className="px-3 py-3"><StatusBadge status={lead.status} /></td>
      <td className="max-w-36 truncate px-3 py-3">{lead.assignedTo ?? "Unassigned"}</td>
      <td className="px-4 py-3 text-right" onClick={(event) => event.stopPropagation()}><Button asChild size="sm" variant="outline"><a href={`tel:${lead.phone.replace(/\s/g, "")}`} aria-label={`Call ${lead.name}`}><Phone /> Call</a></Button></td>
    </tr>
  );
}

function MobileRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} className="rounded-xl border border-border bg-card p-3 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="truncate font-semibold">{lead.name}</div><div className="truncate text-xs text-muted-foreground">{lead.company || "No company"}</div></div>
        <StatusBadge status={lead.status} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-y-1 text-xs text-muted-foreground"><span>{lead.phone || "No phone"}</span><span>{lead.source}</span><span>{lead.createdOn || "No date"}</span><span className="truncate">{lead.assignedTo ?? "Unassigned"}</span></div>
      <div className="mt-3 flex justify-end" onClick={(event) => event.stopPropagation()}><Button asChild size="sm" variant="outline"><a href={`tel:${lead.phone.replace(/\s/g, "")}`}><Phone /> Call</a></Button></div>
    </div>
  );
}

function Pagination({ page, pageCount, total, onChange }: { page: number; pageCount: number; total: number; onChange: (page: number) => void }) {
  if (total <= 25) return null;
  return <nav className="flex items-center justify-between gap-3" aria-label="Lead pagination">
    <span className="text-xs text-muted-foreground">Page {page} of {pageCount} · {total} leads</span>
    <div className="flex gap-1"><Button variant="outline" size="icon" className="h-9 w-9" disabled={page === 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft /></Button><Button variant="outline" size="icon" className="h-9 w-9" disabled={page === pageCount} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight /></Button></div>
  </nav>;
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return <div className="rounded-xl border border-dashed border-border bg-card px-5 py-12 text-center"><div className="text-base font-semibold">{filtered ? "No leads match your filters" : "No leads in this view"}</div><p className="mt-1 text-muted-foreground">{filtered ? "Try a different search or source." : "New enquiries will appear here."}</p>{filtered && <Button variant="outline" className="mt-4 h-10" onClick={onClear}>Clear filters</Button>}</div>;
}

function LeadDrawer({ lead, executives, canAssign, onClose, onSaved, onNext, nextLead }: {
  lead: Lead; executives: string[]; canAssign: boolean; onClose: () => void; onSaved: () => void; onNext: (lead: Lead) => void; nextLead?: Lead;
}) {
  const [mode, setMode] = useState<DrawerMode>("edit");
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [assignee, setAssignee] = useState(lead.assignedTo ?? "");
  const [remarks, setRemarks] = useState("");
  const [history, setHistory] = useState<LeadUpdate[] | null>(null);
  const [pending, start] = useTransition();
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const drawerRef = useRef<HTMLDivElement>(null);
  const filteredExecutives = executives.filter((name) => name.toLowerCase().includes(assigneeSearch.toLowerCase()));

  useEffect(() => {
    drawerRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = (saveNext = false) => start(async () => {
    const result = await saveLeadUpdateAction({ id: lead.id, status, remarks, ...(canAssign ? { assignedTo: assignee || null } : {}) });
    if (!result.ok) { toast.error(result.error); return; }
    const zohoUrl = result.data?.zohoUrl;
    toast.success(`Saved update for ${lead.name}`, zohoUrl ? {
      action: { label: "Open in Zoho", onClick: () => window.open(zohoUrl, "_blank", "noopener,noreferrer") },
    } : undefined);
    onSaved();
    setRemarks("");
    if (saveNext && nextLead) {
      toast.success(`Next lead: ${nextLead.name}`);
      onNext(nextLead);
    }
  });

  const loadHistory = () => {
    setMode("history");
    if (history) return;
    void getLeadHistoryAction(lead.id).then((result) => {
      if (result.ok) setHistory(result.data ?? []);
      else toast.error(result.error);
    });
  };

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button className="absolute inset-0 cursor-default bg-black/40" aria-label="Close lead details" onClick={onClose} />
      <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="lead-drawer-title" className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col bg-card shadow-2xl focus-visible:outline-none">
        <header className="flex items-start justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <div className="min-w-0"><h2 id="lead-drawer-title" className="truncate text-lg font-bold">{lead.name}</h2><p className="truncate text-xs text-muted-foreground">{lead.company || "No company"} · {lead.phone || "No phone"}</p></div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>
        </header>
        <div className="flex gap-1 border-b px-4 pt-2 sm:px-6">
          <DrawerTab active={mode === "edit"} onClick={() => setMode("edit")}>Details</DrawerTab>
          <DrawerTab active={mode === "history"} onClick={loadHistory}><History /> History</DrawerTab>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {mode === "history" ? (
            <HistoryList history={history} />
          ) : mode === "schedule" ? (
            <ScheduleForm lead={lead} onDone={() => setMode("edit")} />
          ) : (
            <div className="space-y-4">
              <label className="block font-medium">Status<select className={`${fieldClass} mt-1 h-10 text-sm`} value={status} onChange={(event) => setStatus(event.target.value as LeadStatus)}>{LEAD_STATUSES.map((item) => <option key={item}>{item}</option>)}</select></label>
              {canAssign && <label className="relative block font-medium">Assign to Sales Executive
                <button type="button" role="combobox" aria-expanded={comboboxOpen} aria-controls="lead-executive-options" className={`${fieldClass} mt-1 flex h-10 items-center justify-between text-left text-sm`} onClick={() => setComboboxOpen((value) => !value)} disabled={!executives.length}><span className={assignee ? "text-foreground" : "text-muted-foreground"}>{assignee || "Unassigned"}</span><Search className="h-4 w-4" /></button>
                {comboboxOpen && <div id="lead-executive-options" role="listbox" className="absolute z-10 mt-1 max-h-52 w-full overflow-auto rounded-md border bg-card p-1 shadow-lg">
                  <input autoFocus className={`${fieldClass} h-9 text-sm`} placeholder="Search executives…" value={assigneeSearch} onChange={(event) => setAssigneeSearch(event.target.value)} aria-label="Search executives" />
                  <button type="button" role="option" aria-selected={!assignee} className="mt-1 block w-full rounded px-2 py-2 text-left text-sm font-medium hover:bg-secondary" onClick={() => { setAssignee(""); setComboboxOpen(false); }}>Unassigned</button>
                  {filteredExecutives.map((name) => <button key={name} type="button" role="option" aria-selected={assignee === name} className="mt-1 block w-full rounded px-2 py-2 text-left text-sm hover:bg-secondary" onClick={() => { setAssignee(name); setComboboxOpen(false); }}>{name}</button>)}
                  {!executives.length && <p className="p-2 text-xs text-destructive">No sales executives found. A manager must check ZOHO_ROLE_OVERRIDES / Zoho roles.</p>}
                  {!!executives.length && !filteredExecutives.length && <p className="p-2 text-xs text-muted-foreground">No executives match your search.</p>}
                </div>}
              </label>}
              <label className="block font-medium">Remarks<textarea className={`${fieldClass} mt-1 h-28 py-2 text-sm`} placeholder="Add a note about this lead…" value={remarks} onChange={(event) => setRemarks(event.target.value)} maxLength={500} /></label>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button className="h-10" disabled={pending} onClick={() => save()}>{pending ? "Saving…" : "Save"}</Button>
                <Button variant="outline" className="h-10" disabled={pending || !nextLead} onClick={() => save(true)}>{pending ? "Saving…" : "Save & next"}</Button>
              </div>
              <div className="grid gap-2 border-t pt-4 sm:grid-cols-2">
                <Button variant="outline" className="h-10" onClick={loadHistory}><History /> History</Button>
                <Button variant="outline" className="h-10" onClick={() => setMode("schedule")}><CalendarPlus /> Schedule visit</Button>
                <Button asChild variant="secondary" className="h-10 sm:col-span-2"><Link href={`/quotations?lead=${lead.id}`} onClick={onClose}><Clock3 /> Create quotation</Link></Button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function DrawerTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`flex h-9 items-center gap-1 border-b-2 px-2 text-sm font-semibold ${active ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={onClick}>{children}</button>;
}

function HistoryList({ history }: { history: LeadUpdate[] | null }) {
  if (history === null) return <p className="text-muted-foreground">Loading history…</p>;
  if (!history.length) return <p className="rounded-lg bg-secondary p-4 text-muted-foreground">No history yet.</p>;
  return <ul className="space-y-3 border-l-2 border-border pl-4">{history.map((item, index) => <li key={index}><div className="text-xs text-muted-foreground">{item.date} · {item.user}</div><div className="mt-1">{item.note}</div></li>)}</ul>;
}

const VISIT_TYPES = ["Site survey", "Room inspection", "Demo visit", "Installation check", "Collect advance", "Follow-up call", "Prepare quotation"];

function ScheduleForm({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [f, setF] = useState({ type: VISIT_TYPES[0]!, date: todayIST(), time: "11:00", nextAction: "", followUp: "" });
  const [pending, start] = useTransition();
  const isVisit = !["Follow-up call", "Prepare quotation"].includes(f.type);
  const submit = () => start(async () => {
    const result = await scheduleVisitAction({ leadId: lead.id, executive: lead.assignedTo ?? undefined, isVisit, ...f });
    if (result.ok) { toast.success("Visit scheduled"); onDone(); } else toast.error(result.error);
  });
  return <div className="space-y-3"><div><h3 className="font-semibold">Schedule visit / work</h3><p className="mt-1 text-xs text-muted-foreground">Owner: {lead.assignedTo ?? "Unassigned"}</p></div>
    <select aria-label="Type" className={`${fieldClass} h-10 text-sm`} value={f.type} onChange={(event) => setF({ ...f, type: event.target.value })}>{VISIT_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
    <input aria-label="Next action" className={`${fieldClass} h-10 text-sm`} placeholder="Next action" value={f.nextAction} maxLength={200} onChange={(event) => setF({ ...f, nextAction: event.target.value })} />
    <div className="grid grid-cols-2 gap-2"><input aria-label="Date" type="date" className={`${fieldClass} h-10 text-sm`} value={f.date} onChange={(event) => setF({ ...f, date: event.target.value })} /><input aria-label="Time" type="time" className={`${fieldClass} h-10 text-sm`} value={f.time} onChange={(event) => setF({ ...f, time: event.target.value })} /></div>
    <input aria-label="Follow-up date" type="date" className={`${fieldClass} h-10 text-sm`} value={f.followUp} onChange={(event) => setF({ ...f, followUp: event.target.value })} />
    <div className="flex gap-2"><Button variant="outline" className="h-10 flex-1" onClick={onDone}>Cancel</Button><Button className="h-10 flex-1" onClick={submit} disabled={pending || !f.date || !f.time}>{pending ? "Saving…" : "Schedule"}</Button></div>
  </div>;
}

function AddLead({ onDone, executives, canAssign }: { onDone: () => void; executives: string[]; canAssign: boolean }) {
  const [f, setF] = useState({ name: "", company: "", phone: "", area: "", source: "Meta Ads" as LeadSource, remarks: "", assignedTo: "" });
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof f) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [key]: event.target.value });
  return <form className="grid gap-2 rounded-xl border border-border bg-card p-4 shadow-sm sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); if (!f.name.trim() || !f.phone.trim()) return; start(async () => { const result = await addLeadAction({ ...f, assignedTo: f.assignedTo || null }); if (result.ok) { const zohoUrl = result.data?.zohoUrl; toast.success("Lead added", zohoUrl ? { action: { label: "Open in Zoho", onClick: () => window.open(zohoUrl, "_blank", "noopener,noreferrer") } } : undefined); onDone(); } else { setDuplicate(result.duplicate ?? null); toast.error(result.error); } }); }}>
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Lead name *" value={f.name} onChange={set("name")} maxLength={120} />
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Company" value={f.company} onChange={set("company")} maxLength={160} />
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Mobile number *" value={f.phone} onChange={set("phone")} inputMode="tel" />
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Area" value={f.area} onChange={set("area")} maxLength={120} />
    <select className={`${fieldClass} h-10 text-sm`} value={f.source} onChange={set("source")}>{LEAD_SOURCES.map((item) => <option key={item}>{item}</option>)}</select>
    {canAssign && <select className={`${fieldClass} h-10 text-sm`} disabled={!executives.length} value={f.assignedTo} onChange={set("assignedTo")}><option value="">Assign to (optional)</option>{executives.map((name) => <option key={name}>{name}</option>)}</select>}
    <input className={`${fieldClass} h-10 text-sm sm:col-span-2`} placeholder="Remarks" value={f.remarks} onChange={set("remarks")} maxLength={500} />
    {duplicate && <p className="text-sm text-destructive sm:col-span-2">Lead already exists: <a className="underline" href={`/leads#lead-${duplicate.id}`}>{duplicate.name}</a></p>}
    <Button type="submit" className="h-10 sm:col-span-2" disabled={pending}>{pending ? "Adding…" : "Add Lead"}</Button>
  </form>;
}
