"use client";

import { startTransition, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowLeft, Check, ChevronDown, Copy, Eye, History, LoaderCircle, Minus, Plus, Printer, Search, Trash2, UserPlus, X, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { StatusBadge, fieldClass } from "@/components/ui-bits";
import { clearExpiredAction, isRetryableActionMessage, isSessionExpiredMessage, readExpiredAction, redirectForExpiredSession } from "@/lib/session-recovery";
import { executeMutation, friendlyMutationError, notifyMutationFailure } from "@/lib/use-mutation";
import { addLeadAction, createQuoteAction, getLeadSourcesAction, getProductsAction, getQuoteDetailAction, markQuotationSentAction, refreshProductsAction } from "@/app/actions/crm";
import { COMPANY, OFFER_TEXT, offerSubject } from "@/lib/company";
import { canCreateQuotationPdf, splitQuotationItems } from "@/lib/quotation-presentation";
import { formatINR, quoteTotals, uniqueProducts, validateQuoteLine, type Lead, type LeadSource, type LeadStatus, type Product, type Quotation } from "@/lib/domain";

type Row = { productId: string; qty: number; discount: number };
type WizardState = {
  step: 1 | 2 | 3;
  leadId: string;
  rows: Row[];
  offerNo: string;
  subject: string;
  savedQuotation?: Quotation;
  quotationSent: boolean;
};
type DuplicateCustomer = { id: string; name: string; owner: string; status: string };
type QuotationCustomer = Pick<Lead, "id" | "name" | "company" | "phone" | "area" | "source" | "status" | "assignedTo">
  & Partial<Pick<Lead, "assignedToId" | "ownerId" | "remarks" | "createdOn" | "address" | "touchedBy" | "followUp" | "followUpTime">>;
type Props = { leads: QuotationCustomer[]; initialCustomersHasMore: boolean; initialSavedQuotesCount?: number; leadSources: LeadSource[]; leadSourcesUnavailable: boolean; products: Product[]; isManager: boolean; suggestedOfferNo: string; presetLeadId: string; presetLeadError?: string };

function normalizeWhatsAppPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("91")
    ? digits.slice(2)
    : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^\d{10}$/.test(national) ? national : "";
}

function QuotationStepper({ step, hasLead, productsValid, hasSavedQuote, onStep }: {
  step: 1 | 2 | 3; hasLead: boolean; productsValid: boolean; hasSavedQuote: boolean; onStep: (step: 1 | 2 | 3) => void;
}) {
  return <nav aria-label="Quotation progress" className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-card p-2">
    {(["Customer", "Products", "Preview"] as const).map((label, index) => {
      const stepNumber = (index + 1) as 1 | 2 | 3;
      const completed = stepNumber < step || (stepNumber === 1 && hasLead) || (stepNumber === 2 && productsValid);
      const disabled = stepNumber > step || (stepNumber === 2 && !hasLead) || (stepNumber === 3 && !hasSavedQuote);
      const active = stepNumber === step;
      return <button type="button" key={label} disabled={disabled} onClick={() => onStep(stepNumber)} className={`flex min-h-11 items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-xs font-semibold transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${active ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`} aria-current={active ? "step" : undefined}>
        {completed && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}<span>{stepNumber}. {label}</span>
      </button>;
    })}
  </nav>;
}

