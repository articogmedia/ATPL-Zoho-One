"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, ChevronLeft, ChevronRight, Clock3, History, Pencil, Phone, Plus, Search, SlidersHorizontal, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { addLeadAction, deleteLeadAction, fixAssignedLeadsAction, getLeadTimelineAction, logCallAction, reassignLeadAction, saveLeadUpdateAction, scheduleVisitAction, updateLeadAction } from "@/app/actions/crm";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAssignLeads, leadsForTab, todayIST,
  type CallOutcome, type Lead, type LeadFilters, type LeadSource, type LeadStatus, type LeadTab, type LeadTimelineItem, type User,
} from "@/lib/domain";

type Props = { user: User; leads: Lead[]; executives: string[]; owners: string[]; canAssign: boolean };
type DrawerMode = "edit" | "history" | "schedule";
type LeadAction = { type: "call" | "edit" | "reassign" | "delete"; lead: Lead } | null;

const TABS: { id: LeadTab; label: string }[] = [
  { id: "fresh", label: "Fresh Leads to Call" },
  { id: "assigned", label: "Assigned to Sales" },
  { id: "callback", label: "Call Back" },
  { id: "mine", label: "My Leads" },
  { id: "all", label: "All Leads" },
];

export function LeadsClient({ user, leads, executives, owners, canAssign }: Props) {
  const isExec = user.role === "Sales Executive";
  const [tab, setTab] = useState<LeadTab>(isExec ? "mine" : "fresh");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [source, setSource] = useState<LeadSource | "All">("All");
  const [filters, setFilters] = useState<LeadFilters>({ stage: "All", owner: "All" });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [action, setAction] = useState<LeadAction>(null);
  const router = useRouter();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(1), [tab, debouncedSearch, source, filters]);

  const filtered = useMemo(
    () => leadsForTab(user, leads, tab, debouncedSearch, source, filters),
    [user, leads, tab, debouncedSearch, source, filters],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const visible = filtered.slice((page - 1) * 25, page * 25);
  const availableTabs = TABS.filter((item) => !(item.id === "fresh" && isExec) && !(item.id === "all" && user.role !== "Manager"));
  const count = (id: LeadTab) => leadsForTab(user, leads, id, debouncedSearch, source, filters).length;
  const todaysFollowUps = leadsForTab(user, leads, "callback").filter((lead) => lead.followUp === todayIST()).length;
  const fixableCount = leads.filter((lead) => lead.status === "Fresh Lead" && (!!lead.assignedToId || !!lead.assignedTo)).length;
  const activeFilterCount = [source !== "All", filters.owner !== "All", filters.stage !== "All", !!filters.from, !!filters.to].filter(Boolean).length;

  return (
    <div className="space-y-4 text-sm max-[480px]:space-y-3 max-[480px]:pt-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="w-full">
          <h1 className="text-xl font-bold sm:text-2xl">Manage Leads</h1>
          <p className="mt-1 text-muted-foreground">Review enquiries, assign ownership, and track follow-ups.</p>
        </div>
        {!isExec && <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end"><Button className="h-11 shrink-0" onClick={() => setAdding((value) => !value)}><Plus /> <span className="hidden sm:inline">Add Lead</span><span className="sm:hidden">Add</span></Button><span className="rounded-full bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground">Today&apos;s follow-ups: {todaysFollowUps}</span>{user.role === "Manager" && <span className="max-[480px]:hidden"><FixAssignedLeads count={fixableCount} /></span>}</div>}
      </div>

      {user.role === "Manager" && fixableCount > 0 && <div className="hidden items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 max-[480px]:flex"><span>Some assigned leads still show as Fresh Lead.</span><FixAssignedLeads count={fixableCount} /></div>}

      <div className="flex gap-2 overflow-x-auto border-b pb-2 max-[480px]:-mx-1 max-[480px]:px-1" role="tablist" aria-label="Lead views">
        {availableTabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`h-11 shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[480px]:w-[calc(50vw-1.5rem)] max-[480px]:min-w-[calc(50vw-1.5rem)] ${tab === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
          >
            <span className="max-[480px]:hidden">{item.label}</span><span className="hidden max-[480px]:inline">{item.id === "fresh" ? "Fresh" : item.label}</span> <span className="ml-1 opacity-75">({count(item.id)})</span>
          </button>
        ))}
      </div>

      <div className="flex flex-row gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search leads</span>
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <input className={`${fieldClass} h-11 pl-9 text-sm`} placeholder="Search name, company or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <Button type="button" variant="outline" size="icon" className="relative h-11 w-11 shrink-0 sm:hidden" onClick={() => setFiltersOpen(true)} aria-label={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ""}`}><SlidersHorizontal />{activeFilterCount > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">{activeFilterCount}</span>}</Button>
      </div>

      <LeadFiltersPanel
        open={filtersOpen}
        owners={owners}
        filters={filters}
        source={source}
        onChange={setFilters}
        onSourceChange={setSource}
        onClose={() => setFiltersOpen(false)}
      />

      {adding && <AddLead onDone={() => setAdding(false)} executives={executives} canAssign={canAssign} canForceDuplicate={user.role === "Manager"} />}

      {visible.length === 0 ? (
        <EmptyState filtered={filtered.length !== leads.length || !!debouncedSearch || source !== "All" || filters.owner !== "All" || filters.stage !== "All" || !!filters.from || !!filters.to} onClear={() => { setSearch(""); setSource("All"); setFilters({ owner: "All", stage: "All" }); }} />
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
                {visible.map((lead) => <DesktopRow key={lead.id} lead={lead} manager={user.role === "Manager"} onOpen={() => setSelected(lead)} onAction={(type) => setAction({ type, lead })} />)}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 max-[480px]:space-y-1.5 md:hidden">
            {visible.map((lead) => <MobileRow key={lead.id} lead={lead} manager={user.role === "Manager"} onOpen={() => setSelected(lead)} onAction={(type) => setAction({ type, lead })} />)}
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
      {action && <LeadActionModal action={action} executives={executives} onClose={() => setAction(null)} onDone={() => { setAction(null); router.refresh(); }} onAssigned={(name) => { setAction(null); setTab("assigned"); toast.success(`Assigned to ${name}. Moved to Assigned to Sales`, { action: { label: "Open tab", onClick: () => setTab("assigned") } }); router.refresh(); }} />}
    </div>
  );
}

function ActionButtons({ lead, manager, onAction }: { lead: Lead; manager: boolean; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  return <div className="flex justify-end gap-1">
    <Button size="sm" variant="outline" onClick={() => onAction("call")} aria-label={`Log call for ${lead.name}`}><Phone /> <span className="hidden lg:inline">Call</span></Button>
    <Button size="icon" variant="ghost" aria-label={`Edit ${lead.name}`} onClick={() => onAction("edit")}><Pencil /></Button>
    {manager && <><Button size="icon" variant="ghost" aria-label={`Reassign ${lead.name}`} onClick={() => onAction("reassign")}><UserRound /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${lead.name}`} onClick={() => onAction("delete")}><Trash2 /></Button></>}
  </div>;
}

function DesktopRow({ lead, manager, onOpen, onAction }: { lead: Lead; manager: boolean; onOpen: () => void; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  return (
    <tr className="group cursor-pointer hover:bg-secondary/50" onClick={onOpen}>
      <td className="max-w-56 px-4 py-3"><div className="truncate font-semibold">{lead.name}</div>{lead.company && <div className="truncate text-xs text-muted-foreground">{lead.company}</div>}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.phone || "—"}</td>
      <td className="whitespace-nowrap px-3 py-3">{lead.source}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.createdOn || "—"}</td>
      <td className="px-3 py-3"><StatusBadge status={lead.status} />{lead.followUp && lead.followUp <= todayIST() && <div className="mt-1 text-xs font-semibold text-destructive">Overdue</div>}</td>
      <td className="max-w-36 truncate px-3 py-3">{lead.assignedTo ?? "Unassigned"}</td>
      <td className="px-4 py-3 text-right" onClick={(event) => event.stopPropagation()}><ActionButtons lead={lead} manager={manager} onAction={onAction} /></td>
    </tr>
  );
}

function MobileRow({ lead, manager, onOpen, onAction }: { lead: Lead; manager: boolean; onOpen: () => void; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} className="rounded-xl border border-border bg-card p-3 shadow-sm max-[480px]:p-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="truncate font-semibold">{lead.name}</div><div className="truncate text-xs text-muted-foreground">{lead.company || "No company"}</div></div>
        <StatusBadge status={lead.status} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-y-1 text-xs text-muted-foreground max-[480px]:mt-2"><a className="truncate underline" href={`tel:${lead.phone.replace(/\s/g, "")}`} onClick={(event) => event.stopPropagation()}>{lead.phone || "No phone"}</a><span>{lead.source}</span><span>{lead.createdOn || "No date"}</span><span className="truncate">{lead.assignedTo ?? "Unassigned"}</span>{lead.followUp && lead.followUp <= todayIST() && <span className="font-semibold text-destructive">Overdue</span>}</div>
      <a className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md border border-[#25D366] px-3 text-sm font-semibold text-[#128C7E] max-[480px]:mt-2" href={`https://wa.me/${lead.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label={`Message ${lead.name} on WhatsApp`}>WhatsApp</a>
      <div className="mt-3 max-[480px]:mt-2" onClick={(event) => event.stopPropagation()}><ActionButtons lead={lead} manager={manager} onAction={onAction} /></div>
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

function FixAssignedLeads({ count }: { count: number }) {
  const [pending, start] = useTransition();
  const fix = () => {
    if (!window.confirm(`Move ${count} Sales-owned lead${count === 1 ? "" : "s"} from Fresh Lead to Assigned to Sales?`)) return;
    start(async () => {
      const result = await fixAssignedLeadsAction();
      if (result.ok) toast.success(`${result.data?.changed ?? 0} assigned leads fixed`);
      else toast.error(result.error);
    });
  };
  return <Button variant="outline" className="h-10 max-[480px]:h-11 max-[480px]:text-xs" onClick={fix} disabled={pending || count === 0}>{pending ? "Fixing…" : `Fix assigned leads (${count})`}</Button>;
}

function LeadFiltersPanel({ open, owners, filters, source, onChange, onSourceChange, onClose }: {
  open: boolean; owners: string[]; filters: LeadFilters; source: LeadSource | "All";
  onChange: (filters: LeadFilters) => void; onSourceChange: (source: LeadSource | "All") => void; onClose: () => void;
}) {
  const content = <div className="grid gap-2 sm:grid-cols-4">
    <label className="text-xs font-semibold">Owner<select className={`${fieldClass} mt-1 h-10 text-sm`} value={filters.owner ?? "All"} onChange={(e) => onChange({ ...filters, owner: e.target.value })}><option value="All">All owners</option>{owners.map((owner) => <option key={owner}>{owner}</option>)}</select></label>
    <label className="text-xs font-semibold">Stage<select className={`${fieldClass} mt-1 h-10 text-sm`} value={filters.stage ?? "All"} onChange={(e) => onChange({ ...filters, stage: e.target.value as LeadStatus | "All" })}><option value="All">All stages</option>{LEAD_STATUSES.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
    <label className="text-xs font-semibold">Source<select className={`${fieldClass} mt-1 h-10 text-sm`} value={source} onChange={(e) => onSourceChange(e.target.value as LeadSource | "All")}><option value="All">All sources</option>{LEAD_SOURCES.map((item) => <option key={item}>{item}</option>)}</select></label>
    <div className="grid grid-cols-2 gap-2"><label className="text-xs font-semibold">From<input type="date" className={`${fieldClass} mt-1 h-10 text-sm`} value={filters.from ?? ""} onChange={(e) => onChange({ ...filters, from: e.target.value })} /></label><label className="text-xs font-semibold">To<input type="date" className={`${fieldClass} mt-1 h-10 text-sm`} value={filters.to ?? ""} onChange={(e) => onChange({ ...filters, to: e.target.value })} /></label></div>
  </div>;
  return <>
    <div className="hidden rounded-lg border bg-card p-3 sm:block">{content}</div>
    {open && <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:hidden"><button className="absolute inset-0" aria-label="Close filters" onClick={onClose} /><div className="relative w-full rounded-t-2xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Filter leads</h2><Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close filters"><X /></Button></div>{content}<Button className="mt-4 w-full" onClick={onClose}>Apply filters</Button></div></div>}
  </>;
}

function LeadActionModal({ action, executives, onClose, onDone, onAssigned }: {
  action: Exclude<LeadAction, null>; executives: string[]; onClose: () => void; onDone: () => void; onAssigned: (name: string) => void;
}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState(action.lead.name);
  const [company, setCompany] = useState(action.lead.company);
  const [phone, setPhone] = useState(action.lead.phone);
  const [source, setSource] = useState<LeadSource>(action.lead.source);
  const [assignee, setAssignee] = useState("");
  const [outcome, setOutcome] = useState<CallOutcome>("Connected");
  const [remarks, setRemarks] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [followUpTime, setFollowUpTime] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      const result = action.type === "edit"
        ? await updateLeadAction({ id: action.lead.id, name, company, phone, source })
        : action.type === "reassign"
          ? await reassignLeadAction({ id: action.lead.id, assignedTo: assignee })
          : action.type === "delete"
            ? await deleteLeadAction({ id: action.lead.id })
            : await logCallAction({ leadId: action.lead.id, outcome, remarks, ...(followUp ? { followUp, followUpTime } : {}) });
      if (!result.ok) { toast.error(result.error); return; }
      if (action.type === "reassign") onAssigned(assignee);
      else {
        toast.success(action.type === "delete" ? "Lead deleted" : "Lead updated");
        onDone();
      }
    });
  };

  const title = action.type === "call" ? "Log call" : action.type === "edit" ? "Edit lead" : action.type === "reassign" ? "Reassign owner" : "Delete lead";
  return <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 md:items-center md:p-4" role="presentation">
    <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />
    <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="lead-action-title" className="relative w-full max-w-md space-y-4 rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl md:rounded-xl md:pb-5">
      <div className="flex items-start justify-between gap-3"><div><h2 id="lead-action-title" className="text-lg font-bold">{title}</h2><p className="text-sm text-muted-foreground">{action.lead.name}</p></div><Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button></div>
      {action.type === "edit" && <div className="grid gap-3">
        <label className="font-medium">Name<input className={`${fieldClass} mt-1 h-10 text-sm`} value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
        <label className="font-medium">Company<input className={`${fieldClass} mt-1 h-10 text-sm`} value={company} onChange={(event) => setCompany(event.target.value)} maxLength={160} /></label>
        <label className="font-medium">Phone<input className={`${fieldClass} mt-1 h-10 text-sm`} value={phone} onChange={(event) => setPhone(event.target.value)} required inputMode="tel" pattern="(?:\+91\s?)?\d{10}" title="Enter a 10-digit phone number" /></label>
        <label className="font-medium">Source<select className={`${fieldClass} mt-1 h-10 text-sm`} value={source} onChange={(event) => setSource(event.target.value as LeadSource)}>{LEAD_SOURCES.map((item) => <option key={item}>{item}</option>)}</select></label>
      </div>}
      {action.type === "reassign" && <label className="block font-medium">Assign to<select className={`${fieldClass} mt-1 h-10 text-sm`} value={assignee} onChange={(event) => setAssignee(event.target.value)} required><option value="">Select a team member</option>{executives.map((name) => <option key={name}>{name}</option>)}</select></label>}
      {action.type === "call" && <div className="grid gap-3">
        <label className="font-medium">Outcome<select className={`${fieldClass} mt-1 h-10 text-sm`} value={outcome} onChange={(event) => setOutcome(event.target.value as CallOutcome)}>{["Connected", "No Answer", "Busy", "Wrong Number", "Call Back Later"].map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="font-medium">Remarks<textarea className={`${fieldClass} mt-1 h-24 py-2 text-sm`} value={remarks} onChange={(event) => setRemarks(event.target.value)} maxLength={500} /></label>
        <div className="grid grid-cols-2 gap-2"><label className="font-medium">Follow-up date<input type="date" className={`${fieldClass} mt-1 h-10 text-sm`} value={followUp} onChange={(event) => setFollowUp(event.target.value)} /></label><label className="font-medium">Time<input type="time" className={`${fieldClass} mt-1 h-10 text-sm`} value={followUpTime} onChange={(event) => setFollowUpTime(event.target.value)} disabled={!followUp} /></label></div>
      </div>}
      {action.type === "delete" && <p className="rounded-md bg-destructive/10 p-3 text-sm">This lead will be moved to the Zoho Recycle Bin.</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" variant={action.type === "delete" ? "destructive" : "default"} disabled={pending}>{pending ? "Saving..." : action.type === "delete" ? "Delete" : action.type === "reassign" ? "Confirm" : action.type === "call" ? "Log call" : "Save"}</Button></div>
    </form>
  </div>;
}

function LeadDrawer({ lead, executives, canAssign, onClose, onSaved, onNext, nextLead }: {
  lead: Lead; executives: string[]; canAssign: boolean; onClose: () => void; onSaved: () => void; onNext: (lead: Lead) => void; nextLead?: Lead;
}) {
  const [mode, setMode] = useState<DrawerMode>("edit");
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [assignee, setAssignee] = useState(lead.assignedTo ?? "");
  const [remarks, setRemarks] = useState("");
  const [history, setHistory] = useState<LeadTimelineItem[] | null>(null);
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
    void getLeadTimelineAction(lead.id).then((result) => {
      if (result.ok) setHistory(result.data ?? []);
      else toast.error(result.error);
    });
  };

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button className="absolute inset-0 cursor-default bg-black/40" aria-label="Close lead details" onClick={onClose} />
      <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="lead-drawer-title" className="absolute bottom-0 left-0 flex h-[92vh] w-full flex-col rounded-t-2xl bg-card shadow-2xl focus-visible:outline-none md:bottom-auto md:left-auto md:right-0 md:top-0 md:h-full md:max-w-lg md:rounded-none">
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

function HistoryList({ history }: { history: LeadTimelineItem[] | null }) {
  if (history === null) return <p className="text-muted-foreground">Loading history…</p>;
  if (!history.length) return <p className="rounded-lg bg-secondary p-4 text-muted-foreground">No history yet.</p>;
  return <ul className="space-y-3 border-l-2 border-border pl-4">{history.map((item, index) => <li key={index}><div className="text-xs text-muted-foreground">{item.date} · {item.user} · {item.kind}</div><div className="mt-1 font-medium">{item.title}</div>{item.detail && <div className="text-sm text-muted-foreground">{item.detail}</div>}</li>)}</ul>;
}

const VISIT_TYPES = ["Site survey", "Room inspection", "Demo visit", "Installation check", "Collect advance", "Follow-up call", "Prepare quotation"];

function ScheduleForm({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const [f, setF] = useState({ type: VISIT_TYPES[0]!, date: todayIST(), time: "11:00", address: lead.address, nextAction: "", followUp: "" });
  const [pending, start] = useTransition();
  const isVisit = !["Follow-up call", "Prepare quotation"].includes(f.type);
  const submit = () => start(async () => {
    const result = await scheduleVisitAction({ leadId: lead.id, executive: lead.assignedTo ?? undefined, isVisit, ...f });
    if (result.ok) { toast.success("Visit scheduled"); onDone(); } else toast.error(result.error);
  });
  return <div className="space-y-3"><div><h3 className="font-semibold">Schedule visit / work</h3><p className="mt-1 text-xs text-muted-foreground">Owner: {lead.assignedTo ?? "Unassigned"}</p></div>
    <select aria-label="Type" className={`${fieldClass} h-10 text-sm`} value={f.type} onChange={(event) => setF({ ...f, type: event.target.value })}>{VISIT_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
    <input aria-label="Address" className={`${fieldClass} h-10 text-sm`} placeholder="Visit address" value={f.address} maxLength={240} onChange={(event) => setF({ ...f, address: event.target.value })} />
    <input aria-label="Next action" className={`${fieldClass} h-10 text-sm`} placeholder="Next action" value={f.nextAction} maxLength={200} onChange={(event) => setF({ ...f, nextAction: event.target.value })} />
    <div className="grid grid-cols-2 gap-2"><input aria-label="Date" type="date" className={`${fieldClass} h-10 text-sm`} value={f.date} onChange={(event) => setF({ ...f, date: event.target.value })} /><input aria-label="Time" type="time" className={`${fieldClass} h-10 text-sm`} value={f.time} onChange={(event) => setF({ ...f, time: event.target.value })} /></div>
    <input aria-label="Follow-up date" type="date" className={`${fieldClass} h-10 text-sm`} value={f.followUp} onChange={(event) => setF({ ...f, followUp: event.target.value })} />
    <div className="flex gap-2"><Button variant="outline" className="h-10 flex-1" onClick={onDone}>Cancel</Button><Button className="h-10 flex-1" onClick={submit} disabled={pending || !f.date || !f.time}>{pending ? "Saving…" : "Schedule"}</Button></div>
  </div>;
}

function AddLead({ onDone, executives, canAssign, canForceDuplicate }: { onDone: () => void; executives: string[]; canAssign: boolean; canForceDuplicate: boolean }) {
  const [f, setF] = useState({ name: "", company: "", phone: "", area: "", source: "Meta Ads" as LeadSource, remarks: "", assignedTo: "" });
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; owner: string; status: string } | null>(null);
  const [forceCreate, setForceCreate] = useState(false);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof f) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [key]: event.target.value });
  return <form className="fixed inset-x-0 bottom-0 z-40 grid max-h-[90vh] gap-2 overflow-y-auto rounded-t-2xl border border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:grid-cols-2 md:static md:max-h-none md:overflow-visible md:rounded-xl md:p-4 md:shadow-sm" onSubmit={(event) => { event.preventDefault(); if (!f.name.trim() || !f.phone.trim()) return; start(async () => { const result = await addLeadAction({ ...f, assignedTo: f.assignedTo || null, forceCreate }); if (result.ok) { const zohoUrl = result.data?.zohoUrl; toast.success("Lead added", zohoUrl ? { action: { label: "Open in Zoho", onClick: () => window.open(zohoUrl, "_blank", "noopener,noreferrer") } } : undefined); onDone(); } else { setDuplicate(result.duplicate ?? null); toast.error(result.error); } }); }}>
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Lead name *" value={f.name} onChange={set("name")} maxLength={120} />
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Company" value={f.company} onChange={set("company")} maxLength={160} />
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Mobile number *" value={f.phone} onChange={set("phone")} inputMode="tel" />
    <input className={`${fieldClass} h-10 text-sm`} placeholder="Area" value={f.area} onChange={set("area")} maxLength={120} />
    <select className={`${fieldClass} h-10 text-sm`} value={f.source} onChange={set("source")}>{LEAD_SOURCES.map((item) => <option key={item}>{item}</option>)}</select>
    {canAssign && <select className={`${fieldClass} h-10 text-sm`} disabled={!executives.length} value={f.assignedTo} onChange={set("assignedTo")}><option value="">Assign to (optional)</option>{executives.map((name) => <option key={name}>{name}</option>)}</select>}
    <input className={`${fieldClass} h-10 text-sm sm:col-span-2`} placeholder="Remarks" value={f.remarks} onChange={set("remarks")} maxLength={500} />
    {duplicate && <div className="text-sm text-destructive sm:col-span-2"><p>A lead with this number already exists: <a className="underline" href={`/leads#lead-${duplicate.id}`}>{duplicate.name}</a></p><p className="mt-1 text-xs text-muted-foreground">Owner: {duplicate.owner} · Status: {duplicate.status}</p>{canForceDuplicate && <Button type="button" variant="outline" className="mt-2 h-10" onClick={() => setForceCreate(true)}>Create anyway</Button>}</div>}
    <Button type="submit" className="h-10 sm:col-span-2" disabled={pending}>{pending ? "Adding…" : "Add Lead"}</Button>
  </form>;
}
