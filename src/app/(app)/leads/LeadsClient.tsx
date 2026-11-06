"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { CalendarPlus, Clock3, History, Pencil, Phone, Plus, Search, SlidersHorizontal, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { claimLeadSubmission, shouldClearLeadDuplicate } from "@/lib/lead-form-state";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { CallLeadModal } from "@/components/leads/call-lead-modal";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { addLeadAction, deleteLeadAction, fixAssignedLeadsAction, getAssignableUsersAction, getLeadTimelineAction, reassignLeadAction, saveLeadUpdateAction, scheduleVisitAction, updateLeadAction } from "@/app/actions/crm";
import {
  LEAD_SOURCES, LEAD_STATUSES, canAssignLeads, normalizePhone, todayIST,
  type Lead, type LeadFilters, type LeadSource, type LeadStatus, type LeadTab, type LeadTimelineItem, type User,
} from "@/lib/domain";

type Props = {
  user: User; leads: Lead[]; executives: string[]; assignees: { id: string; name: string }[]; assigneesUnavailable: boolean; owners: string[]; canAssign: boolean;
  fixableLeads: { id: string; name: string; ownerName: string }[];
  initialTab: LeadTab; initialCount: number; tabCounts: Record<LeadTab, number>;
  todaysFollowUps: number; hasAnyLeads: boolean;
};
type DrawerMode = "edit" | "history" | "schedule";
type LeadMutationAction = { type: "edit" | "reassign" | "delete"; lead: Lead };
type LeadAction = { type: "call"; lead: Lead } | LeadMutationAction | null;

function useBodyScrollLock(open = true) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);
}

function whatsappUrl(phone: string): string | null {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `https://wa.me/91${digits}` : null;
}

function leadBucketForTab(lead: Lead): LeadTab {
  if (lead.status === "Fresh Lead") return lead.assignedToId || lead.assignedTo ? "assigned" : "fresh";
  return lead.status === "Assigned to Sales" ? "assigned" : "all";
}

const TABS: { id: LeadTab; label: string }[] = [
  { id: "fresh", label: "Fresh Leads to Call" },
  { id: "assigned", label: "Assigned to Sales" },
  { id: "callback", label: "Call Back" },
  { id: "mine", label: "My Leads" },
  { id: "all", label: "All Leads" },
];

type LeadsResponse = {
  error?: string;
  leads: Lead[];
  total: number;
  tabCounts: Record<LeadTab, number>;
  todaysFollowUps?: number;
  hasAnyLeads?: boolean;
};

function isLeadsResponse(value: unknown): value is LeadsResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<LeadsResponse>;
  const counts = response.tabCounts;
  return Array.isArray(response.leads) &&
    typeof response.total === "number" &&
    !!counts &&
    TABS.every(({ id }) => Number.isInteger(counts[id]) && counts[id] >= 0);
}