export function QuotationsClient({ leads, initialCustomersHasMore, initialSavedQuotesCount, leadSources: initialLeadSources, leadSourcesUnavailable: initialLeadSourcesUnavailable, products: initialProducts, isManager, suggestedOfferNo, presetLeadId, presetLeadError }: Props) {
  const router = useRouter();
  const refreshSilently = () => {
    startTransition(() => router.refresh());
  };
  const [leadSources, setLeadSources] = useState(initialLeadSources);
  const [leadSourcesUnavailable, setLeadSourcesUnavailable] = useState(initialLeadSourcesUnavailable);
  const [retryingLeadSources, setRetryingLeadSources] = useState(false);
  const [products, setProducts] = useState(initialProducts);
  const [refreshingProducts, setRefreshingProducts] = useState(false);
  const [productRefreshFailed, setProductRefreshFailed] = useState(false);
  const [nl, setNl] = useState({ name: "", company: "", phone: "", area: "", source: initialLeadSources[0] ?? "Direct Call" as LeadSource });
  const [created, setCreated] = useState<QuotationCustomer[]>([]);
  const myLeads = useMemo(() => [...created.filter((c) => !leads.some((l) => l.id === c.id)), ...leads], [created, leads]);
  const [loadedMoreLeads, setLoadedMoreLeads] = useState<QuotationCustomer[]>([]);
  const [searchedLeads, setSearchedLeads] = useState<QuotationCustomer[]>([]);
  const [q, setQ] = useState("");
  const [customerSearchPending, setCustomerSearchPending] = useState(false);
  const [customerSearchError, setCustomerSearchError] = useState("");
  const [customerSearchPage, setCustomerSearchPage] = useState(1);
  const [customerSearchHasMore, setCustomerSearchHasMore] = useState(false);
  const [customerListPage, setCustomerListPage] = useState(1);
  const [customerListHasMore, setCustomerListHasMore] = useState(initialCustomersHasMore);
  const [loadingMoreCustomers, setLoadingMoreCustomers] = useState(false);
  const [wizard, setWizard] = useState<WizardState>(() => {
    const preset = String(presetLeadId).trim();
    return {
      step: preset && leads.some((lead) => lead.id === preset) ? 2 : 1,
      leadId: preset,
      rows: [{ productId: "", qty: 1, discount: 0 }],
      offerNo: suggestedOfferNo,
      subject: "",
      quotationSent: false,
    };
  });
  const { step, leadId, rows } = wizard;
  const localCustomers = useMemo(() => [...myLeads, ...loadedMoreLeads].filter((customer, index, list) =>
    list.findIndex((candidate) => candidate.id === customer.id) === index,
  ), [myLeads, loadedMoreLeads]);
  const localMatches = useMemo(() => {
    const search = q.trim().toLowerCase();
    return localCustomers.filter((customer) =>
      !search || [customer.name, customer.company, customer.phone, customer.area]
        .some((value) => value.toLowerCase().includes(search)),
    );
  }, [localCustomers, q]);
  const setStep = (nextStep: 1 | 2 | 3) => setWizard((current) => ({ ...current, step: nextStep }));
  const setLeadId = (nextLeadId: string) => setWizard((current) => ({
    ...current, leadId: nextLeadId, subject: "", savedQuotation: undefined, quotationSent: false,
  }));
  const setRows = (nextRows: Row[] | ((currentRows: Row[]) => Row[])) => setWizard((current) => ({
    ...current,
    rows: typeof nextRows === "function" ? nextRows(current.rows) : nextRows,
    subject: "",
    savedQuotation: undefined,
    quotationSent: false,
  }));
  const setOfferNo = (nextOfferNo: string) => setWizard((current) => ({
    ...current, offerNo: nextOfferNo, savedQuotation: undefined, quotationSent: false,
  }));
  const retryLeadSources = async () => {
    if (retryingLeadSources) return;
    setRetryingLeadSources(true);
    try {
      const result = await getLeadSourcesAction();
      if (!result.ok || !result.data?.length) {
        setLeadSourcesUnavailable(true);
        toast.error(result.ok ? "No Lead Source values are configured in Zoho." : result.error);
        return;
      }
      setLeadSources(result.data);
      setLeadSourcesUnavailable(false);
      const firstSource = result.data[0];
      if (firstSource) setNl((current) => ({ ...current, source: firstSource }));
      toast.success("Lead sources loaded");
    } finally {
      setRetryingLeadSources(false);
    }
  };
  const loadProductsOnPickerOpen = async () => {
    try {
      const result = await getProductsAction();
      if (!result.ok || !result.data) {
        toast.error("Couldn't refresh products. Please try again.");
        return;
      }
      setProducts(uniqueProducts(result.data));
    } catch {
      toast.error("Couldn't refresh products. Please try again.");
    }
  };
  const refreshProducts = async () => {
    if (refreshingProducts) return;
    setRefreshingProducts(true);
    setProductRefreshFailed(false);
    try {
      const result = await refreshProductsAction();
      if (!result.ok || !result.data) {
        setProductRefreshFailed(true);
        toast.error("Couldn't refresh products. Please try again.");
        return;
      }
      const refreshed = uniqueProducts(result.data);
      setProducts(refreshed);
      toast.success(`Products updated (${refreshed.length})`);
    } catch {
      setProductRefreshFailed(true);
      toast.error("Couldn't refresh products. Please try again.");
    } finally {
      setRefreshingProducts(false);
    }
  };
  useEffect(() => {
    const firstSource = leadSources[0];
    if (firstSource && !leadSources.includes(nl.source)) {
      setNl((current) => ({ ...current, source: firstSource }));
    }
  }, [leadSources, nl.source]);
  useEffect(() => {
    setLeadSources(initialLeadSources);
    setLeadSourcesUnavailable(initialLeadSourcesUnavailable);
  }, [initialLeadSources, initialLeadSourcesUnavailable]);
  useEffect(() => {
    setCustomerListHasMore(initialCustomersHasMore);
  }, [initialCustomersHasMore]);
  useEffect(() => {
    if (initialSavedQuotesCount !== undefined) {
      setSavedQuotesCount((count) => Math.max(count ?? 0, initialSavedQuotesCount));
    }
  }, [initialSavedQuotesCount]);
  const [adding, setAdding] = useState(false);
  const [duplicateCustomer, setDuplicateCustomer] = useState<DuplicateCustomer | null>(null);
  const [pending, start] = useTransition();
  const [customerRetryable, setCustomerRetryable] = useState(false);
  const [quoteSaveError, setQuoteSaveError] = useState("");
  const [savedQuotes, setSavedQuotes] = useState<Quotation[]>([]);
  const [savedQuotesCount, setSavedQuotesCount] = useState<number | null>(initialSavedQuotesCount ?? null);
  const [savedQuotesPage, setSavedQuotesPage] = useState(1);
  const [savedQuotesHasMore, setSavedQuotesHasMore] = useState(false);
  const [loadingMoreQuotes, setLoadingMoreQuotes] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const savedQuotesLoaded = useRef(false);
  const [savedSearch, setSavedSearch] = useState("");
  const [loadingQuoteId, setLoadingQuoteId] = useState<string | null>(null);
  const [readOnlyQuote, setReadOnlyQuote] = useState<Quotation | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const savedSearchRef = useRef<HTMLInputElement>(null);
  const savedButtonRef = useRef<HTMLButtonElement>(null);
  const previousStep = useRef(step);

  useEffect(() => {
    const saved = readExpiredAction<{ type: string; payload: Partial<WizardState> & Partial<typeof nl> }>();
    if (saved?.type === "add-customer") {
      setNl((current) => ({ ...current, ...saved.payload }));
      setAdding(true);
      clearExpiredAction();
    } else if (saved?.type === "create-quote") {
      setWizard((current) => ({
        ...current,
        ...saved.payload,
        step: 2,
        savedQuotation: undefined,
        quotationSent: false,
      }));
      clearExpiredAction();
    }
  }, []);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const items = rows.flatMap((r) => { const p = byId.get(r.productId); return p ? [{ productId: p.id, model: p.model, description: p.description, unit: p.unit, price: p.price, qty: r.qty, discount: r.discount }] : []; });
  const t = quoteTotals(items);
  const lead = myLeads.find((l) => String(l.id).trim() === String(leadId).trim());
  const validLineCount = rows.filter((row) => {
    const product = byId.get(row.productId);
    return !!product && validateQuoteLine(row.qty, row.discount, product.price) === null;
  }).length;
  const productsValid = items.length > 0 && validLineCount === items.length;
  const hasSavedQuote = !!wizard.savedQuotation?.id && !!wizard.savedQuotation.offerNo.trim();
  const upd = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  useEffect(() => {
    if (step === 3) {
      window.scrollTo({ top: 0, behavior: "instant" });
      requestAnimationFrame(() => document.getElementById("offer-heading")?.focus({ preventScroll: true }));
    } else if (previousStep.current === 3) {
      requestAnimationFrame(() => document.getElementById("quote-step-products")?.scrollIntoView({ behavior: "instant", block: "start" }));
    }
    previousStep.current = step;
  }, [step]);

  useEffect(() => {
    if (!savedOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    savedSearchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSavedOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [savedOpen]);

  useEffect(() => {
    if (readOnlyQuote) {
      requestAnimationFrame(() => document.getElementById("offer-heading")?.focus({ preventScroll: true }));
    }
  }, [readOnlyQuote]);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 3 || localMatches.length > 0) {
      setSearchedLeads([]);
      setCustomerSearchPending(false);
      setCustomerSearchError("");
      setCustomerSearchPage(1);
      setCustomerSearchHasMore(false);
      return;
    }
    setSearchedLeads([]);
    setCustomerSearchPending(true);
    setCustomerSearchHasMore(false);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCustomerSearchPending(true);
      setCustomerSearchError("");
      void fetch(`/api/leads/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (response) => {
          const result = await response.json() as { leads?: QuotationCustomer[]; hasMore?: boolean; error?: string };
          if (!response.ok) throw new Error(result.error || "Unable to search customers.");
          setSearchedLeads(result.leads ?? []);
          setCustomerSearchPage(1);
          setCustomerSearchHasMore(result.hasMore === true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setCustomerSearchError(error instanceof Error ? error.message : "Unable to search customers.");
          setSearchedLeads([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setCustomerSearchPending(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q, localMatches.length]);

  const loadMoreCustomers = async () => {
    const query = q.trim();
    const loadingInitialList = !query || localMatches.length > 0;
    if (loadingMoreCustomers || (loadingInitialList ? !customerListHasMore : !customerSearchHasMore)) return;
    setLoadingMoreCustomers(true);
    try {
      const page = loadingInitialList ? customerListPage + 1 : customerSearchPage + 1;
      const url = loadingInitialList ? `/api/leads/search?page=${page}` : `/api/leads/search?q=${encodeURIComponent(query)}&page=${page}`;
      const response = await fetch(url);
      const result = await response.json() as { leads?: QuotationCustomer[]; hasMore?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to load more customers.");
      if (q.trim() !== query) return;
      if (loadingInitialList) {
        setLoadedMoreLeads((current) => [...current, ...(result.leads ?? []).filter((lead) =>
          !localCustomers.some((item) => item.id === lead.id) && !current.some((item) => item.id === lead.id),
        )]);
        setCustomerListPage(page);
        setCustomerListHasMore(result.hasMore === true);
      } else {
        setSearchedLeads((current) => [...current, ...(result.leads ?? []).filter((lead) => !current.some((item) => item.id === lead.id))]);
        setCustomerSearchPage(page);
        setCustomerSearchHasMore(result.hasMore === true);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load more customers.");
    } finally {
      setLoadingMoreCustomers(false);
    }
  };

  const matches = useMemo(() => {
    const combined = [...localCustomers, ...searchedLeads].filter((lead, index, list) =>
      list.findIndex((candidate) => candidate.id === lead.id) === index,
    );
    const search = q.trim().toLowerCase();
    return combined.filter((customer) =>
      !search || [customer.name, customer.company, customer.phone, customer.area]
        .some((value) => value.toLowerCase().includes(search)),
    );
  }, [q, localCustomers, searchedLeads]);

  const focusProducts = () => {
    requestAnimationFrame(() => {
      const section = document.getElementById("quote-step-products");
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      requestAnimationFrame(() => {
        Array.from(document.querySelectorAll<HTMLButtonElement>('#quote-step-products button[aria-label="Item 1 product"]'))
          .find((button) => button.getClientRects().length > 0)
          ?.focus({ preventScroll: true });
      });
    });
  };

  useEffect(() => {
    const normalizedPresetId = String(presetLeadId).trim();
    if (normalizedPresetId && String(leadId).trim() === normalizedPresetId && lead) focusProducts();
  }, [presetLeadId, leadId, lead]);

  const selectDuplicateCustomer = (duplicate: DuplicateCustomer) => {
    const existing = leads.find((item) => item.id === duplicate.id) ?? created.find((item) => item.id === duplicate.id);
    if (!existing) {
      const customer: Lead = {
        id: duplicate.id,
        name: duplicate.name,
        company: "",
        phone: nl.phone.replace(/\D/g, "").slice(-10),
        area: nl.area,
        source: nl.source,
        status: duplicate.status as LeadStatus,
        assignedTo: duplicate.owner === "Unassigned" ? null : duplicate.owner,
        ownerId: undefined,
        remarks: "",
        createdOn: "",
        address: "",
        touchedBy: [],
      };
      setCreated((current) => [customer, ...current.filter((item) => item.id !== customer.id)]);
    }
    setLeadId(duplicate.id);
    setStep(2);
    setDuplicateCustomer(null);
    setAdding(false);
    focusProducts();
  };

  const selectCustomer = (id: string) => {
    setLeadId(id);
    setStep(2);
    focusProducts();
  };

  const saveNewLead = () => start(async () => {
    let res: Awaited<ReturnType<typeof addLeadAction>>;
    try {
      res = await executeMutation(addLeadAction, { ...nl, remarks: "Added from Create Quotation" });
    } catch (error) {
      setCustomerRetryable(true);
      notifyMutationFailure(error);
      return;
    }
    if (res.ok && res.data) {
      setCustomerRetryable(false);
      clearExpiredAction();
      setCreated((current) => [res.data!, ...current.filter((item) => item.id !== res.data!.id)]);
      setLeadId(res.data.id);
      setStep(2);
      setAdding(false);
      setDuplicateCustomer(null);
      setNl({ name: "", company: "", phone: "", area: "", source: "Direct Call" });
      toast.success("Customer added and selected");
      refreshSilently();
      focusProducts();
    } else if (!res.ok && res.duplicate) {
      setDuplicateCustomer(res.duplicate);
    } else if (!res.ok) {
      if (isSessionExpiredMessage(res.error)) {
        redirectForExpiredSession({ type: "add-customer", payload: nl });
        return;
      }
      setCustomerRetryable(isRetryableActionMessage(res.error));
      toast.error(res.error);
    }
  });

  const previewOffer = () => start(async () => {
    if (!lead) {
      setQuoteSaveError("Select a customer before saving the quotation.");
      return;
    }
    if (!productsValid) {
      setQuoteSaveError("Add at least one valid product before previewing.");
      return;
    }
    if (wizard.savedQuotation) {
      setStep(3);
      return;
    }
    setQuoteSaveError("");
    const subject = wizard.subject.trim() || offerSubject(items.map((item) => item.model));
    const selectedRows = rows.filter((row) => row.productId && byId.has(row.productId) &&
      validateQuoteLine(row.qty, row.discount, byId.get(row.productId)!.price) === null);
    let res: Awaited<ReturnType<typeof createQuoteAction>>;
    try {
      res = await executeMutation(createQuoteAction, { leadId: lead.id, subject, items: selectedRows });
    } catch (error) {
      const message = friendlyMutationError(error);
      setQuoteSaveError(message);
      notifyMutationFailure(error);
      return;
    }
    if (!res.ok) {
      if (isSessionExpiredMessage(res.error)) {
        redirectForExpiredSession({
          type: "create-quote",
          payload: { ...wizard, subject, step: 2, savedQuotation: undefined },
        });
        return;
      }
      setQuoteSaveError(res.error);
      toast.error(res.error);
      return;
    }
    if (!res.data) {
      const message = "Quotation save returned no saved record. Please retry.";
      setQuoteSaveError(message);
      toast.error(message);
      return;
    }
    const savedItems = selectedRows.flatMap((row) => {
      const product = byId.get(row.productId);
      return product ? [{
        productId: product.id,
        model: product.model,
        description: product.description,
        unit: product.unit,
        qty: row.qty,
        price: product.price,
        discount: Math.min(product.price * row.qty, Math.max(0, row.discount)),
      }] : [];
    });
    const saved = { ...res.data, items: savedItems };
    const alreadyCounted = savedQuotes.some((quote) => quote.id === saved.id);
    setSavedQuotesCount((count) => Math.max((count ?? 0) + (alreadyCounted ? 0 : 1), savedQuotes.length + (alreadyCounted ? 0 : 1)));
    setSavedQuotes((current) => [saved, ...current.filter((quote) => quote.id !== saved.id)]);
    setWizard((current) => ({ ...current, offerNo: saved.offerNo, subject, step: 3, savedQuotation: saved, quotationSent: false }));
    toast.success("Quotation saved as Draft");
    refreshSilently();
  });

  const markQuotationSent = async () => {
    if (!lead || wizard.quotationSent) return;
    const result = await executeMutation(markQuotationSentAction, {
      leadId: lead.id,
      ...(wizard.savedQuotation?.id ? { quoteId: wizard.savedQuotation.id } : {}),
    });
    if (!result.ok) throw new Error(result.error);
    setWizard((current) => ({
      ...current,
      quotationSent: true,
      savedQuotation: current.savedQuotation ? { ...current.savedQuotation, status: "Sent" } : undefined,
    }));
    refreshSilently();
  };

  const viewSavedQuote = async (quoteId: string) => {
    if (loadingQuoteId) return;
    setLoadingQuoteId(quoteId);
    try {
      const result = await getQuoteDetailAction(quoteId);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? "Could not load quotation details." : result.error);
        return;
      }
      setReadOnlyQuote(result.data);
      setSavedOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load quotation details.");
    } finally {
      setLoadingQuoteId(null);
    }
  };

  const openSavedQuotes = () => {
    setSavedOpen(true);
    if (savedQuotesLoaded.current || loadingMoreQuotes) return;
    setLoadingMoreQuotes(true);
    void fetch("/api/quotations?page=1")
      .then(async (response) => {
        const result = await response.json() as { quotes?: Quotation[]; hasMore?: boolean; count?: number; error?: string };
        if (!response.ok) throw new Error(result.error || "Unable to load quotations.");
        const quotes = result.quotes ?? [];
        setSavedQuotes((current) => [...quotes, ...current.filter((quote) => !quotes.some((item) => item.id === quote.id))]);
        setSavedQuotesCount((count) => Math.max(count ?? 0, result.count ?? 0, quotes.length));
        setSavedQuotesPage(1);
        setSavedQuotesHasMore(result.hasMore === true);
        savedQuotesLoaded.current = true;
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Unable to load quotations."))
      .finally(() => setLoadingMoreQuotes(false));
  };

  const loadMoreSavedQuotes = async () => {
    if (loadingMoreQuotes || !savedQuotesHasMore) return;
    setLoadingMoreQuotes(true);
    try {
      const response = await fetch(`/api/quotations?page=${savedQuotesPage + 1}`);
      const result = await response.json() as { quotes?: Quotation[]; hasMore?: boolean; count?: number; error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to load more quotations.");
      const incoming = result.quotes ?? [];
      const newQuotes = incoming.filter((quote) => !savedQuotes.some((item) => item.id === quote.id));
      setSavedQuotes((current) => [...current, ...incoming.filter((quote) => !current.some((item) => item.id === quote.id))]);
      setSavedQuotesCount((count) => Math.max(count ?? 0, result.count ?? 0, savedQuotes.length + newQuotes.length));
      setSavedQuotesPage((page) => page + 1);
      setSavedQuotesHasMore(result.hasMore === true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load more quotations.");
    } finally {
      setLoadingMoreQuotes(false);
    }
  };

  const savedMatches = [...savedQuotes]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((quote) => `${quote.offerNo} ${quote.customer}`.toLowerCase().includes(savedSearch.trim().toLowerCase()));

  const savedDialog = savedOpen && <div className="fixed inset-0 z-50 bg-black/40" onMouseDown={(event) => {
    if (event.target === event.currentTarget) setSavedOpen(false);
  }}>
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="saved-quotes-title"
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 flex h-[92dvh] max-h-[92dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-full sm:w-full sm:max-w-lg sm:rounded-none"
    >
      <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 id="saved-quotes-title" className="text-lg font-semibold">Saved quotations</h2>
        <Button type="button" variant="ghost" size="icon" aria-label="Close saved quotations" onClick={() => setSavedOpen(false)}><X /></Button>
      </header>
      <div className="shrink-0 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
          <input
            ref={savedSearchRef}
            className={`${fieldClass} pl-10`}
            type="search"
            placeholder="Search offer number or customer"
            value={savedSearch}
            onChange={(event) => setSavedSearch(event.target.value)}
            aria-label="Search saved quotations"
          />
        </div>
      </div>
      {loadingQuoteId && <p role="status" aria-live="polite" className="shrink-0 px-4 pb-3 text-sm text-muted-foreground">Loading quotation details…</p>}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pt-0">
        {loadingMoreQuotes && !savedQuotes.length ? <p className="text-sm text-muted-foreground">Loading quotations…</p>
          : !savedQuotes.length ? <p className="text-sm text-muted-foreground">No quotations yet.</p>
          : !savedMatches.length ? <p className="text-sm text-muted-foreground">No matches</p>
          : savedMatches.map((quote) => (
            <article key={quote.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{quote.customer}</div>
                  <div className="mt-1 text-sm text-muted-foreground">Offer {quote.offerNo} · {quote.date}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold">{formatINR(quote.total)}</div>
                  <StatusBadge status={quote.status ?? "Draft"} />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="button" size="sm" variant="outline" className="h-10" disabled={loadingQuoteId !== null} onClick={() => void viewSavedQuote(quote.id)}>
                  {loadingQuoteId === quote.id ? "Loading…" : "View"}
                </Button>
              </div>
            </article>
          ))}
        {savedQuotesHasMore && <Button type="button" variant="outline" className="w-full" disabled={loadingMoreQuotes} onClick={loadMoreSavedQuotes}>
          {loadingMoreQuotes && <LoaderCircle className="h-4 w-4 animate-spin" />}Load more quotations
        </Button>}
      </div>
    </section>
  </div>;

  if (readOnlyQuote) {
    const linkedLead = myLeads.find((item) => item.id === readOnlyQuote.leadId);
    const savedLead: QuotationCustomer = {
      ...linkedLead,
      id: readOnlyQuote.leadId,
      name: readOnlyQuote.contactName || linkedLead?.name || readOnlyQuote.customer || "",
      company: readOnlyQuote.company || linkedLead?.company || "",
      phone: readOnlyQuote.phone || linkedLead?.phone || "",
      area: readOnlyQuote.area || linkedLead?.area || "",
      address: readOnlyQuote.address || linkedLead?.address || "",
      source: linkedLead?.source ?? "Direct Call",
      status: linkedLead?.status ?? "Quotation Sent",
      assignedTo: linkedLead?.assignedTo ?? readOnlyQuote.executive,
      ownerId: linkedLead?.ownerId ?? readOnlyQuote.ownerId,
      remarks: linkedLead?.remarks ?? "",
      createdOn: linkedLead?.createdOn ?? readOnlyQuote.date,
      touchedBy: linkedLead?.touchedBy ?? [],
    };
    const markSavedQuoteSent = async () => {
      const result = await executeMutation(markQuotationSentAction, {
        quoteId: readOnlyQuote.id,
        ...(readOnlyQuote.leadId ? { leadId: readOnlyQuote.leadId } : {}),
      });
      if (!result.ok) throw new Error(result.error);
      setReadOnlyQuote((current) => current ? { ...current, status: "Sent" } : current);
    };
    return <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Create Quotation</h1>
        <Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={openSavedQuotes}>
          <History className="h-4 w-4" /> {savedQuotesCount === null ? "Saved quotations" : `Saved quotations (${savedQuotesCount})`}
        </Button>
      </div>
      <Offer
        lead={savedLead}
        offerNo={readOnlyQuote.offerNo}
        setOfferNo={() => undefined}
        items={readOnlyQuote.items ?? []}
        subject={readOnlyQuote.subject || offerSubject((readOnlyQuote.items ?? []).map((item) => item.model))}
        setSubject={() => undefined}
        onBack={() => setReadOnlyQuote(null)}
        onMarkSent={markSavedQuoteSent}
        readOnly
        editableOfferNo={false}
        customer={readOnlyQuote.customer}
        offerDate={readOnlyQuote.date}
        validTill={readOnlyQuote.validTill}
        savedQuoteId={readOnlyQuote.id}
        savedSubject={readOnlyQuote.subject}
        status={readOnlyQuote.status ?? "Draft"}
      />
      {savedDialog}
    </div>;
  }

  if (step === 3 && wizard.savedQuotation && lead) return <div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="text-2xl font-bold">Create Quotation</h1>
      <Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={openSavedQuotes}>
        <History className="h-4 w-4" /> {savedQuotesCount === null ? "Saved quotations" : `Saved quotations (${savedQuotesCount})`}
      </Button>
    </div>
    <QuotationStepper step={step} hasLead={!!lead} productsValid={productsValid} hasSavedQuote={hasSavedQuote} onStep={setStep} />
    <Offer lead={lead} offerNo={wizard.savedQuotation.offerNo} setOfferNo={setOfferNo} items={items} subject={wizard.subject || offerSubject(items.map((item) => item.model))} setSubject={(subject) => setWizard((current) => ({ ...current, subject }))} onBack={() => setStep(2)} onMarkSent={markQuotationSent} editableOfferNo={false} editableSubject={false} customer={wizard.savedQuotation.customer} savedQuoteId={wizard.savedQuotation.id} status={wizard.quotationSent ? "Sent" : wizard.savedQuotation.status ?? "Draft"} />
    {savedDialog}
  </div>;

  const setQty = (i: number, v: string) => upd(i, { qty: Math.min(10000, Math.max(1, Math.floor(Number(v)) || 1)) });
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i));
  return (
    <div className={`min-w-0 space-y-6 ${lead && productsValid ? "pb-[calc(14rem+env(safe-area-inset-bottom))] sm:pb-6" : "pb-6"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Create Quotation</h1>
        <Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={openSavedQuotes}>
          <History className="h-4 w-4" /> {savedQuotesCount === null ? "Saved quotations" : `Saved quotations (${savedQuotesCount})`}
        </Button>
      </div>
      <QuotationStepper step={step} hasLead={!!lead} productsValid={productsValid} hasSavedQuote={hasSavedQuote} onStep={setStep} />
      {step === 1 && <section id="quote-step-customer" className="scroll-mt-20 space-y-3 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Step 1 · Choose customer</h2>
        {adding ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <input aria-label="Contact name" className={fieldClass} placeholder="Contact name *" value={nl.name} onChange={(e) => setNl({ ...nl, name: e.target.value })} />
            <input aria-label="Company" className={fieldClass} placeholder="Company" value={nl.company} onChange={(e) => setNl({ ...nl, company: e.target.value })} />
            <input aria-label="Mobile number" className={fieldClass} placeholder="Mobile number *" inputMode="tel" value={nl.phone} onChange={(e) => setNl({ ...nl, phone: e.target.value })} />
            <input aria-label="Area" className={fieldClass} placeholder="Area" value={nl.area} onChange={(e) => setNl({ ...nl, area: e.target.value })} />
            <div>
              <SelectField aria-label="Source" disabled={!leadSources.length} value={nl.source} onValueChange={(value) => setNl({ ...nl, source: value as LeadSource })} options={leadSources.map((source) => ({ value: source, label: source }))} />
              {leadSourcesUnavailable && <Button type="button" variant="outline" className="mt-2 h-9" disabled={retryingLeadSources} onClick={() => void retryLeadSources()}>{retryingLeadSources ? "Retrying…" : "Retry loading Lead Sources"}</Button>}
              {!leadSources.length && !leadSourcesUnavailable && <p className="mt-1 text-xs text-destructive">No Lead Source values are configured in Zoho.</p>}
            </div>
            {duplicateCustomer && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm sm:col-span-2">
              <p><span className="font-semibold">{duplicateCustomer.name}</span> already exists. Owner: {duplicateCustomer.owner}.</p>
              <Button type="button" variant="outline" className="mt-2" onClick={() => selectDuplicateCustomer(duplicateCustomer)}>Use this customer</Button>
            </div>}
            <div className="flex gap-2">
              <Button type="button" className="flex-1" onClick={saveNewLead} disabled={pending || !nl.name.trim() || !nl.phone.trim() || !leadSources.length}>{pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}{pending ? "Adding…" : customerRetryable ? "Retry add customer" : "Add customer"}</Button>
              <Button type="button" variant="ghost" onClick={() => {
                setAdding(false);
                setDuplicateCustomer(null);
                setNl({ name: "", company: "", phone: "", area: "", source: "Direct Call" });
              }} disabled={pending}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            {presetLeadError && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{presetLeadError}</div>}
            {lead && <div className="rounded-lg bg-secondary p-3 text-secondary-foreground">
              <div className="font-semibold">{lead.company || lead.name}</div><div className="text-sm">{lead.name} · {lead.phone} · {lead.area}</div>
            </div>}
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-3.5 h-5 w-5 text-muted-foreground" />
                <input className={`${fieldClass} min-h-11 pl-10`} placeholder="Search name, company, mobile, area" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <Button type="button" variant="outline" onClick={() => {
                const firstSource = leadSources[0];
                if (firstSource) setNl((current) => ({ ...current, source: firstSource }));
                setAdding(true);
              }} className="h-11 w-11 shrink-0 px-0 sm:w-auto sm:px-4"><UserPlus className="h-5 w-5" /><span className="hidden sm:inline">New customer</span></Button>
            </div>
            {customerSearchPending && localMatches.length === 0 && <p role="status" className="text-sm text-muted-foreground">Searching…</p>}
            {customerSearchError && <p role="alert" className="text-sm text-destructive">{customerSearchError}</p>}
            {q.trim().length > 0 && q.trim().length < 3 && localMatches.length === 0 && <p className="text-sm text-muted-foreground">Enter at least 3 characters to search Zoho.</p>}
            <ul className="max-h-[min(55vh,32rem)] divide-y overflow-y-auto rounded-lg border">
              {matches.map((l) => (
                <li key={l.id}>
                  <button type="button" aria-pressed={leadId === l.id} className={`min-h-16 w-full px-3 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${leadId === l.id ? "bg-secondary" : ""}`} onClick={() => selectCustomer(String(l.id).trim())}>
                    <div className="break-words font-medium">{l.name}</div>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 text-sm text-muted-foreground">
                      <span className="break-words">{l.company || l.area}</span><span className="whitespace-nowrap">{l.phone}</span>
                    </div>
                  </button>
                </li>
              ))}
              {q.trim().length >= 3 && !customerSearchPending && !customerSearchError && matches.length === 0 && (
                <li className="p-3 text-sm text-muted-foreground">No customers found.</li>
              )}
              {(q.trim().length === 0 ? customerListHasMore : localMatches.length > 0 ? customerListHasMore : customerSearchHasMore) && <li className="p-2">
                <Button type="button" variant="outline" className="w-full" disabled={loadingMoreCustomers} onClick={loadMoreCustomers}>
                  {loadingMoreCustomers && <LoaderCircle className="h-4 w-4 animate-spin" />}Load more
                </Button>
              </li>}
              {!matches.length && !customerSearchPending && q.trim().length === 0 && <li className="p-3 text-sm text-muted-foreground">No customers found. Add a new one.</li>}
            </ul>
          </>
        )}
      </section>}

      {step === 2 && <section id="quote-step-products" className="scroll-mt-20 space-y-4 rounded-xl bg-card p-4 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Step 2 · Products</h2>
        {quoteSaveError && <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
          <span>{quoteSaveError}</span>
          {productsValid && <Button type="button" variant="outline" className="shrink-0" disabled={pending} onClick={previewOffer}>Retry save</Button>}
        </div>}
        {products.length === 0 && <p className="text-sm text-destructive">No products found in Zoho CRM</p>}
        <div className="hidden min-w-0 lg:block">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-secondary text-left text-secondary-foreground">
              <tr><th className="w-12 p-2">S.No</th><th className="p-2">Product</th><th className="w-20 p-2">Unit</th><th className="w-28 p-2">Qty</th><th className="w-32 p-2 text-right">Rate</th><th className="w-36 p-2 text-right">Discount</th><th className="w-36 p-2 text-right">Amount</th><th className="w-12" /></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => { const p = byId.get(r.productId); return (
                <tr key={i} className="border-b">
                  <td className="p-2">{i + 1}</td>
                  <td className="p-2"><ProductPicker products={products} value={r.productId} onChange={(productId) => upd(i, { productId })} label={`Item ${i + 1} product`} isManager={isManager} refreshing={refreshingProducts} refreshFailed={productRefreshFailed} onOpen={loadProductsOnPickerOpen} onRefresh={refreshProducts} /></td>
                  <td className="p-2">{p?.unit}</td>
                  <td className="p-2"><input aria-label="Quantity" type="number" min={1} className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></td>
                  <td className="p-2 text-right">{formatINR(p?.price ?? 0)}</td>
                  <td className="p-2"><input aria-label="Discount" type="number" min={0} className={fieldClass} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></td>
                  <td className="p-2 text-right font-semibold">{formatINR((p?.price ?? 0) * r.qty - r.discount)}</td>
                  <td className="p-2"><Button variant="ghost" size="icon" aria-label="Remove row" onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></td>
                </tr>); })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 lg:hidden">
          {rows.map((r, i) => { const p = byId.get(r.productId); return (
            <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-sm">
              <div className="flex min-h-11 items-center justify-between"><span className="font-semibold">Item {i + 1}</span>
                <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={`Remove item ${i + 1}`} onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></div>
              <ProductPicker products={products} value={r.productId} onChange={(productId) => upd(i, { productId })} label={`Item ${i + 1} product`} isManager={isManager} refreshing={refreshingProducts} refreshFailed={productRefreshFailed} onOpen={loadProductsOnPickerOpen} onRefresh={refreshProducts} />
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Quantity ({p?.unit || "Unit"})</span><div className="grid grid-cols-[44px_1fr_44px]"><Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-r-none" aria-label={`Decrease quantity for item ${i + 1}`} onClick={() => setQty(i, String(Math.max(1, r.qty - 1)))}><Minus /></Button><input aria-label={`Quantity for item ${i + 1}`} type="number" min={1} inputMode="numeric" className={`${fieldClass} min-h-11 rounded-none text-center text-base`} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /><Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-l-none" aria-label={`Increase quantity for item ${i + 1}`} onClick={() => setQty(i, String(r.qty + 1))}><Plus /></Button></div></label>
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Discount</span><input aria-label={`Discount for item ${i + 1}`} type="number" min={0} inputMode="numeric" className={`${fieldClass} min-h-11 text-base`} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></label>
              </div>
              <div className="text-sm"><span className="text-xs font-medium text-muted-foreground">Rate</span><div className="mt-1 min-h-11 rounded-lg border border-border bg-secondary px-3 py-2.5">{formatINR(p?.price ?? 0)}</div></div>
              {validateQuoteLine(r.qty, r.discount, p?.price ?? 0) && <p className="text-xs font-medium text-destructive">{validateQuoteLine(r.qty, r.discount, p?.price ?? 0)}</p>}
              <div className="text-right font-semibold"><span>Amount: </span>{r.discount > 0 && <span className="mr-2 text-sm text-muted-foreground">-{formatINR(r.discount)}</span>}<span>{formatINR(Math.max(0, (p?.price ?? 0) * r.qty - r.discount))}</span></div>
            </div>); })}
        </div>
        <Button variant="outline" size="lg" className="w-full border-dashed sm:w-auto" disabled={rows.length >= 50 || !products.length}
          onClick={() => setRows([...rows, { productId: "", qty: 1, discount: 0 }])}><Plus className="h-5 w-5" /> Add item</Button>
        <div className="hidden sm:block"><Totals t={t} /></div>
        <div className={`fixed inset-x-0 bottom-[calc(8rem+env(safe-area-inset-bottom))] z-20 p-3 sm:hidden ${lead && productsValid ? "" : "hidden"}`}>
          <div className="mx-auto max-w-md"><Totals t={t} /></div>
        </div>
        <div className={`fixed inset-x-0 bottom-16 z-20 border-t border-border bg-card p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] shadow-sm sm:hidden ${lead && productsValid ? "" : "hidden"}`}>
          <div className="mx-auto flex max-w-md gap-2">
            <Button type="button" variant="outline" className="h-12 flex-1" onClick={() => setStep(1)}>Back</Button>
            <Button type="button" size="lg" className="h-12 flex-1" disabled={pending || !productsValid} onClick={previewOffer}>Preview</Button>
          </div>
        </div>
        <div className="hidden gap-3 sm:flex">
          <Button type="button" variant="outline" className="h-14" onClick={() => setStep(1)}>Back</Button>
          <Button type="button" size="lg" className="h-14 flex-1 text-base" disabled={pending || !productsValid} onClick={previewOffer}><Eye className="h-5 w-5" /> {pending ? "Saving…" : "Preview Offer"}</Button>
        </div>
      </section>}

      {savedDialog}
    </div>
  );
}

