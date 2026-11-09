"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { CalendarPlus, FileText, History, LoaderCircle, Pencil, Phone, Plus, Search, SlidersHorizontal, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { claimLeadSubmission, shouldClearLeadDuplicate } from "@/lib/lead-form-state";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { clearExpiredAction, isRetryableActionMessage, isSessionExpiredMessage, readExpiredAction, redirectForExpiredSession } from "@/lib/session-recovery";
import { addLeadAction, deleteLeadAction, fixAssignedLeadsAction, getAssignableUsersAction, getAssignmentWarningsAction, getLeadSourcesAction, getLeadTimelineAction, reassignLeadAction, saveLeadUpdateAction, scheduleVisitAction, updateLeadAction } from "@/app/actions/crm";
import {
  LEAD_SOURCES, LEAD_STATUSES, adjustLeadTabCounts, applyLeadOverrides as mergeLeadOverrides, canAssignLeads, leadAssigneeOptions, leadsForTab, normalizePhone, reassignLeadOptimistically, todayIST,
  type Lead, type LeadFilters, type LeadSource, type LeadStatus, type LeadTab, type LeadTimelineItem, type User,
} from "@/lib/domain";

const CallLeadModal = dynamic(
  () => import("@/components/leads/call-lead-modal").then((module) => module.CallLeadModal),
  { ssr: false },
);