export function LeadsClient({ user, leads, executives, assignees, assigneesUnavailable, owners, canAssign, fixableLeads, initialTab, initialCount, tabCounts: initialTabCounts, todaysFollowUps: initialFollowUps, hasAnyLeads: initialHasAnyLeads }: Props) {
  const [leadRows, setLeadRows] = useState(leads);
  const [teamMembers, setTeamMembers] = useState(assignees);
  const [teamMembersUnavailable, setTeamMembersUnavailable] = useState(assigneesUnavailable);
  const [retryingTeamMembers, setRetryingTeamMembers] = useState(false);
  const [total, setTotal] = useState(initialCount);
  const [tabCounts, setTabCounts] = useState(initialTabCounts);
  const [todaysFollowUps, setTodaysFollowUps] = useState(initialFollowUps);
  const [hasAnyLeads, setHasAnyLeads] = useState(initialHasAnyLeads);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [justAdded, setJustAdded] = useState<Lead | null>(null);
  const isExec = user.role === "Sales Executive";
  const [tab, setTab] = useState<LeadTab>(initialTab);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [source, setSource] = useState<LeadSource | "All">("All");
  const [filters, setFilters] = useState<LeadFilters>({ stage: "All", owner: "All" });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pendingAddedId, setPendingAddedId] = useState<string | null>(null);
  const [highlightedLeadId, setHighlightedLeadId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [action, setAction] = useState<LeadAction>(null);
  const leadOverrides = useRef(new Map<string, Partial<Lead> | null>());
  const applyLeadOverrides = useCallback((rows: Lead[]) => rows.flatMap((lead) => {
    if (!leadOverrides.current.has(lead.id)) return [lead];
    const override = leadOverrides.current.get(lead.id);
    if (override === null) return [];
    return [{ ...lead, ...override }];
  }), []);
  const selectLead = useCallback((lead: Lead) => setSelected(lead), []);
  const startLeadAction = useCallback((type: "call" | "edit" | "reassign" | "delete", lead: Lead) => {
    const current = leadRows.find((item) => item.id === lead.id) ?? lead;
    const override = leadOverrides.current.get(lead.id);
    setAction({ type, lead: override ? { ...current, ...override } : current });
  }, [leadRows]);
  const reloadTeamMembers = useCallback(async () => {
    if (retryingTeamMembers) return;
    setRetryingTeamMembers(true);
    try {
      const result = await getAssignableUsersAction();
      if (!result.ok) {
        setTeamMembers([]);
        setTeamMembersUnavailable(true);
        toast.error(result.error);
        return;
      }
      const members = result.data ?? [];
      setTeamMembers(members);
      setTeamMembersUnavailable(members.length === 0);
      if (!members.length) toast.error("No active team members were returned. Please retry or contact an administrator.");
      else toast.success("Team members loaded");
    } catch (error) {
      setTeamMembers([]);
      setTeamMembersUnavailable(true);
      toast.error(error instanceof Error ? error.message : "Could not load team members.");
    } finally {
      setRetryingTeamMembers(false);
    }
  }, [retryingTeamMembers]);

  const mergedLeadRows = useMemo(() => {
    if (!justAdded) return leadRows;
    const updatedAdded = leadRows.find((lead) => lead.id === justAdded.id) ?? justAdded;
    return [updatedAdded, ...leadRows.filter((lead) => lead.id !== justAdded.id)];
  }, [justAdded, leadRows]);

  useEffect(() => {
    setLeadRows(applyLeadOverrides(leads));
    if (justAdded && leads.some((lead) => lead.id === justAdded.id)) setJustAdded(null);
  }, [leads, justAdded, applyLeadOverrides]);
  useEffect(() => {
    setTotal(initialCount);
    setTabCounts(initialTabCounts);
    setTodaysFollowUps(initialFollowUps);
    setHasAnyLeads(initialHasAnyLeads);
  }, [initialCount, initialTabCounts, initialFollowUps, initialHasAnyLeads]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    tabListRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [tab]);
  useEffect(() => {
    if (!pendingAddedId || !leadRows.some((lead) => lead.id === pendingAddedId)) return;
    const added = leadRows.find((lead) => lead.id === pendingAddedId);
    if (!added) return;
    setAdding(false);
    setPendingAddedId(null);
    setTab(user.role === "Manager" ? "all" : leadBucketForTab(added));
    setHighlightedLeadId(added.id);
    window.setTimeout(() => setHighlightedLeadId(null), 4000);
    window.requestAnimationFrame(() => (document.getElementById("leads-list-mobile") ?? document.getElementById("leads-list"))?.scrollIntoView({ behavior: "smooth", block: "start" }));
    toast.success("Lead added", {
      action: {
        label: "View lead",
        onClick: () => {
          setSelected(added);
          setTab(leadBucketForTab(added));
        },
      },
    });
  }, [isExec, leadRows, pendingAddedId, user.role]);

  const visible = mergedLeadRows;
  const requestPage = useCallback(async (requestedPage: number, append: boolean, isCurrent: () => boolean = () => true, requestedTab = tab) => {
    const params = new URLSearchParams({
      tab: requestedTab, page: String(requestedPage), search: debouncedSearch, source,
      owner: filters.owner ?? "All", stage: filters.stage ?? "All",
    });
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    const response = await fetch(`/api/leads?${params.toString()}`, { cache: "no-store" });
    const body = await response.text();
    let result: unknown;
    try {
      result = JSON.parse(body);
    } catch {
      console.error("[leads] GET /api/leads response", { status: response.status, body });
      throw new Error("Unable to load leads right now.");
    }
    if (!response.ok || !isLeadsResponse(result)) {
      console.error("[leads] GET /api/leads response", { status: response.status, body: result });
      const error = result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error
        : "Unable to load leads right now.";
      throw new Error(error);
    }
    if (result.leads.length === 0) {
      console.info("[leads] GET /api/leads response", { status: response.status, body: result });
    }
    if (!isCurrent()) return;
    setLeadRows((current) => applyLeadOverrides(append
      ? [...current, ...result.leads.filter((lead) => !current.some((item) => item.id === lead.id))]
      : result.leads));
    setTotal(result.total);
    setTabCounts(result.tabCounts);
    setTodaysFollowUps(result.todaysFollowUps ?? 0);
    setHasAnyLeads(result.hasAnyLeads ?? false);
  }, [tab, debouncedSearch, source, filters, applyLeadOverrides]);
  const runRequest = useCallback(async function runRequest(requestedPage: number, append: boolean, isCurrent: () => boolean = () => true) {
    if (append) setLoadingMore(true);
    else setLoadingRows(true);
    try {
      await requestPage(requestedPage, append, isCurrent);
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : "Unable to load leads right now.";
        toast.error(message, {
          action: { label: "Retry", onClick: () => { if (isCurrent()) void runRequest(requestedPage, append, isCurrent); } },
        });
      }
    } finally {
      if (isCurrent()) {
        setLoadingRows(false);
        setLoadingMore(false);
      }
    }
  }, [requestPage]);
  const initializedQuery = useRef(false);
  useEffect(() => {
    if (!initializedQuery.current) {
      initializedQuery.current = true;
      return;
    }
    let active = true;
    void runRequest(1, false, () => active);
    return () => { active = false; };
  }, [runRequest]);
  const loadMore = async () => {
    await runRequest(Math.floor(leadRows.length / 50) + 1, true);
  };
  const availableTabs = TABS.filter((item) =>
    user.role === "Calling Team" ? item.id === "fresh" || item.id === "callback"
    : !(item.id === "fresh" && isExec) && !(item.id === "all" && user.role !== "Manager"));
  const count = (id: LeadTab) => tabCounts[id] ?? 0;
  const fixableCount = fixableLeads.length;
  const activeFilterCount = [source !== "All", filters.owner !== "All", filters.stage !== "All", !!filters.from, !!filters.to].filter(Boolean).length;

  return (
    <div className="space-y-4 text-sm max-[480px]:space-y-3 max-[480px]:pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="w-full">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold sm:text-2xl sm:font-bold">Manage Leads</h1>
            <Button className="sm:hidden" onClick={() => setAdding((value) => !value)}><Plus /> Add</Button>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground"> <span className="sm:hidden">Assign ownership and track follow-ups.</span><span className="hidden sm:inline">Review enquiries, assign ownership, and track follow-ups.</span></p>
          {(user.role === "Manager" || user.role === "Calling Team") && <p className="mt-1 text-[13px] text-muted-foreground sm:hidden">Today&apos;s follow-ups: {todaysFollowUps}</p>}
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <Button className="hidden h-11 shrink-0 sm:inline-flex" onClick={() => setAdding((value) => !value)}><Plus /> Add Lead</Button>
          {(user.role === "Manager" || user.role === "Calling Team") && <span className="rounded-full bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground max-[480px]:hidden">Today&apos;s follow-ups: {todaysFollowUps}</span>}
          {user.role === "Manager" && fixableCount > 0 && <span className="max-[480px]:hidden"><FixAssignedLeads leads={fixableLeads} count={fixableCount} /></span>}
        </div>
      </div>

      {user.role === "Manager" && fixableCount > 0 && <div className="hidden min-w-0 items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 max-[480px]:flex"><span className="min-w-0 truncate">{fixableCount} assigned lead{fixableCount === 1 ? "" : "s"} still in Fresh</span><FixAssignedLeads leads={fixableLeads} count={fixableCount} compact /></div>}

      <div className="relative -mx-1">
      <div ref={tabListRef} className="flex gap-2 overflow-x-auto p-1 max-[480px]:scrollbar-none" role="tablist" aria-label="Lead views">
        {availableTabs.map((item) => (
          <button
            key={item.id}
            id={`lead-tab-${item.id}`}
            data-tab={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`h-11 shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item.id ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
          >
            <span className="max-[480px]:hidden">{item.label}</span><span className="hidden max-[480px]:inline">{item.id === "fresh" ? "Fresh" : item.id === "assigned" ? "Assigned" : item.label}</span> <span className="ml-1 opacity-75">({count(item.id)})</span>
          </button>
        ))}
      </div>
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

      {adding && <AddLead onAdded={(lead) => {
        setLeadRows((current) => current.some((item) => item.id === lead.id) ? current : [lead, ...current]);
        setJustAdded(lead);
        setPendingAddedId(lead.id);
        const targetTab = user.role === "Manager" ? "all" : isExec ? "mine" : leadBucketForTab(lead);
        setTab(targetTab);
        setAdding(false);
        setHighlightedLeadId(lead.id);
        window.requestAnimationFrame(() => {
          (document.getElementById("leads-list-mobile") ?? document.getElementById("leads-list"))?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        void requestPage(1, false, () => true, targetTab).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Unable to refresh leads."),
        );
      }} onCancel={() => setAdding(false)} assignees={teamMembers} assigneesUnavailable={teamMembersUnavailable} retryingAssignees={retryingTeamMembers} onRetryAssignees={() => void reloadTeamMembers()} canAssign={canAssign} canForceDuplicate={user.role === "Manager"} />}

      {visible.length === 0 ? (
        loadingRows
          ? <div role="status" className="space-y-2"><div className="h-20 animate-pulse rounded-xl bg-card" /><div className="h-20 animate-pulse rounded-xl bg-card" /></div>
          : <EmptyState hasLeads={hasAnyLeads} filtered={!!debouncedSearch || source !== "All" || filters.owner !== "All" || filters.stage !== "All" || !!filters.from || !!filters.to} onClear={() => { setSearch(""); setSource("All"); setFilters({ owner: "All", stage: "All" }); }} />
      ) : (
        <>
          <div id="leads-list" className="hidden overflow-x-auto rounded-xl border border-border bg-card shadow-sm md:block">
            <table className="w-full min-w-[1000px] text-left">
              <thead className="bg-secondary text-xs uppercase tracking-wide text-secondary-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">Lead</th><th className="px-3 py-3 font-semibold">Phone</th>
                  <th className="px-3 py-3 font-semibold">Source</th><th className="px-3 py-3 font-semibold">Created</th>
                  <th className="px-3 py-3 font-semibold">Status</th><th className="px-3 py-3 font-semibold">Owner</th><th className="sticky right-0 z-10 min-w-[200px] whitespace-nowrap bg-secondary px-2 py-3 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((lead) => <DesktopRow key={lead.id} lead={lead} manager={user.role === "Manager"} highlighted={highlightedLeadId === lead.id} onOpen={selectLead} onAction={startLeadAction} />)}
              </tbody>
            </table>
          </div>
          <div id="leads-list-mobile" className="space-y-2 max-[480px]:space-y-1.5 md:hidden">
            {visible.map((lead) => <MobileRow key={lead.id} lead={lead} manager={user.role === "Manager"} highlighted={highlightedLeadId === lead.id} onOpen={selectLead} onAction={startLeadAction} />)}
          </div>
          {leadRows.length < total && <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">Showing {leadRows.length} of {total} leads</p>
            <Button type="button" variant="outline" className="h-11" disabled={loadingMore || loadingRows} onClick={loadMore}>{loadingMore ? "Loading…" : "Load more"}</Button>
          </div>}
          {loadingRows && <p role="status" className="text-center text-xs text-muted-foreground">Updating lead results…</p>}
        </>
      )}

      {selected && (
        <LeadDrawer
          lead={selected}
          executives={executives}
          canAssign={canAssignLeads(user.role)}
          onClose={() => setSelected(null)}
          onSaved={() => {
            const fresh = leadRows.find((lead) => lead.id === selected.id);
            if (fresh) setSelected(fresh);
          }}
          onNext={selectLead}
          nextLead={visible[visible.findIndex((lead) => lead.id === selected.id) + 1]}
        />
      )}
      {action?.type === "call" && <CallLeadModal lead={action.lead} onClose={() => setAction(null)} onSaved={(status, followUp) => {
        setAction(null);
        void requestPage(1, false)
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Unable to refresh leads."))
          .finally(() => setLeadRows((current) => current.map((lead) => lead.id === action.lead.id
            ? { ...lead, status, ...(followUp ? { followUp } : {}) }
            : lead)));
      }} />}
      {action && action.type !== "call" && <LeadActionModal key={`${action.type}:${action.lead.id}`} action={action} assignees={teamMembers} assigneesUnavailable={teamMembersUnavailable} retryingAssignees={retryingTeamMembers} onRetryAssignees={() => void reloadTeamMembers()} onClose={() => setAction(null)} onDone={(patch) => {
        const effectivePatch = {
          ...(leadOverrides.current.get(action.lead.id) ?? {}),
          ...patch,
        };
        leadOverrides.current.set(action.lead.id, action.type === "delete" ? null : effectivePatch);
        setJustAdded((current) => current?.id !== action.lead.id
          ? current
          : action.type === "delete" ? null : { ...current, ...effectivePatch });
        setLeadRows((current) => applyLeadOverrides(action.type === "delete"
          ? current
          : current.map((lead) => lead.id === action.lead.id ? { ...lead, ...effectivePatch } : lead)));
        setAction(null);
        void requestPage(1, false)
          .then(() => setLeadRows((current) => action.type === "delete"
            ? current.filter((lead) => lead.id !== action.lead.id)
            : current.map((lead) => lead.id === action.lead.id ? { ...lead, ...patch } : lead)))
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Unable to refresh leads."));
      }} onAssigned={(name) => {
        const patch: Partial<Lead> = {
          assignedTo: name,
          status: action.lead.status === "Fresh Lead" ? "Assigned to Sales" : action.lead.status,
        };
        const effectivePatch = { ...(leadOverrides.current.get(action.lead.id) ?? {}), ...patch };
        leadOverrides.current.set(action.lead.id, effectivePatch);
        setJustAdded((current) => current?.id === action.lead.id ? { ...current, ...effectivePatch } : current);
        setLeadRows((current) => applyLeadOverrides(current.map((lead) => lead.id === action.lead.id
          ? { ...lead, ...effectivePatch }
          : lead)));
        setAction(null);
        setTab("assigned");
        void requestPage(1, false, () => true, "assigned").catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Unable to refresh leads."),
        );
        toast.success(`Assigned to ${name}. Moved to Assigned to Sales`, { action: { label: "Open tab", onClick: () => setTab("assigned") } });
      }} />}
    </div>
  );
}

function ActionButtons({ lead, manager, onAction }: { lead: Lead; manager: boolean; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  const whatsapp = whatsappUrl(lead.phone);
  return <div className="flex justify-end gap-2 whitespace-nowrap">
    {lead.phone && <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Call ${lead.name}`} title={`Call ${lead.name}`} onClick={() => onAction("call")}><Phone /></Button>}
    {whatsapp && <a href={whatsapp} target="_blank" rel="noreferrer" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-secondary" aria-label={`Message ${lead.name} on WhatsApp`} title="WhatsApp" onClick={(event) => event.stopPropagation()}><WhatsAppIcon className="h-5 w-5" /></a>}
    <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Edit ${lead.name}`} title={`Edit ${lead.name}`} onClick={() => onAction("edit")}><Pencil /></Button>
    {manager && <><Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Reassign ${lead.name}`} title={`Assign owner for ${lead.name}`} onClick={() => onAction("reassign")}><UserRound /></Button><Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Delete ${lead.name}`} title={`Delete ${lead.name}`} onClick={() => onAction("delete")}><Trash2 /></Button></>}
  </div>;
}

function DesktopActionButtons({ lead, manager, onAction }: { lead: Lead; manager: boolean; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  const whatsapp = whatsappUrl(lead.phone);
  return <div className="flex justify-end gap-2 whitespace-nowrap">
    {lead.phone && <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Call ${lead.name}`} title={`Call ${lead.name}`} onClick={() => onAction("call")}><Phone /></Button>}
    {whatsapp && <a className="grid h-9 w-9 place-items-center rounded-lg hover:bg-secondary" href={whatsapp} target="_blank" rel="noreferrer" aria-label={`Message ${lead.name} on WhatsApp`} title="WhatsApp" onClick={(event) => event.stopPropagation()}><WhatsAppIcon className="h-5 w-5" /></a>}
    <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Edit ${lead.name}`} title={`Edit ${lead.name}`} onClick={() => onAction("edit")}><Pencil /></Button>
    {manager && <><Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Reassign ${lead.name}`} title={`Assign owner for ${lead.name}`} onClick={() => onAction("reassign")}><UserRound /></Button><Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={`Delete ${lead.name}`} title={`Delete ${lead.name}`} onClick={() => onAction("delete")}><Trash2 /></Button></>}
  </div>;
}