function ProductPicker({ products, value, onChange, label, isManager, refreshing, refreshFailed, onOpen, onRefresh }: {
  products: Product[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  isManager: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = products.find((product) => product.id === value);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = products.filter((product) =>
    `${product.model} ${product.code ?? ""} ${product.description ?? ""}`.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => { setQuery(""); setOpen(true); onOpen(); }}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          {selected ? <><span className="block truncate font-medium">{selected.model}</span><span className="block text-xs text-muted-foreground">{formatINR(selected.price)}</span></> : <span className="text-muted-foreground">Select product</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && <div
        className="fixed inset-0 z-[60] flex items-end bg-black/40 md:items-center md:justify-center md:p-4"
        onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-picker-title"
          className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl md:max-w-lg md:rounded-2xl"
        >
          <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <h2 id="product-picker-title" className="font-semibold">Choose product</h2>
            {isManager && <Button type="button" variant="outline" size="sm" className="ml-auto mr-2" disabled={refreshing} onClick={onRefresh}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : refreshFailed ? "Retry refresh" : "Refresh products"}
            </Button>}
            <Button type="button" variant="ghost" size="icon" className="h-11 w-11" aria-label="Close product picker" onClick={() => setOpen(false)}><X /></Button>
          </header>
          <div className="shrink-0 p-4 pb-2">
            <label htmlFor={`product-search-${label.replace(/\W/g, "-")}`} className="sr-only">Search products by name, code or description</label>
            <input
              ref={searchRef}
              id={`product-search-${label.replace(/\W/g, "-")}`}
              className={`${fieldClass} min-h-11 text-base`}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, code or description"
            />
            <p className="mt-2 text-xs text-muted-foreground">{matches.length} {matches.length === 1 ? "product" : "products"}</p>
          </div>
          <div className="min-h-0 max-h-[60dvh] flex-1 overflow-y-auto overscroll-contain px-4 pb-4" role="listbox" aria-label="Products">
            {matches.map((product) => (
              <button
                key={product.id}
                type="button"
                role="option"
                aria-selected={product.id === value}
                onClick={() => { onChange(product.id); setOpen(false); }}
                className={`min-h-16 w-full border-b border-border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${product.id === value ? "bg-secondary text-secondary-foreground" : "hover:bg-secondary/60"}`}
              >
                <span className="block break-words text-sm font-medium">{product.model}</span>
                <span className="block text-xs text-muted-foreground">{product.unit} · {formatINR(product.price)}</span>
              </button>
            ))}
            {!matches.length && <p className="p-4 text-sm text-muted-foreground">No products found</p>}
          </div>
        </section>
      </div>}
    </>
  );
}