type Props = {
  user: User; leads: Lead[]; initialHasMore?: boolean; executives: string[]; assignees: { id: string; name: string }[]; assigneesUnavailable: boolean; owners: string[]; canAssign: boolean;
  leadSources?: LeadSource[]; leadSourcesUnavailable?: boolean;
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
  hasMore?: boolean;
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

export function LeadsClient({ user, leads, initialHasMore = false, executives, assignees, assigneesUnavailable, owners, canAssign, leadSources: initialLeadSources = LEAD_SOURCES, leadSourcesUnavailable = false, fixableLeads, initialTab, initialCount, tabCounts: initialTabCounts, hasAnyLeads: initialHasAnyLeads }: Props) {
  const router = useRouter();
  const [leadRows, setLeadRows] = useState(leads);
  const leadRowsRef = useRef(leadRows);
  leadRowsRef.current = leadRows;
  const [teamMembers, setTeamMembers] = useState(assignees);
  const [teamMembersUnavailable, setTeamMembersUnavailable] = useState(assigneesUnavailable);
  const [retryingTeamMembers, setRetryingTeamMembers] = useState(false);
  const [leadSources, setLeadSources] = useState(initialLeadSources);
  const [leadSourcesUnavailableState, setLeadSourcesUnavailableState] = useState(leadSourcesUnavailable);
  const [retryingLeadSources, setRetryingLeadSources] = useState(false);
  const [total, setTotal] = useState(initialCount);
  const [tabCounts, setTabCounts] = useState(initialTabCounts);
  const [hasAnyLeads, setHasAnyLeads] = useState(initialHasAnyLeads);
  const [hasMoreRows, setHasMoreRows] = useState(initialHasMore);
  const currentPage = useRef(1);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [justAdded, setJustAdded] = useState<Lead | null>(null);
  const isExec = user.role === "Sales Executive";
  const [tab, setTab] = useState<LeadTab>(initialTab);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchFallbackHint, setSearchFallbackHint] = useState(false);
  const searchRequestKey = useRef("");
  const [source, setSource] = useState<LeadSource | "All">("All");
  const [filters, setFilters] = useState<LeadFilters>({ stage: "All", owner: "All" });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const [highlightedLeadId, setHighlightedLeadId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [action, setAction] = useState<LeadAction>(null);
  const leadOverrides = useRef(new Map<string, Partial<Lead> | null>());
  const optimisticLeadRows = useRef(new Map<string, Lead>());
  const optimisticAssignments = useRef(new Map<string, Lead>());
  const optimisticCalls = useRef(new Map<string, Lead>());
  const optimisticAddedLead = useRef<Lead | null>(null);
  const previousServerLeads = useRef(leads);
  const refreshSilently = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);
  useEffect(() => {
    const saved = readExpiredAction<{ type: string; payload: { leadId?: string; actionType?: string } }>();
    if (saved?.type === "add-lead") setAdding(true);
    if (saved?.type === "call-outcome" && saved.payload.leadId) {
      const lead = leadRows.find((candidate) => candidate.id === saved.payload.leadId);
      if (lead) setAction({ type: "call", lead });
    }
    if (saved?.type === "lead-action" && saved.payload.leadId) {
      const lead = leadRows.find((candidate) => candidate.id === saved.payload.leadId);
      const actionType = saved.payload.actionType;
      if (lead && (actionType === "edit" || actionType === "reassign" || actionType === "delete")) {
        setAction({ type: actionType, lead });
      }
    }
  }, [leadRows]);
  const applyLeadOverrides = useCallback((rows: Lead[]) => mergeLeadOverrides(rows, leadOverrides.current), []);
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
  const reloadLeadSources = useCallback(async () => {
    if (retryingLeadSources) return;
    setRetryingLeadSources(true);
    try {
      const result = await getLeadSourcesAction();
      if (!result.ok || !result.data?.length) {
        setLeadSourcesUnavailableState(true);
        toast.error(result.ok ? "No Lead Source values are configured in Zoho." : result.error);
        return;
      }
      setLeadSources(result.data);
      setLeadSourcesUnavailableState(false);
      toast.success("Lead sources loaded");
    } finally {
      setRetryingLeadSources(false);
    }
  }, [retryingLeadSources]);
  const teamLoadAttempted = useRef(false);
  useEffect(() => {
    if (action?.type === "reassign" && !teamMembers.length && teamMembersUnavailable && !teamLoadAttempted.current) {
      teamLoadAttempted.current = true;
      void reloadTeamMembers();
    }
    if (action?.type !== "reassign") teamLoadAttempted.current = false;
  }, [action?.type, teamMembers.length, teamMembersUnavailable, reloadTeamMembers]);

  const mergedLeadRows = useMemo(() => {
    if (!justAdded) return leadRows;
    const updatedAdded = leadRows.find((lead) => lead.id === justAdded.id) ?? justAdded;
    return [updatedAdded, ...leadRows.filter((lead) => lead.id !== justAdded.id)];
  }, [justAdded, leadRows]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 400);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    tabListRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [tab]);
  const visible = useMemo(
    () => leadsForTab(user, mergedLeadRows, tab, search, source, filters),
    [user, mergedLeadRows, tab, search, source, filters],
  );
  const updateLeadOptimistically = useCallback((before: Lead | null, after: Lead | null) => {
    const id = before?.id ?? after?.id;
    if (!id) return;
    const currentTabDelta = (after ? leadsForTab(user, [after], tab, search, source, filters).length : 0) -
      (before ? leadsForTab(user, [before], tab, search, source, filters).length : 0);
    const changedFields = after
      ? Object.fromEntries(Object.entries(after).filter(([key, value]) =>
          !Object.is(before?.[key as keyof Lead], value),
        )) as Partial<Lead>
      : null;
    leadOverrides.current.set(id, changedFields);
    if (after) optimisticLeadRows.current.set(id, after);
    else optimisticLeadRows.current.delete(id);
    setLeadRows((current) => {
      const withoutOriginal = current.filter((lead) => lead.id !== id);
      const updated = after ? [...withoutOriginal, after] : withoutOriginal;
      return updated;
    });
    setTabCounts((current) => adjustLeadTabCounts(user, before, after, current, search, source, filters));
    if (currentTabDelta) setTotal((current) => Math.max(0, current + currentTabDelta));
    setJustAdded((current) => current?.id === id ? after : current);
  }, [user, tab, search, source, filters]);
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
    const serverIds = new Set(result.leads.map((lead) => lead.id));
    const resolvedServerRows = applyLeadOverrides(result.leads);
    const merged = append
      ? [
          ...leadRowsRef.current.filter((lead) => !serverIds.has(lead.id)),
          ...resolvedServerRows,
        ]
      : [...resolvedServerRows];
    for (const [id, lead] of optimisticLeadRows.current) {
      if (!serverIds.has(id) && !merged.some((item) => item.id === id) &&
        leadsForTab(user, [lead], requestedTab, debouncedSearch, source, filters).length > 0) {
        merged.push(lead);
      }
    }
    for (const id of optimisticLeadRows.current.keys()) {
      if (!leadOverrides.current.has(id)) optimisticLeadRows.current.delete(id);
    }
    setLeadRows(merged);
    currentPage.current = requestedPage;
    setHasMoreRows(result.hasMore === true);
    if (leadOverrides.current.size === 0) {
      setTotal(result.total);
      setTabCounts(result.tabCounts);
      setHasAnyLeads(result.hasAnyLeads ?? false);
    }
  }, [tab, debouncedSearch, source, filters, applyLeadOverrides, user]);
  useEffect(() => {
    const changedServerProps = previousServerLeads.current !== leads;
    previousServerLeads.current = leads;
    const incoming = applyLeadOverrides(leads);
    for (const id of optimisticLeadRows.current.keys()) {
      if (!leadOverrides.current.has(id)) optimisticLeadRows.current.delete(id);
    }
    setLeadRows(() => {
      const merged = new Map(incoming.map((lead) => [lead.id, lead]));
      for (const [id, lead] of optimisticLeadRows.current) {
        if (!leads.some((serverLead) => serverLead.id === id) &&
          leadsForTab(user, [lead], tab, search, source, filters).length > 0) {
          merged.set(id, lead);
        }
      }
      return [...merged.values()];
    });
    if (justAdded && leads.some((lead) => lead.id === justAdded.id)) setJustAdded(null);
    if (changedServerProps) {
      setTeamMembers(assignees);
      setTeamMembersUnavailable(assigneesUnavailable);
      setLeadSources(initialLeadSources);
      setLeadSourcesUnavailableState(leadSourcesUnavailable);
    }
  }, [leads, justAdded, applyLeadOverrides, assignees, assigneesUnavailable, initialLeadSources, leadSourcesUnavailable, user, tab, search, source, filters]);
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
  useEffect(() => {
    const refreshVisibleLeads = () => startTransition(() => router.refresh());
    window.addEventListener("atpl:leads-refresh", refreshVisibleLeads);
    return () => window.removeEventListener("atpl:leads-refresh", refreshVisibleLeads);
  }, [router]);

  useEffect(() => {
    const query = debouncedSearch.trim();
    const requestKey = `${tab}:${query}:${source}:${filters.owner}:${filters.stage}:${filters.from ?? ""}:${filters.to ?? ""}`;
    if (query.length < 2 || total <= leadRows.length ||
      leadsForTab(user, mergedLeadRows, tab, query, source, filters).length > 0) {
      setSearchFallbackHint(false);
      if (query.length < 2) searchRequestKey.current = "";
      return;
    }
    if (searchRequestKey.current === requestKey) return;
    const controller = new AbortController();
    setSearchFallbackHint(false);
    const timer = window.setTimeout(() => {
      searchRequestKey.current = requestKey;
      const params = new URLSearchParams({
        tab, page: "1", search: query, source,
        owner: filters.owner ?? "All", stage: filters.stage ?? "All",
      });
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      void fetch(`/api/leads?${params}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const result: unknown = await response.json();
          if (!response.ok || !isLeadsResponse(result)) throw new Error("Zoho search unavailable");
          if (!result.leads.length) return;
          setLeadRows((current) => {
            const rows = new Map(current.map((lead) => [lead.id, lead]));
            for (const lead of applyLeadOverrides(result.leads)) rows.set(lead.id, lead);
            return [...rows.values()];
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.warn("[leads] Zoho search unavailable; keeping local results", {
            message: error instanceof Error ? error.message : String(error),
          });
          setSearchFallbackHint(true);
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [debouncedSearch, total, leadRows.length, mergedLeadRows, user, tab, source, filters, applyLeadOverrides]);

  const count = (id: LeadTab) => leadsForTab(user, mergedLeadRows, id, search, source, filters).length;
  const currentTodaysFollowUps = leadsForTab(user, mergedLeadRows, "callback", search, source, filters)
    .filter((lead) => lead.followUp === todayIST()).length;
  const loadMore = async () => { await runRequest(currentPage.current + 1, true); };
  const availableTabs = TABS.filter((item) =>
    user.role === "Calling Team" ? item.id === "fresh" || item.id === "callback"
    : !(item.id === "fresh" && isExec) && !(item.id === "all" && user.role !== "Manager"));
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
          {(user.role === "Manager" || user.role === "Calling Team") && <p className="mt-1 text-[13px] text-muted-foreground sm:hidden">Today&apos;s follow-ups: {currentTodaysFollowUps}</p>}
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <Button className="hidden h-11 shrink-0 sm:inline-flex" onClick={() => setAdding((value) => !value)}><Plus /> Add Lead</Button>
          {(user.role === "Manager" || user.role === "Calling Team") && <span className="rounded-full bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground max-[480px]:hidden">Today&apos;s follow-ups: {currentTodaysFollowUps}</span>}
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
      {searchFallbackHint && <p role="status" className="text-xs text-muted-foreground">Showing results from loaded leads.</p>}

      <LeadFiltersPanel
        open={filtersOpen}
        owners={owners}
        filters={filters}
        source={source}
        onChange={setFilters}
        onSourceChange={setSource}
        onClose={() => setFiltersOpen(false)}
      />

      {adding && <AddLead onOptimisticAdd={(input) => {
        const selectedAssignee = teamMembers.find((member) => member.id === input.assignedToId);
        const selfAssigned = user.role === "Sales Executive";
        const optimistic: Lead = {
          id: `pending-${crypto.randomUUID()}`,
          name: input.name.trim(), company: input.company.trim(), phone: input.phone.replace(/\D/g, "").slice(-10),
          area: input.area.trim(), source: input.source,
          status: selfAssigned || selectedAssignee ? "Assigned to Sales" : "Fresh Lead",
          assignedTo: selectedAssignee?.name ?? (selfAssigned ? user.name : null),
          assignedToId: selectedAssignee?.id ?? (selfAssigned ? user.id : undefined),
          ownerId: selectedAssignee?.id ?? (selfAssigned ? user.id : undefined),
          remarks: input.remarks.trim(), createdOn: todayIST(), address: "", touchedBy: [user.name],
        };
        optimisticAddedLead.current = optimistic;
        setPendingLeadId(optimistic.id);
        updateLeadOptimistically(null, optimistic);
        setJustAdded(optimistic);
        return optimistic;
      }} onAddFailed={(id) => {
        const optimistic = optimisticAddedLead.current;
        if (optimistic?.id === id) {
          updateLeadOptimistically(optimistic, null);
          optimisticAddedLead.current = null;
        }
        setPendingLeadId((current) => current === id ? null : current);
      }} onAdded={(lead) => {
        const optimistic = optimisticAddedLead.current;
        if (optimistic) {
          leadOverrides.current.delete(optimistic.id);
          optimisticLeadRows.current.delete(optimistic.id);
          leadOverrides.current.set(lead.id, {
            name: lead.name,
            phone: lead.phone,
            status: lead.status,
            assignedTo: lead.assignedTo,
            assignedToId: lead.assignedToId,
            ownerId: lead.ownerId,
          });
          optimisticLeadRows.current.set(lead.id, lead);
          const counts = adjustLeadTabCounts(user, optimistic, lead, tabCounts, search, source, filters);
          setTabCounts(counts);
          const targetTab = user.role === "Manager" ? "all" : isExec ? "mine" : leadBucketForTab(lead);
          setTotal(counts[targetTab]);
        } else {
          setLeadRows((current) => current.some((item) => item.id === lead.id) ? current : [lead, ...current]);
        }
        setLeadRows((current) => current.map((item) => item.id === optimistic?.id ? lead : item));
        setJustAdded(lead);
        setPendingLeadId(null);
        optimisticAddedLead.current = null;
        const targetTab = user.role === "Manager" ? "all" : isExec ? "mine" : leadBucketForTab(lead);
        const bucket = leadBucketForTab(lead);
        if (!optimistic) setTabCounts((current) => {
          const next = { ...current };
          if (bucket === "fresh" || bucket === "assigned") next[bucket] += 1;
          if (user.role === "Manager") next.all += 1;
          if (lead.ownerId === user.id || lead.assignedToId === user.id ||
            (user.role === "Calling Team" && lead.touchedBy.includes(user.name))) next.mine += 1;
          setTotal(next[targetTab]);
          return next;
        });
        setHasAnyLeads(true);
        setTab(targetTab);
        setAdding(false);
        setHighlightedLeadId(lead.id);
        window.setTimeout(() => setHighlightedLeadId(null), 4000);
        window.requestAnimationFrame(() => {
          (document.getElementById("leads-list-mobile") ?? document.getElementById("leads-list"))?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        toast.success("Lead added", {
          action: {
            label: "View lead",
            onClick: () => {
              setSelected(lead);
              setTab(leadBucketForTab(lead));
            },
          },
        });
        refreshSilently();
      }} onCancel={() => setAdding(false)} assignees={teamMembers} assigneesUnavailable={teamMembersUnavailable} retryingAssignees={retryingTeamMembers} onRetryAssignees={() => void reloadTeamMembers()} leadSources={leadSources} leadSourcesUnavailable={leadSourcesUnavailableState} retryingLeadSources={retryingLeadSources} onRetryLeadSources={() => void reloadLeadSources()} canAssign={canAssign} canForceDuplicate={user.role === "Manager"} />}

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
                {visible.map((lead) => <DesktopRow key={lead.id} lead={lead} manager={user.role === "Manager"} highlighted={highlightedLeadId === lead.id} pending={pendingLeadId === lead.id} onOpen={selectLead} onAction={startLeadAction} />)}
              </tbody>
            </table>
          </div>
          <div id="leads-list-mobile" className="space-y-2 max-[480px]:space-y-1.5 md:hidden">
            {visible.map((lead) => <MobileRow key={lead.id} lead={lead} manager={user.role === "Manager"} highlighted={highlightedLeadId === lead.id} pending={pendingLeadId === lead.id} onOpen={selectLead} onAction={startLeadAction} />)}
          </div>
          {hasMoreRows && <div className="flex flex-col items-center gap-2">
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
          assignees={teamMembers}
          canAssign={canAssignLeads(user.role)}
          onClose={() => setSelected(null)}
          onOptimistic={(updated) => {
            const current = leadRowsRef.current.find((lead) => lead.id === updated.id) ?? selected;
            if (current) updateLeadOptimistically(current, updated);
            setSelected(updated);
          }}
          onRollback={(original) => {
            const fresh = leadRowsRef.current.find((lead) => lead.id === original.id) ?? original;
            updateLeadOptimistically(fresh, original);
            setSelected(original);
          }}
          onSaved={(updated) => {
            const current = leadRowsRef.current.find((lead) => lead.id === updated.id) ?? selected;
            if (current) updateLeadOptimistically(current, updated);
            setSelected(updated);
          }}
          onNext={selectLead}
          nextLead={visible[visible.findIndex((lead) => lead.id === selected.id) + 1]}
        />
      )}
      {action?.type === "call" && <CallLeadModal lead={action.lead} onClose={() => setAction(null)} onPendingChange={(pending) => setPendingLeadId(pending ? action.lead.id : null)} onOptimistic={(status, followUp, remarks) => {
        const before = leadRows.find((lead) => lead.id === action.lead.id) ?? action.lead;
        const after = {
          ...before,
          status,
          ...(followUp ? { followUp } : {}),
          ...(remarks?.trim() ? { remarks: [before.remarks, remarks.trim()].filter(Boolean).join("\n") } : {}),
        };
        optimisticCalls.current.set(action.lead.id, after);
        updateLeadOptimistically(before, after);
      }} onRollback={() => {
        const optimistic = optimisticCalls.current.get(action.lead.id);
        if (optimistic) updateLeadOptimistically(optimistic, action.lead);
        optimisticCalls.current.delete(action.lead.id);
      }} onSaved={() => {
        optimisticCalls.current.delete(action.lead.id);
        setAction(null);
        refreshSilently();
      }} />}
      {action && action.type !== "call" && <LeadActionModal key={`${action.type}:${action.lead.id}`} action={action} assignees={teamMembers} assigneesUnavailable={teamMembersUnavailable} retryingAssignees={retryingTeamMembers} onRetryAssignees={() => { teamLoadAttempted.current = false; void reloadTeamMembers(); }} onPendingChange={(pending) => setPendingLeadId(pending ? action.lead.id : null)} onClose={() => setAction(null)} onOptimisticAssign={(member) => {
        const { lead: reassigned } = reassignLeadOptimistically(
          user, action.lead, member, tabCounts, search, source, filters,
        );
        optimisticAssignments.current.set(action.lead.id, reassigned);
        updateLeadOptimistically(action.lead, reassigned);
        setAction(null);
        toast.success(`Reassigned to ${member.name}.`);
      }} onRollbackAssign={() => {
        const optimistic = optimisticAssignments.current.get(action.lead.id);
        if (optimistic) updateLeadOptimistically(optimistic, action.lead);
        optimisticAssignments.current.delete(action.lead.id);
        leadOverrides.current.delete(action.lead.id);
        optimisticLeadRows.current.delete(action.lead.id);
      }} onOptimisticChange={(before, after) => updateLeadOptimistically(before, after)} onRollbackChange={(before, after) => updateLeadOptimistically(before, after)} onDone={(savedLead) => {
        setAction(null);
        if (savedLead && action.type === "edit") updateLeadOptimistically(action.lead, savedLead);
        refreshSilently();
      }} onAssigned={(assignment) => {
        const optimistic = optimisticAssignments.current.get(action.lead.id) ?? action.lead;
        const persisted: Lead = {
          ...optimistic,
          assignedTo: assignment.owner,
          assignedToId: assignment.ownerId,
          ownerId: assignment.ownerId,
          status: assignment.status as LeadStatus,
        };
        setLeadRows((current) => current.map((lead) => lead.id === persisted.id ? persisted : lead));
        optimisticLeadRows.current.set(persisted.id, persisted);
        optimisticAssignments.current.delete(action.lead.id);
        setJustAdded((current) => current?.id === action.lead.id ? persisted : current);
        refreshSilently();
        if (assignment.warningCheckId) void pollAssignmentWarnings(assignment.warningCheckId);
      }} />}
    </div>
  );
}

async function pollAssignmentWarnings(warningCheckId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await getAssignmentWarningsAction({ id: warningCheckId });
    if (!result.ok || result.data === null || result.data === undefined) continue;
    if (result.data.taskWarning) toast.warning(`${result.data.taskWarning} The owner update is saved.`);
    if (result.data.historyWarning) toast.warning(`${result.data.historyWarning} The owner update is saved.`);
    return;
  }
}

function ActionButtons({ lead, manager, pending, onAction }: { lead: Lead; manager: boolean; pending: boolean; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  const whatsapp = whatsappUrl(lead.phone);
  const actionClass = "flex h-14 min-h-11 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-0 text-[10px] leading-tight focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";
  return <div data-testid="mobile-lead-actions" className={`grid ${manager ? "grid-cols-5" : "grid-cols-3"} gap-1.5`} onClick={(event) => event.stopPropagation()}>
    <Button type="button" variant="default" className={actionClass} disabled={pending || !lead.phone} aria-label={`Call ${lead.name}`} title={`Call ${lead.name}`} onClick={() => onAction("call")}><Phone /><span>Call</span></Button>
    {whatsapp
      ? <a href={whatsapp} target="_blank" rel="noreferrer" aria-disabled={pending} className={`${actionClass} text-[#087443] hover:bg-[#25D366]/10 ${pending ? "pointer-events-none opacity-50" : ""}`} aria-label={`Message ${lead.name} on WhatsApp`} title="WhatsApp" onClick={(event) => event.stopPropagation()}><WhatsAppIcon className="h-4 w-4" /><span>WhatsApp</span></a>
      : <button type="button" disabled className={`${actionClass} cursor-not-allowed text-muted-foreground`} aria-label={`WhatsApp unavailable for ${lead.name}`}><WhatsAppIcon className="h-4 w-4" /><span>WhatsApp</span></button>}
    <Button type="button" variant="ghost" className={actionClass} disabled={pending} aria-label={`Edit ${lead.name}`} title={`Edit ${lead.name}`} onClick={() => onAction("edit")}><Pencil /><span>Edit</span></Button>
    {manager && <Button type="button" variant="ghost" className={actionClass} disabled={pending} aria-label={`Reassign ${lead.name}`} title={`Assign owner for ${lead.name}`} onClick={() => onAction("reassign")}><UserRound /><span>Assign</span></Button>}
    {manager && <Button type="button" variant="ghost" className={`${actionClass} text-destructive hover:bg-destructive/10 hover:text-destructive`} disabled={pending} aria-label={`Delete ${lead.name}`} title={`Delete ${lead.name}`} onClick={() => onAction("delete")}><Trash2 /><span>Delete</span></Button>}
  </div>;
}

function DesktopActionButtons({ lead, manager, pending, onAction }: { lead: Lead; manager: boolean; pending: boolean; onAction: (type: "call" | "edit" | "reassign" | "delete") => void }) {
  const whatsapp = whatsappUrl(lead.phone);
  return <div className="flex justify-end gap-2 whitespace-nowrap">
    {lead.phone && <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" disabled={pending} aria-label={`Call ${lead.name}`} title={`Call ${lead.name}`} onClick={() => onAction("call")}><Phone /></Button>}
    {whatsapp && <a aria-disabled={pending} className={`grid h-9 w-9 place-items-center rounded-lg hover:bg-secondary ${pending ? "pointer-events-none opacity-50" : ""}`} href={whatsapp} target="_blank" rel="noreferrer" aria-label={`Message ${lead.name} on WhatsApp`} title="WhatsApp" onClick={(event) => event.stopPropagation()}><WhatsAppIcon className="h-5 w-5" /></a>}
    <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" disabled={pending} aria-label={`Edit ${lead.name}`} title={`Edit ${lead.name}`} onClick={() => onAction("edit")}><Pencil /></Button>
    {manager && <><Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" disabled={pending} aria-label={`Reassign ${lead.name}`} title={`Assign owner for ${lead.name}`} onClick={() => onAction("reassign")}><UserRound /></Button><Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" disabled={pending} aria-label={`Delete ${lead.name}`} title={`Delete ${lead.name}`} onClick={() => onAction("delete")}><Trash2 /></Button></>}
  </div>;
}

const DesktopRow = memo(function DesktopRow({ lead, manager, highlighted, pending, onOpen, onAction }: { lead: Lead; manager: boolean; highlighted: boolean; pending: boolean; onOpen: (lead: Lead) => void; onAction: (type: "call" | "edit" | "reassign" | "delete", lead: Lead) => void }) {
  return (
    <tr className={`group cursor-pointer transition-colors hover:bg-secondary/50 ${pending ? "opacity-60" : ""} ${highlighted ? "bg-success/10 ring-1 ring-inset ring-success" : ""}`} onClick={() => onOpen(lead)}>
      <td className="max-w-56 px-4 py-3"><div className="truncate font-semibold">{lead.name}</div>{lead.company && <div className="truncate text-xs text-muted-foreground">{lead.company}</div>}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.phone || "—"}</td>
      <td className="whitespace-nowrap px-3 py-3">{lead.source}</td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{lead.createdOn || "—"}</td>
      <td className="px-3 py-3"><StatusBadge status={lead.status} />{lead.followUp && lead.followUp <= todayIST() && <div className="mt-1 text-xs font-semibold text-destructive">Overdue</div>}</td>
      <td className="max-w-36 truncate px-3 py-3">{lead.assignedTo ?? "Unassigned"}</td>
      <td className="sticky right-0 z-[1] min-w-[200px] whitespace-nowrap bg-card px-2 py-3 text-right group-hover:bg-secondary/50" onClick={(event) => event.stopPropagation()}><DesktopActionButtons lead={lead} manager={manager} pending={pending} onAction={(type) => onAction(type, lead)} />{pending && <span role="status" className="sr-only">Updating lead</span>}</td>
    </tr>
  );
});

const MobileRow = memo(function MobileRow({ lead, manager, highlighted, pending, onOpen, onAction }: { lead: Lead; manager: boolean; highlighted: boolean; pending: boolean; onOpen: (lead: Lead) => void; onAction: (type: "call" | "edit" | "reassign" | "delete", lead: Lead) => void }) {
  const mobile = lead.phone.replace(/\D/g, "").slice(-10);
  const company = lead.company.trim();
  const showCompany = company && company.toLocaleLowerCase() !== lead.name.trim().toLocaleLowerCase();
  return (
    <div data-testid="mobile-lead-card" role="button" tabIndex={0} onClick={() => onOpen(lead)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) { event.preventDefault(); onOpen(lead); } }} className={`min-w-0 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${pending ? "opacity-60" : ""} ${highlighted ? "bg-success/10 ring-1 ring-success" : ""}`}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-foreground">{lead.name}</div>
          {showCompany && <div className="truncate text-xs text-muted-foreground">{company}</div>}
        </div>
        <div className="shrink-0"><StatusBadge status={lead.status} /></div>
      </div>
      {mobile.length === 10 && <a href={`tel:+91${mobile}`} aria-label={`Call ${lead.name} at ${lead.phone}`} className="mt-2 inline-flex max-w-full min-w-0 items-center gap-2 text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={(event) => event.stopPropagation()}>
        <Phone aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="truncate">{lead.phone}</span>
      </a>}
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] leading-5">
        <span className="max-w-full truncate rounded-full bg-secondary px-2 text-secondary-foreground"><span className="text-muted-foreground">Source</span> · {lead.source}</span>
        <span className="max-w-full truncate rounded-full bg-secondary px-2 text-secondary-foreground"><span className="text-muted-foreground">Created</span> · {lead.createdOn || "—"}</span>
        <span className={`max-w-full truncate rounded-full px-2 ${lead.assignedTo ? "bg-secondary text-secondary-foreground" : "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"}`}><span className={lead.assignedTo ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}>Owner</span> · {lead.assignedTo ?? "Unassigned"}</span>
      </div>
      {(lead.remarks || lead.followUp) && <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {lead.remarks && <p className="break-words"><span className="font-medium text-foreground">Remarks:</span> {lead.remarks}</p>}
        {lead.followUp && <p className={lead.followUp <= todayIST() ? "font-medium text-destructive" : ""}>
          <span className="font-medium">Follow-up:</span> {lead.followUp}{lead.followUpTime ? ` · ${lead.followUpTime}` : ""}{lead.followUp <= todayIST() ? " · Overdue" : ""}
        </p>}
      </div>}
      <div className="mt-3 border-t border-border pt-2.5">
        <ActionButtons lead={lead} manager={manager} pending={pending} onAction={(type) => onAction(type, lead)} />
        {pending && <span role="status" className="sr-only">Updating lead</span>}
      </div>
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

function LeadActionModal({ action, assignees, assigneesUnavailable, retryingAssignees, onRetryAssignees, onPendingChange, onOptimisticChange, onRollbackChange, onClose, onDone, onAssigned, onOptimisticAssign, onRollbackAssign }: {
  action: LeadMutationAction; assignees: { id: string; name: string }[]; assigneesUnavailable: boolean; retryingAssignees: boolean; onRetryAssignees: () => void; onPendingChange: (pending: boolean) => void; onOptimisticChange: (before: Lead, after: Lead | null) => void; onRollbackChange: (before: Lead | null, after: Lead | null) => void; onClose: () => void; onDone: (lead?: Lead) => void; onAssigned: (assignment: { owner: string; ownerId: string; status: string; warningCheckId: string }) => void; onOptimisticAssign: (member: { id: string; name: string }) => void; onRollbackAssign: () => void;
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
  useEffect(() => {
    const saved = readExpiredAction<{ type: string; payload: { leadId?: string; name?: string; company?: string; phone?: string; source?: LeadSource; status?: LeadStatus; remarks?: string; followUp?: string; assignee?: string } }>();
    if (saved?.type !== "lead-action" || saved.payload.leadId !== action.lead.id) return;
    if (saved.payload.name !== undefined) setName(saved.payload.name);
    if (saved.payload.company !== undefined) setCompany(saved.payload.company);
    if (saved.payload.phone !== undefined) setPhone(saved.payload.phone);
    if (saved.payload.source !== undefined) setSource(saved.payload.source);
    if (saved.payload.status !== undefined) setStatus(saved.payload.status);
    if (saved.payload.remarks !== undefined) setRemarks(saved.payload.remarks);
    if (saved.payload.followUp !== undefined) setFollowUp(saved.payload.followUp);
    if (saved.payload.assignee !== undefined) setAssignee(saved.payload.assignee);
    clearExpiredAction();
  }, [action.lead.id]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const optimisticOwner = action.type === "reassign" ? assignees.find((member) => member.id === assignee) : undefined;
    if (action.type === "reassign" && (!optimisticOwner || assignee === (action.lead.ownerId ?? action.lead.assignedToId))) return;
    const optimisticEdit: Lead | null = action.type === "edit"
      ? { ...action.lead, name, company, phone, source, status, remarks, ...(followUp ? { followUp } : {}) }
      : null;
    if (action.type !== "reassign") onOptimisticChange(action.lead, optimisticEdit);
    if (optimisticOwner) onOptimisticAssign(optimisticOwner);
    onPendingChange(true);
    start(async () => {
      try {
        const result = action.type === "edit"
          ? await updateLeadAction({ id: action.lead.id, name, company, phone, source, status, remarks, ...(followUp ? { followUp } : {}) })
          : action.type === "reassign"
            ? await reassignLeadAction({ id: action.lead.id, assignedToId: assignee })
            : await deleteLeadAction({ id: action.lead.id });
        if (!result.ok) {
          if (optimisticOwner) onRollbackAssign();
          else onRollbackChange(optimisticEdit, action.lead);
          if (isSessionExpiredMessage(result.error)) {
            redirectForExpiredSession({
              type: "lead-action",
              payload: {
                actionType: action.type,
                leadId: action.lead.id,
                name, company, phone, source, status, remarks, followUp, assignee,
              },
            });
            return;
          }
          toast.error(result.error);
          return;
        }
        if (action.type === "reassign") {
          const assignment = result.data;
          if (assignment && "ownerId" in assignment) {
            onAssigned({
              owner: assignment.owner,
              ownerId: assignment.ownerId,
              status: assignment.status,
              warningCheckId: assignment.warningCheckId,
            });
          }
        }
        else {
          toast.success(action.type === "delete" ? "Lead deleted" : "Lead updated");
          onDone(action.type === "edit" && result.data && "lead" in result.data ? result.data.lead : undefined);
        }
      } catch (error) {
        if (optimisticOwner) onRollbackAssign();
        else onRollbackChange(optimisticEdit, action.lead);
        toast.error(error instanceof Error ? error.message : "Could not save this lead update. Please retry.");
      } finally {
        onPendingChange(false);
      }
    });
  };

  const title = action.type === "edit" ? "Edit lead" : action.type === "reassign" ? "Reassign owner" : "Delete lead";
  const currentOwnerId = action.lead.ownerId ?? action.lead.assignedToId;
  const availableAssignees = leadAssigneeOptions(assignees, currentOwnerId);
  const selectedAssignee = assignees.find((member) => member.id === assignee);
  const canConfirmReassignment = !!selectedAssignee && selectedAssignee.id !== currentOwnerId;
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
        <label className="block font-medium">Assign to<SelectField aria-label="Assign to" className="mt-1 h-11 w-full text-sm" value={assignee} onValueChange={setAssignee} disabled={retryingAssignees || assigneesUnavailable} options={[
          { value: "", label: retryingAssignees ? "Loading team members…" : assigneesUnavailable ? "Team members unavailable" : "Select a team member" },
          ...availableAssignees.map(({ id, label }) => ({ value: id, label })),
        ]} /></label>
        {retryingAssignees && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Loading active team members…</p>}
        {currentOwnerId && <p className="text-xs text-muted-foreground">Current owner: {action.lead.assignedTo ?? "Unassigned"}</p>}
        {assigneesUnavailable && !retryingAssignees && <Button type="button" variant="outline" className="h-9" onClick={onRetryAssignees} disabled={retryingAssignees}>{retryingAssignees ? "Retrying…" : "Retry loading team members"}</Button>}
        {!assigneesUnavailable && !retryingAssignees && !availableAssignees.length && <p className="text-xs text-muted-foreground">No active team members are available.</p>}
      </>}
      {action.type === "delete" && <p className="rounded-md bg-destructive/10 p-3 text-sm">Delete {action.lead.name}? This can&apos;t be undone.</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button><Button type="submit" variant={action.type === "delete" ? "destructive" : "default"} disabled={pending || (action.type === "reassign" && !canConfirmReassignment)}>{pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}{pending ? "Saving..." : action.type === "delete" ? "Delete" : action.type === "reassign" ? selectedAssignee?.id === currentOwnerId ? "Already assigned to this person" : "Confirm" : "Save"}</Button></div>
    </form>
  </div>;
}

function LeadDrawer({ lead, executives, assignees, canAssign, onClose, onOptimistic, onRollback, onSaved, onNext, nextLead }: {
  lead: Lead; executives: string[]; assignees: { id: string; name: string }[]; canAssign: boolean; onClose: () => void;
  onOptimistic: (lead: Lead) => void; onRollback: (original: Lead) => void; onSaved: (lead: Lead) => void; onNext: (lead: Lead) => void; nextLead?: Lead;
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
  const originalLead = useRef(lead);
  const filteredExecutives = executives.filter((name) => name.toLowerCase().includes(assigneeSearch.toLowerCase()));
  useBodyScrollLock(true);

  useEffect(() => {
    drawerRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = (saveNext = false) => {
    if (pending) return;
    const assigned = assignees.find((member) => member.name === assignee);
    const optimistic: Lead = {
      ...lead,
      status,
      remarks,
      ...(canAssign ? {
        assignedTo: assignee || null,
        assignedToId: assignee ? assigned?.id : undefined,
        ownerId: assignee ? assigned?.id : undefined,
      } : {}),
    };
    onOptimistic(optimistic);
    start(async () => {
      try {
        const result = await saveLeadUpdateAction({ id: lead.id, status, remarks, ...(canAssign ? { assignedTo: assignee || null } : {}) });
        if (!result.ok) {
          onRollback(originalLead.current);
          toast.error(result.error);
          return;
        }
        const saved = result.data?.lead ?? optimistic;
        const zohoUrl = result.data?.zohoUrl;
        toast.success("Saved", zohoUrl ? {
          action: { label: "Open in Zoho", onClick: () => window.open(zohoUrl, "_blank", "noopener,noreferrer") },
        } : undefined);
        onSaved(saved);
        setRemarks("");
        if (saveNext && nextLead) {
          toast.success(`Next lead: ${nextLead.name}`);
          onNext(nextLead);
        }
      } catch (error) {
        onRollback(originalLead.current);
        toast.error(error instanceof Error ? error.message : "Could not save this lead update.");
      }
    });
  };

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
            <ScheduleForm lead={lead} onDone={() => setMode("edit")} onSaved={() => onSaved(lead)} />
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
              <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t bg-card/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:mt-0 sm:border-0 sm:bg-transparent sm:p-0 sm:pb-0 sm:backdrop-blur-none">
                <div className="grid gap-2 sm:grid-cols-2">
                <Button disabled={pending} onClick={() => save()}>{pending ? "Saving…" : "Save"}</Button>
                <Button variant="outline" disabled={pending || !nextLead} onClick={() => save(true)}>{pending ? "Saving…" : "Save & next"}</Button>
                </div>
                <div className="mt-2 grid gap-2 border-t pt-3 sm:grid-cols-3">
                  <Button variant="outline" onClick={loadHistory}><History /> History</Button>
                  <Button variant="outline" onClick={() => setMode("schedule")}><CalendarPlus /> Schedule visit</Button>
                  <Button asChild variant="secondary"><Link href={`/quotations?lead=${lead.id}`} onClick={onClose}><FileText /> Create quotation</Link></Button>
                </div>
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

function ScheduleForm({ lead, onDone, onSaved }: { lead: Lead; onDone: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ type: VISIT_TYPES[0]!, date: todayIST(), time: "11:00", address: lead.address, nextAction: "", followUp: "" });
  const [pending, start] = useTransition();
  const isVisit = !["Follow-up call", "Prepare quotation"].includes(f.type);
  const submit = () => start(async () => {
    const result = await scheduleVisitAction({ leadId: lead.id, executive: lead.assignedTo ?? undefined, isVisit, ...f });
    if (result.ok) { toast.success("Visit scheduled"); onDone(); onSaved(); } else toast.error(result.error);
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

function AddLead({ onOptimisticAdd, onAddFailed, onAdded, onCancel, assignees, assigneesUnavailable, retryingAssignees, onRetryAssignees, leadSources, leadSourcesUnavailable, retryingLeadSources, onRetryLeadSources, canAssign, canForceDuplicate }: { onOptimisticAdd: (input: { name: string; company: string; phone: string; area: string; source: LeadSource; remarks: string; assignedToId: string }) => Lead; onAddFailed: (id: string) => void; onAdded: (lead: Lead) => void; onCancel: () => void; assignees: { id: string; name: string }[]; assigneesUnavailable: boolean; retryingAssignees: boolean; onRetryAssignees: () => void; leadSources: LeadSource[]; leadSourcesUnavailable: boolean; retryingLeadSources: boolean; onRetryLeadSources: () => void; canAssign: boolean; canForceDuplicate: boolean }) {
  const [f, setF] = useState({ name: "", company: "", phone: "", area: "", source: leadSources[0] ?? "Meta Ads" as LeadSource, remarks: "", assignedToId: "" });
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; owner: string; status: string; matchedField?: "Mobile" | "Phone" } | null>(null);
  const [forceCreate, setForceCreate] = useState(false);
  const [flaggedPhone, setFlaggedPhone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const firstSource = leadSources[0];
    if (firstSource && !leadSources.includes(f.source)) {
      setF((current) => ({ ...current, source: firstSource }));
    }
  }, [f.source, leadSources]);
  const [retryableError, setRetryableError] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const submittedRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const saved = readExpiredAction<{ type: string; payload: typeof f }>();
    if (saved?.type !== "add-lead") return;
    setF((current) => ({ ...current, ...saved.payload }));
    clearExpiredAction();
  }, []);
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
    const optimisticLead = onOptimisticAdd(f);
    start(async () => {
      try {
        const result = await addLeadAction({ ...f, phone: normalizedPhone, assignedToId: f.assignedToId || null, forceCreate });
        if (result.ok && result.data) {
          setRetryableError(false);
          clearExpiredAction();
          onAdded(result.data);
        }
        else if (!result.ok) {
          onAddFailed(optimisticLead.id);
          if (isSessionExpiredMessage(result.error)) {
            redirectForExpiredSession({ type: "add-lead", payload: f });
            return;
          }
          setRetryableError(isRetryableActionMessage(result.error));
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
        } else {
          onAddFailed(optimisticLead.id);
          toast.error("Lead creation returned no saved record. Please retry.");
          submittedRef.current = false;
        }
      } catch (error) {
        onAddFailed(optimisticLead.id);
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
        <div><label htmlFor="add-lead-source" className="mb-1 block text-sm font-medium">Source</label><SelectField id="add-lead-source" disabled={!leadSources.length} value={f.source} onValueChange={(value) => setF((current) => ({ ...current, source: value as LeadSource }))} options={leadSources.map((item) => ({ value: item, label: item }))} />
          {leadSourcesUnavailable && <Button type="button" variant="outline" className="mt-2 h-9" disabled={retryingLeadSources} onClick={onRetryLeadSources}>{retryingLeadSources ? "Retrying…" : "Retry loading Lead Sources"}</Button>}
          {!leadSources.length && !leadSourcesUnavailable && <p className="mt-1 text-xs text-destructive">No Lead Source values are configured in Zoho.</p>}
        </div>
        {canAssign && <div>
          <label htmlFor="add-lead-assignee" className="mb-1 block text-sm font-medium">Assign to</label>
          <SelectField id="add-lead-assignee" disabled={assigneesUnavailable} value={f.assignedToId} onValueChange={(value) => setF((current) => ({ ...current, assignedToId: value }))} options={assigneesUnavailable
            ? [{ value: "", label: "Couldn't load team members", disabled: true }]
            : [{ value: "", label: "Assign to (optional)" }, ...leadAssigneeOptions(assignees).map(({ id, label }) => ({ value: id, label }))]} />
          {assigneesUnavailable && <Button type="button" variant="outline" className="mt-2 h-9" onClick={onRetryAssignees} disabled={retryingAssignees}>{retryingAssignees ? "Retrying…" : "Retry loading team members"}</Button>}
        </div>}
        <div className="sm:col-span-2"><label htmlFor="add-lead-remarks" className="mb-1 block text-sm font-medium">Remarks</label><textarea id="add-lead-remarks" className={`${fieldClass} min-h-11 text-base md:text-sm`} value={f.remarks} onChange={set("remarks")} maxLength={500} /></div>
        {duplicate && duplicateMatchesPhone && <div className="rounded-lg border border-destructive bg-card p-3 text-sm text-destructive sm:col-span-2"><p>A lead with this number already exists: <a className="underline" href={`/leads#lead-${duplicate.id}`}>{duplicate.name}</a></p><p className="mt-1 text-xs text-muted-foreground">Matched on {duplicate.matchedField ?? "phone"} · Owner: {duplicate.owner} · Status: {duplicate.status}</p>        {canForceDuplicate && !forceCreate && <Button type="button" variant="outline" className="mt-2 h-11" onClick={() => setForceCreate(true)}>Create anyway</Button>}</div>}
      </div>
    </div>
    <div className="flex shrink-0 gap-3 border-t border-border bg-card p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))]">
      <Button type="button" variant="outline" className="h-11 flex-1" onClick={close} disabled={pending}>Cancel</Button>      <Button type="submit" className="h-11 flex-1" disabled={pending || !leadSources.length}>{pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}{pending ? "Adding…" : retryableError ? "Retry add lead" : "Add Lead"}</Button>
    </div>
      </form>
    </div>
  </div>;
}