const DesktopRow = memo(function DesktopRow({ lead, manager, highlighted, onOpen, onAction }: { lead: Lead; manager: boolean; highlighted: boolean; onOpen: (lead: Lead) => void; onAction: (type: "call" | "edit" | "reassign" | "delete", lead: Lead) => void }) {
  return (
    <tr className={`group cursor-pointer transition-colors hover:bg-secondary/50 ${highlighted ? "bg-success/10 ring-1 ring-inset ring-success" : ""}`} onClick={() => onOpen(lead)}>
      <td className="max-w-56 px-4 py-3"><div className="truncate font-semibold">{lead.name}</div>{lead.company && <div className="truncate text-xs text-muted-foreground">{lead.company}</div>}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.phone || "—"}</td>
      <td className="whitespace-nowrap px-3 py-3">{lead.source}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.createdOn || "—"}</td>
      <td className="px-3 py-3"><StatusBadge status={lead.status} />{lead.followUp && lead.followUp <= todayIST() && <div className="mt-1 text-xs font-semibold text-destructive">Overdue</div>}</td>
      <td className="max-w-36 truncate px-3 py-3">{lead.assignedTo ?? "Unassigned"}</td>
      <td className="sticky right-0 z-[1] min-w-[200px] whitespace-nowrap bg-card px-2 py-3 text-right group-hover:bg-secondary/50" onClick={(event) => event.stopPropagation()}><DesktopActionButtons lead={lead} manager={manager} onAction={(type) => onAction(type, lead)} /></td>
    </tr>
  );
});