function Totals({ t }: { t: { subtotal: number; discount: number; gst: number; total: number } }) {
  return (
    <dl className="ml-auto max-w-sm space-y-1 rounded-lg bg-secondary p-4 text-secondary-foreground">
      <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatINR(t.subtotal)}</dd></div>
      <div className="flex justify-between"><dt>Discount</dt><dd>-{formatINR(t.discount)}</dd></div>
      <div className="flex justify-between"><dt>Tax</dt><dd>{formatINR(t.gst)}</dd></div>
      <div className="flex justify-between text-lg font-bold"><dt>Grand Total</dt><dd>{formatINR(t.total)}</dd></div>
    </dl>
  );
}

type Item = { productId?: string; model: string; description?: string; unit: string; qty: number; price: number; discount?: number };

class SharePreparationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SharePreparationError";
  }
}

function Offer({ lead, offerNo, setOfferNo, items, subject, setSubject, onBack, onMarkSent, readOnly = false, editableOfferNo = true, editableSubject = true, customer: savedCustomer, offerDate, validTill: savedValidTill, savedQuoteId, savedSubject, status = "Draft" }: {
 lead: QuotationCustomer; offerNo: string; setOfferNo: (s: string) => void; items: Item[]; subject: string; setSubject: (subject: string) => void;
  onBack: () => void; onMarkSent: () => Promise<void>;
  readOnly?: boolean; editableOfferNo?: boolean; editableSubject?: boolean; customer?: string; offerDate?: string; validTill?: string; savedQuoteId?: string; savedSubject?: string; status?: string;
}) {
  const t = quoteTotals(items);
  const customer = savedCustomer?.trim() || lead.company.trim() || lead.name.trim();
  const parts = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "2-digit" }).formatToParts(new Date());
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const savedDateParts = offerDate?.split("-");
  const date = savedDateParts?.length === 3
    ? `${savedDateParts[2]}.${savedDateParts[1]}.${savedDateParts[0]?.slice(-2)}`
    : `${datePart("day")}.${datePart("month")}.${datePart("year")}`;
  const hasDiscount = items.some((item) => (item.discount ?? 0) > 0);
  const splitParts = splitQuotationItems(items);
  const basicAmount = (item: Item) => item.qty * item.price;
  const lineAmount = (item: Item) => basicAmount(item) - (item.discount ?? 0);
  const validTillDate = new Date(offerDate ? `${offerDate}T12:00:00Z` : Date.now());
  validTillDate.setDate(validTillDate.getDate() + 30);
  const validTill = savedValidTill ? new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(new Date(`${savedValidTill}T12:00:00+05:30`)) : new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(validTillDate);
  const renderPart = (part: Item[], title: string, gst: string, startIndex = 0) => (
    <section className="mt-4">
      <div className="border-y border-border py-2 text-center font-bold">{title}</div>
      <table className="w-full table-fixed border-collapse text-[9px]">
        <thead><tr>{["S.No", "Description", "Unit", "Qty", ...(hasDiscount ? ["Discount (Rs)"] : []), "Basic Rate (Rs)", "Amount (Rs)"].map((heading) => <th key={heading} className="break-words border border-border px-1 py-2">{heading}</th>)}</tr></thead>
        <tbody>{part.map((item, index) => (
          <tr key={`${item.model}-${index}`} className="border border-border">
            <td className="border border-border px-1 py-2 text-center">{startIndex + index + 1}</td>
            <td className="border border-border px-1 py-2"><span className="font-semibold">{item.model}</span>{item.description && <div className="mt-1 break-words text-muted-foreground">{item.description}</div>}</td>
            <td className="border border-border px-1 py-2 text-center">{item.unit}</td>
            <td className="border border-border px-1 py-2 text-center">{item.qty}</td>
            {hasDiscount && <td className="border border-border px-1 py-2 text-right">{formatINR(item.discount ?? 0)}</td>}
            <td className="border border-border px-1 py-2 text-right">{formatINR(item.price)}</td>
            <td className="border border-border px-1 py-2 text-right">{formatINR(lineAmount(item))}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="mt-1 grid grid-cols-2 border border-border p-2 font-semibold"><span>Basic Sub Total - {title.includes("PART A") ? "Part A" : "Part B"}</span><span className="text-right">{formatINR(quoteTotals(part).total)}</span></div>
      <div className="mt-1 text-center text-[10px] font-semibold">{gst}</div>
    </section>
  );
  const shortMessage = `Offer ${offerNo} for ${customer || "customer"}\nGrand total: ${formatINR(t.total)}\n${COMPANY.name}`;
  const resolvedWaPhone = normalizeWhatsAppPhone(lead.phone);
  const canCreatePdf = canCreateQuotationPdf({ offerNo, customer, leadId: lead.id, items }, !!savedQuoteId);
  const [downloading, setDownloading] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [phoneEntryOpen, setPhoneEntryOpen] = useState(false);
  const [phoneEntry, setPhoneEntry] = useState("");
  const missingBlobHintShown = useRef(false);
  const buildPdfFile = async (): Promise<File> => {
    if (!offerNo.trim()) throw new Error("Offer reference is missing.");
    if (!customer.trim() && !savedQuoteId) throw new Error("Customer name is missing.");
    if (!lead.id.trim() && !savedQuoteId) throw new Error("Customer record is missing.");
    if (!items.length || (!savedQuoteId && items.some((item) => !item.productId))) throw new Error("Add at least one valid product.");
    const response = await fetch("/api/quotations/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(savedQuoteId ? { quoteId: savedQuoteId } : { leadId: lead.id }),
        offerNo,
        subject: savedSubject || subject,
        items: items.map((item) => ({ productId: item.productId, qty: item.qty, discount: item.discount ?? 0 })),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      let message: string | undefined;
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") message = parsed.error;
      } catch {
        message = undefined;
      }
      throw new Error(message || `Unable to create the PDF (HTTP ${response.status}).`);
    }
    const blob = new Blob([await response.blob()], { type: "application/pdf" });
    return new File([blob], `offer-${offerNo.replace("/", "-")}.pdf`, { type: "application/pdf" });
  };
  const prepareShareUrl = async () => {
    if (!offerNo.trim()) throw new Error("Offer reference is missing.");
    if (!customer.trim() && !savedQuoteId) throw new Error("Customer name is missing.");
    if (!lead.id.trim() && !savedQuoteId) throw new Error("Customer record is missing.");
    const response = await fetch("/api/quotations/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(savedQuoteId ? { quoteId: savedQuoteId } : { leadId: lead.id }),
        offerNo,
        subject: savedSubject || subject,
        items: items.map((item) => ({ productId: item.productId, qty: item.qty, discount: item.discount ?? 0 })),
      }),
    });
    const result = await response.json().catch(() => null) as { url?: string; error?: string } | null;
    if (!response.ok || !result?.url) {
      throw new SharePreparationError(result?.error || `Could not prepare a shareable PDF (HTTP ${response.status}).`, response.status);
    }
    setShareUrl(result.url);
    return result.url;
  };
  const downloadFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const downloadPdf = async () => {
    if (downloading || !canCreatePdf) return;
    setDownloading(true);
    try {
      downloadFile(await buildPdfFile());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create the PDF.");
    } finally {
      setDownloading(false);
    }
  };
  const shareOnWhatsApp = async (phoneValue = resolvedWaPhone) => {
    if (downloading) return;
    const waPhone = normalizeWhatsAppPhone(phoneValue);
    if (!waPhone && !phoneValue.trim()) {
      setPhoneEntry("");
      setPhoneEntryOpen(true);
      return;
    }
    if (!waPhone) {
      toast.error("No valid mobile number is available for this customer.");
      return;
    }
    const openWhatsApp = (message: string) => {
      const url = `https://wa.me/91${waPhone}?text=${encodeURIComponent(message)}`;
      if (window.matchMedia("(max-width: 767px)").matches) window.location.assign(url);
      else window.open(url, "_blank", "noopener");
    };
    const markSentInBackground = () => {
      void onMarkSent().catch(notifyMutationFailure);
    };
    setDownloading(true);
    let showBlobHint = false;
    try {
      let message = shortMessage;
      if (canCreatePdf) {
        try {
          const publicUrl = await prepareShareUrl();
          message = `${shortMessage}\nPDF: ${publicUrl}`;
        } catch (error) {
          if (!(error instanceof SharePreparationError && error.status === 503 && error.message.includes("BLOB_READ_WRITE_TOKEN"))) throw error;
          downloadFile(await buildPdfFile());
          showBlobHint = !missingBlobHintShown.current;
          missingBlobHintShown.current = true;
        }
      }
      openWhatsApp(message);
      setPhoneEntryOpen(false);
      markSentInBackground();
      toast.success(`WhatsApp opened for ${customer || "customer"}`, showBlobHint
        ? { description: "PDF downloaded; attach it to the chat." }
        : undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not share the quotation PDF.");
    } finally {
      setDownloading(false);
    }

  };
  const copyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("PDF link copied");
    } catch {
      toast.error("Could not copy the PDF link. Please copy it from the address bar.");
    }
  };

  return (
    <>
    <div className="min-w-0 space-y-4 pb-[calc(9rem+env(safe-area-inset-bottom))] sm:pb-6">
      <div className="no-print flex min-w-0 items-center justify-between gap-2">
        <Button type="button" variant="ghost" className="h-11 shrink-0 px-2" onClick={onBack}><ArrowLeft className="h-5 w-5" /> Back</Button>
        {shareUrl && <Button type="button" variant="outline" className="h-11 sm:hidden" onClick={copyShareLink}><Copy className="h-4 w-4" /> Copy link</Button>}
        <div className="hidden min-w-0 flex-wrap justify-end gap-2 sm:flex">
          <Button className="h-12" onClick={downloadPdf} disabled={downloading || !canCreatePdf}><Printer className="h-5 w-5" /> {downloading ? "Preparing…" : "Download PDF"}</Button>
          <Button variant="outline" title={!resolvedWaPhone ? "Enter the customer's mobile number to continue" : undefined} className="h-12 bg-white text-slate-900 hover:bg-slate-50 hover:text-slate-900" onClick={() => void shareOnWhatsApp()} disabled={downloading}><WhatsAppIcon className="h-5 w-5" /> {downloading ? "Preparing…" : "WhatsApp"}</Button>
          {shareUrl && <Button type="button" variant="outline" className="h-12" onClick={copyShareLink}><Copy className="h-4 w-4" /> Copy link</Button>}
        </div>
      </div>
      <div className="no-print fixed inset-x-0 bottom-16 z-30 border-t border-border bg-card p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] shadow-lg sm:hidden">
        <div className="mx-auto flex max-w-md gap-2">
          <Button className="h-12 min-w-0 flex-1 whitespace-nowrap" onClick={downloadPdf} disabled={downloading || !canCreatePdf}>
            <Printer className="h-5 w-5 shrink-0" /> {downloading ? "Preparing…" : "Download PDF"}
          </Button>
          <Button variant="outline" title={!resolvedWaPhone ? "Enter the customer's mobile number to continue" : undefined} className="h-12 min-w-0 flex-1 whitespace-nowrap bg-white text-slate-900 hover:bg-slate-50 hover:text-slate-900" onClick={() => void shareOnWhatsApp()} disabled={downloading}>
            <WhatsAppIcon className="h-5 w-5 shrink-0" /> {downloading ? "Preparing…" : "WhatsApp"}
          </Button>
        </div>
      </div>
      <article className="print-area offer-document mx-auto min-w-0 max-w-full rounded-xl bg-card p-3 text-[11px] leading-snug shadow-sm sm:max-w-3xl sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
          <Image src="/brand/atpl-logo.png" alt="Air Trendz" width={150} height={60} sizes="150px" quality={100} className="h-auto max-w-full object-contain" priority />
          <div className="max-w-full text-right">
            <div className="text-lg font-bold">Air Trendz Pvt. Ltd.</div>
            <div className="mt-1 text-[10px]">{COMPANY.address}</div>
            <div className="text-[10px]">{COMPANY.contact}</div>
            <div className="mt-1 text-[10px] font-semibold">GSTIN - {COMPANY.gstin}</div>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
          <div className="offer-no-break space-y-1 border-slate-300 sm:border-r sm:pr-4">
            <h1 id="offer-heading" tabIndex={-1} className="text-base font-bold outline-none">OFFER</h1>
            <label className="grid grid-cols-[70px_1fr] items-center gap-2"><span className="font-semibold">Offer Ref</span>
              {readOnly || !editableOfferNo ? <span className="font-medium">{offerNo.trim() || "Offer reference unavailable"}</span> : <input aria-label="Offer reference" className="h-8 rounded-lg border border-input px-2 font-medium" pattern="\d{1,4}/\d{2}-\d{2}" value={offerNo} onChange={(event) => setOfferNo(event.target.value)} maxLength={9} />}
            </label>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Stage</span><span>{status}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Valid Till</span><span>{validTill}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Date</span><span>{date}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Sales Person</span><span>{COMPANY.signatory}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Amount</span><span>{formatINR(t.subtotal)}</span></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="offer-no-break">
              <div className="font-bold">Bill To</div>
              <div className="mt-1">{lead.name.trim() || customer.trim() || lead.company.trim() || "Customer details not saved with this quote"}</div>
              {lead.company.trim() && lead.company.trim() !== lead.name.trim() && <div>{lead.company.trim()}</div>}
              {lead.address?.trim() && <div>{lead.address.trim()}</div>}
              {!lead.address?.trim() && lead.area.trim() && <div>{lead.area.trim()}</div>}
              {lead.phone.trim() && <div>{lead.phone.trim()}</div>}
            </div>
            <div className="offer-no-break">
              <div className="font-bold">Ship To</div>
              <div className="mt-1">{lead.name.trim() || customer.trim() || lead.company.trim() || "Customer details not saved with this quote"}</div>
              {lead.company.trim() && lead.company.trim() !== lead.name.trim() && <div>{lead.company.trim()}</div>}
              {lead.address?.trim() && <div>{lead.address.trim()}</div>}
              {!lead.address?.trim() && lead.area.trim() && <div>{lead.area.trim()}</div>}
              {lead.phone.trim() && <div>{lead.phone.trim()}</div>}
            </div>
          </div>
        </div>

        <section>
          <p>Dear Sir,</p>
          <div className="mt-2 flex items-baseline gap-1 font-semibold">
            <span>Sub:</span>
            {readOnly || !editableSubject ? <span>{subject}</span> : <input
                aria-label="Quotation subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 font-semibold outline-none print:border-0 print:outline-none"
              />}
          </div>
          <p className="mt-2 text-justify">{OFFER_TEXT.enquiry}</p>
        </section>

        <section className="mt-4 grid grid-cols-[1fr_auto] gap-2 border border-border p-3">
          <div><span className="font-bold">EQUIPMENT REQUIRED</span>{items.filter((item) => !/^B\s*-\s*/i.test(item.model)).map((item) => <div key={item.model}>{item.model} / {item.qty} / {item.unit}</div>)}</div>
          <div className="font-bold">Total Units: {items.reduce((sum, item) => sum + item.qty, 0)}</div>
        </section>
        <div className="min-w-0 max-w-full">
          {renderPart(splitParts.equipment, OFFER_TEXT.partA, OFFER_TEXT.partAGst)}
          {splitParts.ancillary.length > 0 && renderPart(splitParts.ancillary, OFFER_TEXT.partB, OFFER_TEXT.partBGst, splitParts.equipment.length)}
        </div>
        <div className="mt-3 grid grid-cols-2 border border-border p-2 font-bold"><span>TOTAL PART A + B</span><span className="text-right">{formatINR(t.total)}</span></div>

        <div className="offer-no-break mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2">
          <div>
            <div className="font-bold">Authority Signature</div>
            <div className="mt-5">for {COMPANY.name}</div>
            <div>{COMPANY.signatory}</div>
            <div>{COMPANY.phones}</div>
          </div>
          <div className="text-right">
            <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>Sub Total</span><span>{formatINR(t.subtotal)}</span></div>
            <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>GST</span><span>{formatINR(0)}</span></div>
            <div className="mt-1 grid grid-cols-[1fr_auto] gap-6 bg-muted px-2 py-2 font-bold text-foreground"><span>Grand Total</span><span>{formatINR(t.subtotal)}</span></div>
          </div>
        </div>

        <section className="mt-4 space-y-2">
          <div className="offer-no-break"><span className="font-bold">NOTE</span><p>Quantities are tentative and final billing will be based on actual measurements.</p></div>
          <div className="offer-no-break"><div className="font-bold">ITEMS EXCLUDED</div><ol className="list-decimal pl-5"><li>Main incoming electrical cabling &amp; civil works such as core cutting, wall chipping in client scope</li><li>In case of Cat walk requirement for outdoor unit, the same shall be in client scope</li></ol></div>
          <div className="offer-no-break"><div className="font-bold">TERMS &amp; CONDITIONS</div>
            <dl className="grid grid-cols-[90px_1fr] gap-x-2">
              <dt>Validity</dt><dd>30 days</dd>
              <dt>Delivery</dt><dd>1-2 weeks from the date of order</dd>
              <dt>Payment Terms</dt><dd>100% advance for equipment; 60% advance for Part B and 40% on completion</dd>
            </dl>
          </div>
          <p>We hope our offer is in line with your requirement and look forward to receive your valued order.</p>
          <p>Thanking you and assuring you of our best attention at all times, we remain,</p>
        </section>
      </article>
    </div>
    {phoneEntryOpen && <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="quotation-phone-title"
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          void shareOnWhatsApp(phoneEntry);
        }}
      >
        <div>
          <h2 id="quotation-phone-title" className="font-semibold">Enter a WhatsApp number</h2>
          <p className="mt-1 text-sm text-muted-foreground">Use a 10-digit Indian mobile number. You can include +91.</p>
        </div>
        <input
          autoFocus
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          aria-label="WhatsApp phone number"
          className={`${fieldClass} h-11`}
          placeholder="+91 98765 43210"
          value={phoneEntry}
          onChange={(event) => setPhoneEntry(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={() => setPhoneEntryOpen(false)}>Cancel</Button>
          <Button type="submit" className="h-11" disabled={downloading || !normalizeWhatsAppPhone(phoneEntry)}>Continue</Button>
        </div>
      </form>
    </div>}
    </>
  );
}