const MobileRow = memo(function MobileRow({ lead, manager, highlighted, onOpen, onAction }: { lead: Lead; manager: boolean; highlighted: boolean; onOpen: (lead: Lead) => void; onAction: (type: "call" | "edit" | "reassign" | "delete", lead: Lead) => void }) {
  const wa = whatsappUrl(lead.phone);
  return (
    <div role="button" tabIndex={0} onClick={() => onOpen(lead)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(lead); } }} className={`rounded-xl border border-border bg-card p-4 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${highlighted ? "bg-success/10 ring-1 ring-success" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="truncate font-semibold">{lead.name}</div><div className="truncate text-xs text-muted-foreground">{lead.company || "No company"}</div></div>
        <StatusBadge status={lead.status} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-y-1 text-xs text-muted-foreground max-[480px]:mt-2"><span className="inline-flex min-h-11 items-center truncate">{lead.phone || "No phone"}</span><span>{lead.source}</span><span>{lead.createdOn || "No date"}</span><span className="truncate">{lead.assignedTo ?? "Unassigned"}</span>{lead.followUp && lead.followUp <= todayIST() && <span className="font-semibold text-destructive">Overdue</span>}</div>
      {wa && <a className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#25D366] px-3 text-sm font-semibold text-[#128C7E] max-[480px]:mt-2" href={wa} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label={`Message ${lead.name} on WhatsApp`}><WhatsAppIcon className="h-5 w-5" />WhatsApp</a>}
      <div className="mt-3 max-[480px]:mt-2" onClick={(event) => event.stopPropagation()}><ActionButtons lead={lead} manager={manager} onAction={(type) => onAction(type, lead)} /></div>
    </div>
  );
});

function EmptyState({ hasLeads, filtered, onClear }: { hasLeads: boolean; filtered: boolean; onClear: () => void }) {
  const title = filtered ? "No leads match your filters" : hasLeads ? "No leads in this view" : "No leads yet";
  const detail = filtered ? "Try a different search or source." : hasLeads ? "New enquiries will appear here." : "Add a lead to get started.";
  return <div className="rounded-xl border border-dashed border-border bg-card px-5 py-12 text-center"><div className="text-base font-semibold">{title}</div><p className="mt-1 text-muted-foreground">{detail}</p>{filtered && <Button variant="outline" className="mt-4" onClick={onClear}>Clear filters</Button>}</div>;
}

function FixAssignedLeads({ count, compact = false, leads = [] }: { count: number; compact?: boolean; leads?: { id: string; name: string; ownerName: string }[] }) {
  const [pending, start] = useTransition();
  const fix = () => {
    const leadSummary = leads.length <= 3
      ? leads.map((lead) => `${lead.name} (${lead.ownerName || "Sales Executive"})`).join("\n")
      : `${leads.slice(0, 3).map((lead) => lead.name).join(", ")}, and ${leads.length - 3} more`;
    if (!window.confirm(`Confirm correction for:\n${leadSummary}\n\nChange Lead_Status from Fresh Lead to Assigned to Sales only.`)) return;
    start(async () => {
      const result = await fixAssignedLeadsAction();
      if (result.ok) toast.success(`${result.data?.changed ?? 0} assigned leads fixed`);
      else toast.error(result.error);
    });
  };
  return <Button title="Moves leads that have a sales executive but are still in Fresh Lead to Assigned to Sales." variant={compact ? "ghost" : "outline"} className={compact ? "min-w-11 px-2 font-medium underline" : "max-[480px]:text-xs"} onClick={fix} disabled={pending || count === 0}>{pending ? "Fixing…" : compact ? "Fix" : `Fix assigned leads (${count})`}</Button>;
}

function LeadFiltersPanel({ open, owners, filters, source, onChange, onSourceChange, onClose }: {
  open: boolean; owners: string[]; filters: LeadFilters; source: LeadSource | "All";
  onChange: (filters: LeadFilters) => void; onSourceChange: (source: LeadSource | "All") => void; onClose: () => void;
}) {
  useBodyScrollLock(open);
  const content = <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
    <label className="text-xs font-semibold">Owner<SelectField className="mt-1" value={filters.owner ?? "All"} onValueChange={(value) => onChange({ ...filters, owner: value })} options={[{ value: "All", label: "All owners" }, ...owners.map((owner) => ({ value: owner, label: owner }))]} /></label>
    <label className="text-xs font-semibold">Stage<SelectField className="mt-1" value={filters.stage ?? "All"} onValueChange={(value) => onChange({ ...filters, stage: value as LeadStatus | "All" })} options={[{ value: "All", label: "All stages" }, ...LEAD_STATUSES.map((stage) => ({ value: stage, label: stage }))]} /></label>
    <label className="text-xs font-semibold">Source<SelectField className="mt-1" value={source} onValueChange={(value) => onSourceChange(value as LeadSource | "All")} options={[{ value: "All", label: "All sources" }, ...LEAD_SOURCES.map((item) => ({ value: item, label: item }))]} /></label>
    <label className="text-xs font-semibold">From<input type="date" className={`${fieldClass} mt-1 text-sm`} value={filters.from ?? ""} onChange={(e) => onChange({ ...filters, from: e.target.value })} /></label>
    <label className="text-xs font-semibold">To<input type="date" className={`${fieldClass} mt-1 text-sm`} value={filters.to ?? ""} onChange={(e) => onChange({ ...filters, to: e.target.value })} /></label>
  </div>;
  return <>
    <div className="hidden rounded-lg border bg-card p-3 sm:block">{content}</div>
    {open && <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:hidden"><button className="absolute inset-0" aria-label="Close filters" onClick={onClose} /><div className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-card"><div className="overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Filter leads</h2><Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close filters"><X /></Button></div>{content}<Button className="mt-4 w-full" onClick={onClose}>Apply filters</Button></div></div></div>}
  </>;
}

function LeadActionModal({ action, assignees, assigneesUnavailable, retryingAssignees, onRetryAssignees, onClose, onDone, onAssigned }: {
  action: LeadMutationAction; assignees: { id: string; name: string }[]; assigneesUnavailable: boolean; retryingAssignees: boolean; onRetryAssignees: () => void; onClose: () => void; onDone: (patch: Partial<Lead>) => void; onAssigned: (name: string) => void;
}) {
  useBodyScrollLock(true);
  const [pending, start] = useTransition();
  const [name, setName] = useState(action.lead.name);
  const [company, setCompany] = useState(action.lead.company);
  const [phone, setPhone] = useState(action.lead.phone);
  const [source, setSource] = useState<LeadSource>(action.lead.source);
  const [status, setStatus] = useState<LeadStatus>(action.lead.status);
  const [assignee, setAssignee] = useState("");
  const [remarks, setRemarks] = useState(action.type === "edit" ? action.lead.remarks : "");
  const [followUp, setFollowUp] = useState(action.lead.followUp ?? "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    start(async () => {
      const result = action.type === "edit"
        ? await updateLeadAction({ id: action.lead.id, name, company, phone, source, status, remarks, ...(followUp ? { followUp } : {}) })
        : action.type === "reassign"
          ? await reassignLeadAction({ id: action.lead.id, assignedToId: assignee })
          : await deleteLeadAction({ id: action.lead.id });
      if (!result.ok) { toast.error(result.error); return; }
      if (action.type === "reassign") {
        const assignment = result.data as { owner?: string; taskWarning?: string } | undefined;
        if (assignment?.taskWarning) toast.warning(`${assignment.taskWarning}. The owner update is saved.`);
        onAssigned(assignment?.owner ?? assignee);
      }
      else {
        toast.success(action.type === "delete" ? "Lead deleted" : "Lead updated");
        onDone(action.type === "edit" ? { name, company, phone, source, status, remarks, ...(followUp ? { followUp } : {}) } : {});
      }
    });
  };

  const title = action.type === "edit" ? "Edit lead" : action.type === "reassign" ? "Reassign owner" : "Delete lead";
  return <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 md:items-center md:p-4" role="presentation">
    <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />
    <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="lead-action-title" className="relative max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl md:rounded-xl md:pb-5">
      <div className="flex items-start justify-between gap-3"><div><h2 id="lead-action-title" className="text-lg font-bold">{title}</h2><p className="text-sm text-muted-foreground">{action.lead.name}</p></div><Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button></div>
      {action.type === "edit" && <div className="grid gap-3">
        <label className="font-medium">Name<input className={`${fieldClass} mt-1 text-sm`} value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
        <label className="font-medium">Company<input className={`${fieldClass} mt-1 text-sm`} value={company} onChange={(event) => setCompany(event.target.value)} maxLength={160} /></label>
        <label className="font-medium">Phone<input className={`${fieldClass} mt-1 text-sm`} value={phone} onChange={(event) => setPhone(event.target.value)} required inputMode="tel" pattern="(?:\+91\s?)?\d{10}" title="Enter a 10-digit phone number" /></label>
        <label className="font-medium">Source<SelectField className="mt-1" value={source} onValueChange={(value) => setSource(value as LeadSource)} options={LEAD_SOURCES.map((item) => ({ value: item, label: item }))} /></label>
        <label className="font-medium">Status<SelectField className="mt-1" value={status} onValueChange={(value) => setStatus(value as LeadStatus)} options={LEAD_STATUSES.map((item) => ({ value: item, label: item }))} /></label>
        <label className="font-medium">Follow-up date<input type="date" className={`${fieldClass} mt-1 text-sm`} value={followUp} onChange={(event) => setFollowUp(event.target.value)} /></label>
        <label className="font-medium">Remarks<textarea className={`${fieldClass} mt-1 h-24 py-2 text-sm`} value={remarks} onChange={(event) => setRemarks(event.target.value)} maxLength={500} /></label>
      </div>}
      {action.type === "reassign" && <>
        <label className="block font-medium">Assign to<select className={`${fieldClass} mt-1 text-sm`} value={assignee} onChange={(event) => setAssignee(event.target.value)} required disabled={assigneesUnavailable}>
          {assigneesUnavailable
            ? <option value="" disabled>Couldn&apos;t load team members</option>
            : <><option value="">Select a team member</option>{assignees.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</>}
        </select></label>
        {assigneesUnavailable && <Button type="button" variant="outline" className="h-9" onClick={onRetryAssignees} disabled={retryingAssignees}>{retryingAssignees ? "Retrying…" : "Retry loading team members"}</Button>}
      </>}
      {action.type === "delete" && <p className="rounded-md bg-destructive/10 p-3 text-sm">Delete {action.lead.name}? This can&apos;t be undone.</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" variant={action.type === "delete" ? "destructive" : "default"} disabled={pending || (action.type === "reassign" && !assignee)}>{pending ? "Saving..." : action.type === "delete" ? "Delete" : action.type === "reassign" ? "Confirm" : "Save"}</Button></div>
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const drawerRef = useRef<HTMLDivElement>(null);
  const filteredExecutives = executives.filter((name) => name.toLowerCase().includes(assigneeSearch.toLowerCase()));
  useBodyScrollLock(true);

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
    if (historyLoading || (history !== null && !historyError)) return;
    setHistoryLoading(true);
    setHistoryError(null);
    void getLeadTimelineAction(lead.id).then((result) => {
      if (result.ok) setHistory(result.data ?? []);
      else {
        setHistory(null);
        setHistoryError(result.error);
        toast.error(result.error);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not load lead history.";
      setHistory(null);
      setHistoryError(message);
      toast.error(message);
    }).finally(() => setHistoryLoading(false));
  };

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button className="absolute inset-0 cursor-default bg-black/40" aria-label="Close lead details" onClick={onClose} />
      <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="lead-drawer-title" className="absolute bottom-0 left-0 flex h-[92dvh] w-full flex-col rounded-t-2xl bg-card shadow-2xl focus-visible:outline-none md:bottom-auto md:left-auto md:right-0 md:top-0 md:h-full md:max-w-lg md:rounded-none">
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
            <HistoryList history={history} loading={historyLoading} error={historyError} onRetry={loadHistory} />
          ) : mode === "schedule" ? (
            <ScheduleForm lead={lead} onDone={() => setMode("edit")} />
          ) : (
            <div className="space-y-4">
              <label className="block font-medium">Status<SelectField className="mt-1" value={status} onValueChange={(value) => setStatus(value as LeadStatus)} options={LEAD_STATUSES.map((item) => ({ value: item, label: item }))} /></label>
              {canAssign && <label className="relative block font-medium">Assign to Sales Executive
                <button type="button" role="combobox" aria-expanded={comboboxOpen} aria-controls="lead-executive-options" className={`${fieldClass} mt-1 flex items-center justify-between text-left text-sm`} onClick={() => setComboboxOpen((value) => !value)} disabled={!executives.length}><span className={assignee ? "text-foreground" : "text-muted-foreground"}>{assignee || "Unassigned"}</span><Search className="h-4 w-4" /></button>
                {comboboxOpen && <div id="lead-executive-options" role="listbox" className="absolute z-10 mt-1 max-h-52 w-full overflow-auto rounded-md border bg-card p-1 shadow-lg">
                  <input autoFocus className={`${fieldClass} text-sm`} placeholder="Search executives…" value={assigneeSearch} onChange={(event) => setAssigneeSearch(event.target.value)} aria-label="Search executives" />
                  <button type="button" role="option" aria-selected={!assignee} className="mt-1 block min-h-11 w-full rounded-lg px-2 py-2 text-left text-sm font-medium hover:bg-secondary" onClick={() => { setAssignee(""); setComboboxOpen(false); }}>Unassigned</button>
                  {filteredExecutives.map((name) => <button key={name} type="button" role="option" aria-selected={assignee === name} className="mt-1 block min-h-11 w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-secondary" onClick={() => { setAssignee(name); setComboboxOpen(false); }}>{name}</button>)}
                  {!executives.length && <p className="p-2 text-xs text-destructive">No sales executives found. A manager must check ZOHO_ROLE_OVERRIDES / Zoho roles.</p>}
                  {!!executives.length && !filteredExecutives.length && <p className="p-2 text-xs text-muted-foreground">No executives match your search.</p>}
                </div>}
              </label>}
              <label className="block font-medium">Remarks<textarea className={`${fieldClass} mt-1 h-28 py-2 text-sm`} placeholder="Add a note about this lead…" value={remarks} onChange={(event) => setRemarks(event.target.value)} maxLength={500} /></label>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button disabled={pending} onClick={() => save()}>{pending ? "Saving…" : "Save"}</Button>
                <Button variant="outline" disabled={pending || !nextLead} onClick={() => save(true)}>{pending ? "Saving…" : "Save & next"}</Button>
              </div>
              <div className="grid gap-2 border-t pt-4 sm:grid-cols-2">
                <Button variant="outline" onClick={loadHistory}><History /> History</Button>
                <Button variant="outline" onClick={() => setMode("schedule")}><CalendarPlus /> Schedule visit</Button>
                <Button asChild variant="secondary" className="sm:col-span-2"><Link href={`/quotations?lead=${lead.id}`} onClick={onClose}><Clock3 /> Create quotation</Link></Button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function DrawerTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`flex h-11 items-center gap-1 border-b-2 px-2 text-sm font-semibold ${active ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`} onClick={onClick}>{children}</button>;
}

function HistoryList({ history, loading, error, onRetry }: { history: LeadTimelineItem[] | null; loading: boolean; error: string | null; onRetry: () => void }) {
  if (loading) return <p role="status" className="text-muted-foreground">Loading history…</p>;
  if (error) return <div role="alert" className="space-y-3 rounded-lg bg-destructive/5 p-4"><p>{error}</p><Button type="button" variant="outline" onClick={onRetry}>Retry</Button></div>;
  if (history === null) return <div role="alert" className="space-y-3 rounded-lg bg-destructive/5 p-4"><p>Could not load lead history.</p><Button type="button" variant="outline" onClick={onRetry}>Retry</Button></div>;
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
    <SelectField aria-label="Type" value={f.type} onValueChange={(value) => setF({ ...f, type: value })} options={VISIT_TYPES.map((item) => ({ value: item, label: item }))} />
    <input aria-label="Address" className={`${fieldClass} text-sm`} placeholder="Visit address" value={f.address} maxLength={240} onChange={(event) => setF({ ...f, address: event.target.value })} />
    <input aria-label="Next action" className={`${fieldClass} text-sm`} placeholder="Next action" value={f.nextAction} maxLength={200} onChange={(event) => setF({ ...f, nextAction: event.target.value })} />
    <div className="grid grid-cols-2 gap-2"><input aria-label="Date" type="date" className={`${fieldClass} text-sm`} value={f.date} onChange={(event) => setF({ ...f, date: event.target.value })} /><input aria-label="Time" type="time" className={`${fieldClass} text-sm`} value={f.time} onChange={(event) => setF({ ...f, time: event.target.value })} /></div>
    <input aria-label="Follow-up date" type="date" className={`${fieldClass} text-sm`} value={f.followUp} onChange={(event) => setF({ ...f, followUp: event.target.value })} />
    <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={onDone}>Cancel</Button><Button className="flex-1" onClick={submit} disabled={pending || !f.date || !f.time}>{pending ? "Saving…" : "Schedule"}</Button></div>
  </div>;
}

function AddLead({ onAdded, onCancel, assignees, assigneesUnavailable, retryingAssignees, onRetryAssignees, canAssign, canForceDuplicate }: { onAdded: (lead: Lead) => void; onCancel: () => void; assignees: { id: string; name: string }[]; assigneesUnavailable: boolean; retryingAssignees: boolean; onRetryAssignees: () => void; canAssign: boolean; canForceDuplicate: boolean }) {
  const [f, setF] = useState({ name: "", company: "", phone: "", area: "", source: "Meta Ads" as LeadSource, remarks: "", assignedToId: "" });
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; owner: string; status: string; matchedField?: "Mobile" | "Phone" } | null>(null);
  const [forceCreate, setForceCreate] = useState(false);
  const [flaggedPhone, setFlaggedPhone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const submittedRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useBodyScrollLock(true);
  const close = useCallback(() => {
    setDuplicate(null);
    setForceCreate(false);
    setFlaggedPhone(null);
    onCancel();
  }, [onCancel]);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [close]);
  const set = (key: keyof typeof f) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((prev) => ({ ...prev, [key]: event.target.value }));
  const phoneChanged = (event: React.ChangeEvent<HTMLInputElement>) => {
    set("phone")(event);
    if (shouldClearLeadDuplicate(flaggedPhone, normalizePhone(event.target.value))) {
      setDuplicate(null);
      setForceCreate(false);
      setFlaggedPhone(null);
    }
    setErrors((prev) => ({ ...prev, phone: undefined }));
  };
  const normalizedCurrentPhone = normalizePhone(f.phone);
  const duplicateMatchesPhone = !!flaggedPhone && flaggedPhone === normalizedCurrentPhone;
  return <div className="fixed inset-0 z-[60] flex items-end bg-black/40 md:items-center md:justify-center md:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="add-lead-title" className="flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-2xl md:max-w-2xl md:rounded-2xl">
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
    event.preventDefault();
    if (pending) return;
    const normalizedPhone = f.phone.replace(/\D/g, "").slice(-10);
    const nextErrors = {
      name: f.name.trim() ? undefined : "Lead name is required.",
      phone: /^\d{10}$/.test(normalizedPhone) ? undefined : "Enter a valid 10-digit mobile number.",
    };
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.phone) {
      toast.error(nextErrors.name || nextErrors.phone || "Enter a valid lead.");
      return;
    }
    if (!claimLeadSubmission(submittedRef)) return;
    start(async () => {
      try {
        const result = await addLeadAction({ ...f, phone: normalizedPhone, assignedToId: f.assignedToId || null, forceCreate });
        if (result.ok && result.data) onAdded(result.data);
        else if (!result.ok) {
          if (result.duplicate) {
            setDuplicate(result.duplicate);
            setFlaggedPhone(normalizedPhone);
          } else {
            setDuplicate(null);
            setFlaggedPhone(null);
            setForceCreate(false);
          }
          toast.error(result.error);
          submittedRef.current = false;
        }
      } catch (error) {
        submittedRef.current = false;
        toast.error(error instanceof Error ? error.message : "Unable to add lead. Please try again.");
      }
    });
  }}>
    <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4"><h2 id="add-lead-title" className="font-semibold">Add Lead</h2><Button type="button" variant="ghost" size="icon" className="h-11 w-11" aria-label="Close add lead form" onClick={close}><X /></Button></div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label htmlFor="add-lead-name" className="mb-1 block text-sm font-medium">Lead name *</label><input ref={nameRef} id="add-lead-name" className={`${fieldClass} text-base md:text-sm`} autoComplete="off" aria-invalid={!!errors.name} value={f.name} onChange={set("name")} maxLength={120} required />{errors.name && <p className="mt-1 text-xs text-destructive">{errors.name}</p>}</div>
        <div><label htmlFor="add-lead-company" className="mb-1 block text-sm font-medium">Company</label><input id="add-lead-company" className={`${fieldClass} text-base md:text-sm`} value={f.company} onChange={set("company")} maxLength={160} /></div>
        <div><label htmlFor="add-lead-phone" className="mb-1 block text-sm font-medium">Mobile number *</label><input id="add-lead-phone" className={`${fieldClass} text-base md:text-sm`} aria-invalid={!!errors.phone} value={f.phone} onChange={phoneChanged} inputMode="tel" required maxLength={15} />{errors.phone && <p className="mt-1 text-xs text-destructive">{errors.phone}</p>}</div>
        <div><label htmlFor="add-lead-area" className="mb-1 block text-sm font-medium">Area</label><input id="add-lead-area" className={`${fieldClass} text-base md:text-sm`} value={f.area} onChange={set("area")} maxLength={120} /></div>
        <div><label htmlFor="add-lead-source" className="mb-1 block text-sm font-medium">Source</label><SelectField id="add-lead-source" value={f.source} onValueChange={(value) => setF((current) => ({ ...current, source: value as LeadSource }))} options={LEAD_SOURCES.map((item) => ({ value: item, label: item }))} /></div>
        {canAssign && <div>
          <label htmlFor="add-lead-assignee" className="mb-1 block text-sm font-medium">Assign to</label>
          <SelectField id="add-lead-assignee" disabled={assigneesUnavailable} value={f.assignedToId} onValueChange={(value) => setF((current) => ({ ...current, assignedToId: value }))} options={assigneesUnavailable
            ? [{ value: "", label: "Couldn't load team members", disabled: true }]
            : [{ value: "", label: "Assign to (optional)" }, ...assignees.map(({ id, name }) => ({ value: id, label: name }))]} />
          {assigneesUnavailable && <Button type="button" variant="outline" className="mt-2 h-9" onClick={onRetryAssignees} disabled={retryingAssignees}>{retryingAssignees ? "Retrying…" : "Retry loading team members"}</Button>}
        </div>}
        <div className="sm:col-span-2"><label htmlFor="add-lead-remarks" className="mb-1 block text-sm font-medium">Remarks</label><textarea id="add-lead-remarks" className={`${fieldClass} min-h-11 text-base md:text-sm`} value={f.remarks} onChange={set("remarks")} maxLength={500} /></div>
        {duplicate && duplicateMatchesPhone && <div className="rounded-lg border border-destructive bg-card p-3 text-sm text-destructive sm:col-span-2"><p>A lead with this number already exists: <a className="underline" href={`/leads#lead-${duplicate.id}`}>{duplicate.name}</a></p><p className="mt-1 text-xs text-muted-foreground">Matched on {duplicate.matchedField ?? "phone"} · Owner: {duplicate.owner} · Status: {duplicate.status}</p>        {canForceDuplicate && !forceCreate && <Button type="button" variant="outline" className="mt-2 h-11" onClick={() => setForceCreate(true)}>Create anyway</Button>}</div>}
      </div>
    </div>
    <div className="flex shrink-0 gap-3 border-t border-border bg-card p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
      <Button type="button" variant="outline" className="h-11 flex-1" onClick={close}>Cancel</Button><Button type="submit" className="h-11 flex-1" disabled={pending}>{pending ? "Adding…" : "Add Lead"}</Button>
    </div>
      </form>
    </div>
  </div>;
}
