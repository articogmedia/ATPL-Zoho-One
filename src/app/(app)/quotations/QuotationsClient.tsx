"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ArrowLeft, Check, ChevronDown, Copy, Eye, History, LoaderCircle, Mail, Minus, Plus, Printer, Search, Trash2, UserPlus, X, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { EmptyState, PageHeader, ResponsiveTable, StatusBadge, fieldClass } from "@/components/ui-bits";
import { clearExpiredAction, isRetryableActionMessage, isSessionExpiredMessage, readExpiredAction, redirectForExpiredSession } from "@/lib/session-recovery";
import { executeMutation, friendlyMutationError, notifyMutationFailure } from "@/lib/use-mutation";
import { addLeadAction, createProductAction, createQuoteAction, getLeadSourcesAction, getProductsAction, getQuoteDetailAction, getQuotationPdfUrlAction, markQuotationSentAction, refreshProductsAction, sendQuotationEmailAction, setLeadOutcomeAction, updateQuoteAction } from "@/app/actions/crm";
import { COMPANY, OFFER_TEXT, offerSubject } from "@/lib/company";
import { canCreateQuotationPdf, formatOfferReference, formatQuotationMoney, splitQuotationItems } from "@/lib/quotation-presentation";
import { formatINR, GST_RATE, LOST_REASONS, quotationGstBreakdown, uniqueProducts, validateQuoteLine, type Lead, type LeadSource, type LeadStatus, type LostReason, type Product, type Quotation, type QuoteExtraCharge, type QuoteGstBreakdown, type QuoteGstTotals } from "@/lib/domain";

type Row = { productId: string; qty: number; discount: number; taxRate: number };
type WizardState = {
  step: 1 | 2 | 3;
  leadId: string;
  rows: Row[];
  offerNo: string;
  subject: string;
  extraCharges: QuoteExtraCharge[];
  editingQuoteId?: string;
  savedQuotation?: Quotation;
  quotationSent: boolean;
};
type DuplicateCustomer = { id: string; name: string; owner: string; status: string };
type QuotationCustomer = Pick<Lead, "id" | "name" | "company" | "phone" | "email" | "area" | "source" | "status" | "assignedTo">
  & Partial<Pick<Lead, "assignedToId" | "ownerId" | "remarks" | "createdOn" | "address" | "touchedBy" | "followUp" | "followUpTime">>;
type Props = { leads: QuotationCustomer[]; initialCustomersHasMore: boolean; initialSavedQuotesCount?: number; leadSources: LeadSource[]; leadSourcesUnavailable: boolean; products: Product[]; isManager: boolean; suggestedOfferNo: string; presetLeadId: string; presetLeadError?: string };

function normalizeWhatsAppPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("91")
    ? digits.slice(2)
    : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^\d{10}$/.test(national) ? national : "";
}

function QuotationStepper({ step, hasLead, productsValid, hasSavedQuote, customerLocked = false, onStep }: {
  step: 1 | 2 | 3; hasLead: boolean; productsValid: boolean; hasSavedQuote: boolean; customerLocked?: boolean; onStep: (step: 1 | 2 | 3) => void;
}) {
  return <nav aria-label="Quotation progress" className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-card p-2">
    {(["Customer", "Products", "Preview"] as const).map((label, index) => {
      const stepNumber = (index + 1) as 1 | 2 | 3;
      const completed = stepNumber < step || (stepNumber === 1 && hasLead) || (stepNumber === 2 && productsValid);
      const disabled = (customerLocked && stepNumber === 1) || stepNumber > step || (stepNumber === 2 && !hasLead) || (stepNumber === 3 && !hasSavedQuote);
      const active = stepNumber === step;
      return <button type="button" key={label} disabled={disabled} onClick={() => onStep(stepNumber)} className={`flex min-h-11 items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-xs font-semibold transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${active ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`} aria-current={active ? "step" : undefined}>
        {completed && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}<span>{stepNumber}. {label}</span>
      </button>;
    })}
  </nav>;
}

async function storeQuotationPdf(quote: Quotation, snapshotToken?: string): Promise<string> {
  const response = await fetch("/api/quotations/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteId: quote.id,
      ...(snapshotToken ? { quoteSnapshotToken: snapshotToken } : {}),
      offerNo: quote.offerNo,
      subject: quote.subject || offerSubject((quote.items ?? []).map((item) => item.model)),
      items: (quote.items ?? []).map((item) => ({
        ...(item.productId ? { productId: item.productId } : {}),
        qty: item.qty,
        discount: item.discount ?? 0,
        taxRate: item.taxRate ?? GST_RATE,
      })),
      extraCharges: quote.gstBreakdown?.extraCharges ?? [],
    }),
  });
  const result = await response.json().catch(() => null) as { url?: string; error?: string } | null;
  if (!response.ok || !result?.url) throw new Error(result?.error || "Could not generate and store the quotation PDF.");
  return result.url;
}

export function QuotationsClient({ leads, initialCustomersHasMore, initialSavedQuotesCount, leadSources: initialLeadSources, leadSourcesUnavailable: initialLeadSourcesUnavailable, products: initialProducts, isManager, suggestedOfferNo, presetLeadId, presetLeadError }: Props) {
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
      rows: [{ productId: "", qty: 1, discount: 0, taxRate: GST_RATE }],
      offerNo: suggestedOfferNo,
      subject: "",
      extraCharges: [],
      quotationSent: false,
    };
  });
  const { step, leadId, rows } = wizard;
  const extraCharges = wizard.extraCharges ?? [];
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
    ...current, leadId: nextLeadId, subject: "", extraCharges: [], savedQuotation: undefined, quotationSent: false,
  }));
  const setRows = (nextRows: Row[] | ((currentRows: Row[]) => Row[])) => setWizard((current) => ({
    ...current,
    rows: typeof nextRows === "function" ? nextRows(current.rows) : nextRows,
    subject: "",
    savedQuotation: undefined,
    quotationSent: false,
  }));
  const setExtraCharges = (next: QuoteExtraCharge[] | ((current: QuoteExtraCharge[]) => QuoteExtraCharge[])) => setWizard((current) => ({
    ...current,
    extraCharges: typeof next === "function" ? next(current.extraCharges ?? []) : next,
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
  const [savedStatusFilter, setSavedStatusFilter] = useState("All");
  const [savedDateFrom, setSavedDateFrom] = useState("");
  const [savedDateTo, setSavedDateTo] = useState("");
  const [loadingQuoteId, setLoadingQuoteId] = useState<string | null>(null);
  const [readOnlyQuote, setReadOnlyQuote] = useState<Quotation | null>(null);
  const [emailSavedQuoteId, setEmailSavedQuoteId] = useState<string | null>(null);
  const [readOnlyPdfUrl, setReadOnlyPdfUrl] = useState("");
  const [pdfUrls, setPdfUrls] = useState<Record<string, string>>({});
  const [pdfPreparing, setPdfPreparing] = useState(false);
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
  const items = rows.flatMap((r) => { const p = byId.get(r.productId); return p ? [{ productId: p.id, model: p.model, description: p.description, unit: p.unit, price: p.price, qty: r.qty, discount: r.discount, taxRate: r.taxRate ?? p.gstRate ?? GST_RATE }] : []; });
  const t = quotationGstBreakdown(items, extraCharges);
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
    if (wizard.savedQuotation && !wizard.editingQuoteId) {
      setStep(3);
      return;
    }
    setQuoteSaveError("");
    const subject = wizard.subject.trim() || offerSubject(items.map((item) => item.model));
    const selectedRows = rows.flatMap((row) => {
      const product = byId.get(row.productId);
      return product && validateQuoteLine(row.qty, row.discount, product.price) === null
        ? [{ ...row, taxRate: row.taxRate ?? product.gstRate ?? GST_RATE }]
        : [];
    });
    let res: Awaited<ReturnType<typeof createQuoteAction>>;
    try {
      const input = {
        leadId: lead.id,
        subject,
        items: selectedRows,
        extraCharges,
        ...(wizard.editingQuoteId ? { quoteId: wizard.editingQuoteId } : {}),
      };
      res = wizard.editingQuoteId
        ? await executeMutation(updateQuoteAction, input)
        : await executeMutation(createQuoteAction, input);
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
        taxRate: row.taxRate ?? product.gstRate ?? GST_RATE,
      }] : [];
    });
    const saved = { ...res.data, items: res.data.items ?? savedItems };
    const editingQuote = Boolean(wizard.editingQuoteId);
    if (!editingQuote) {
      const alreadyCounted = savedQuotes.some((quote) => quote.id === saved.id);
      setSavedQuotesCount((count) => Math.max((count ?? 0) + (alreadyCounted ? 0 : 1), savedQuotes.length + (alreadyCounted ? 0 : 1)));
    }
    setSavedQuotes((current) => [saved, ...current.filter((quote) => quote.id !== saved.id)]);
    setWizard((current) => ({
      ...current,
      offerNo: saved.offerNo,
      subject,
      step: 3,
      savedQuotation: saved,
      editingQuoteId: undefined,
      quotationSent: saved.status === "Sent",
    }));
    if (editingQuote) {
      setPdfUrls((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
    }
    setPdfPreparing(true);
    let pdfUrl = "";
    try {
      pdfUrl = await storeQuotationPdf(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate and store the quotation PDF.";
      setQuoteSaveError(`Quotation saved, but its PDF could not be stored: ${message}`);
      toast.error("Quotation saved, but its PDF could not be stored.");
    } finally {
      setPdfPreparing(false);
    }
    if (pdfUrl) setPdfUrls((current) => ({ ...current, [saved.id]: pdfUrl }));
    toast.success(editingQuote ? `Quotation updated (R${saved.revision ?? 1})` : "Quotation saved as Draft");
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
  };

  const viewSavedQuote = async (quoteId: string) => {
    if (loadingQuoteId) return;
    setLoadingQuoteId(quoteId);
    try {
      const pdfResult = await getQuotationPdfUrlAction(quoteId);
      if (!pdfResult.ok) {
        toast.error(pdfResult.error);
        return;
      }
      if (pdfResult.data) {
        setReadOnlyPdfUrl(pdfResult.data);
        setSavedOpen(false);
        return;
      }
      const result = await getQuoteDetailAction(quoteId);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? "Could not load quotation details." : result.error);
        return;
      }
      try {
        const url = await storeQuotationPdf(result.data, result.data.pdfSnapshotToken);
        setPdfUrls((current) => ({ ...current, [quoteId]: url }));
        setReadOnlyPdfUrl(url);
        setSavedOpen(false);
        return;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not generate the saved quotation PDF.");
      }
      setReadOnlyQuote(result.data);
      setSavedOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load quotation details.");
    } finally {
      setLoadingQuoteId(null);
    }
  };

  const emailSavedQuote = async (quoteId: string) => {
    if (loadingQuoteId) return;
    setLoadingQuoteId(quoteId);
    let quote: Quotation | null = null;
    try {
      const result = await getQuoteDetailAction(quoteId);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? "Could not load quotation details." : result.error);
        return;
      }
      quote = result.data;
      let url = pdfUrls[quoteId];
      if (!url) {
        const pdfResult = await getQuotationPdfUrlAction(quoteId);
        if (!pdfResult.ok) throw new Error(pdfResult.error);
        url = pdfResult.data || await storeQuotationPdf(result.data, result.data.pdfSnapshotToken);
      }
      setPdfUrls((current) => ({ ...current, [quoteId]: url }));
      setReadOnlyQuote(result.data);
      setReadOnlyPdfUrl("");
      setEmailSavedQuoteId(quoteId);
      setSavedOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare the quotation email.";
      if (quote && message.includes("BLOB_READ_WRITE_TOKEN")) {
        setReadOnlyQuote(quote);
        setReadOnlyPdfUrl("");
        setEmailSavedQuoteId(quoteId);
        setSavedOpen(false);
      } else {
        toast.error(message);
      }
    } finally {
      setLoadingQuoteId(null);
    }
  };

  const editSavedQuote = async (quoteId: string) => {
    if (loadingQuoteId) return;
    setLoadingQuoteId(quoteId);
    try {
      const result = await getQuoteDetailAction(quoteId);
      if (!result.ok || !result.data) {
        toast.error(result.ok ? "Could not load quotation details." : result.error);
        return;
      }
      const quote = result.data;
      if (quote.status && ["sent", "won"].includes(quote.status.trim().toLowerCase()) && !isManager) {
        toast.error("Only managers can edit Sent or Won quotations.");
        return;
      }
      const quoteItems = quote.items ?? [];
      const editRows = quoteItems.map((item) => {
        const product = (item.productId ? products.find((candidate) => candidate.id === item.productId) : undefined)
          ?? products.find((candidate) => candidate.model.trim().toLowerCase() === item.model.trim().toLowerCase());
        return product ? {
          productId: product.id,
          qty: item.qty,
          discount: item.discount ?? 0,
          taxRate: item.taxRate ?? GST_RATE,
        } : null;
      });
      if (!editRows.length || editRows.some((row) => row === null)) {
        toast.error("One or more saved products are no longer in the catalogue. Refresh products before editing this quotation.");
        return;
      }
      const customer: QuotationCustomer = {
        id: quote.leadId,
        name: quote.contactName || quote.customer,
        company: quote.company ?? "",
        phone: quote.phone ?? "",
        email: quote.email,
        area: quote.area ?? "",
        address: quote.address ?? "",
        source: "Direct Call",
        status: "Quotation Sent",
        assignedTo: quote.executive,
        ownerId: quote.ownerId,
      };
      setCreated((current) => [customer, ...current.filter((item) => item.id !== customer.id)]);
      setWizard({
        step: 2,
        leadId: quote.leadId,
        rows: editRows.filter((row): row is Row => row !== null),
        offerNo: quote.offerNo,
        subject: (quote.subject ?? "").replace(/^Offer\s+.+?\s+-\s+/i, "").trim(),
        extraCharges: quote.gstBreakdown?.extraCharges ?? [],
        editingQuoteId: quote.id,
        quotationSent: false,
      });
      setQuoteSaveError("");
      setReadOnlyQuote(null);
      setReadOnlyPdfUrl("");
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
    .filter((quote) =>
      `${quote.offerNo} ${quote.customer}`.toLowerCase().includes(savedSearch.trim().toLowerCase()) &&
      (savedStatusFilter === "All" || (quote.status ?? "Draft") === savedStatusFilter) &&
      (!savedDateFrom || quote.date >= savedDateFrom) &&
      (!savedDateTo || quote.date <= savedDateTo),
    );

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
      <div className="shrink-0 space-y-3 border-b border-border p-4">
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <SelectField aria-label="Filter quotations by status" className="min-w-0" value={savedStatusFilter} onValueChange={setSavedStatusFilter} options={[
            { value: "All", label: "All statuses" },
            ...[...new Set(savedQuotes.map((quote) => quote.status ?? "Draft"))].map((status) => ({ value: status, label: status })),
          ]} />
          <input aria-label="Quotations from date" type="date" className={fieldClass} value={savedDateFrom} onChange={(event) => setSavedDateFrom(event.target.value)} />
          <input aria-label="Quotations to date" type="date" className={fieldClass} value={savedDateTo} onChange={(event) => setSavedDateTo(event.target.value)} />
        </div>
      </div>
      {loadingQuoteId && <p role="status" aria-live="polite" className="shrink-0 px-4 pb-3 text-sm text-muted-foreground">Opening saved quotation PDF…</p>}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pt-0">
        {loadingMoreQuotes && !savedQuotes.length ? <p className="text-sm text-muted-foreground">Loading quotations…</p>
          : !savedQuotes.length ? <EmptyState message="No quotations yet." className="py-5" />
          : !savedMatches.length ? <p className="text-sm text-muted-foreground">No matches</p>
          : <ResponsiveTable
            cardsOnly
            label="Saved quotations"
            rows={savedMatches}
            getKey={(quote) => quote.id}
            columns={[
              { key: "customer", header: "Customer", render: (quote) => <span className="font-semibold">{quote.customer}</span> },
              { key: "offer", header: "Offer", render: (quote) => <> {quote.offerNo}{quote.revision ? `/R${quote.revision}` : ""}</> },
              { key: "date", header: "Date", render: (quote) => quote.date },
              { key: "total", header: "Total", align: "right", render: (quote) => formatINR(quote.total) },
              { key: "status", header: "Status", render: (quote) => <StatusBadge status={quote.status ?? "Draft"} /> },
              { key: "actions", header: "Actions", align: "right", render: (quote) => <div className="flex justify-end gap-1 whitespace-nowrap">
                <Button type="button" size="sm" variant="outline" className="h-10" disabled={loadingQuoteId !== null || (!isManager && ["sent", "won"].includes((quote.status ?? "").trim().toLowerCase()))} title={!isManager && ["sent", "won"].includes((quote.status ?? "").trim().toLowerCase()) ? "Only managers can edit Sent or Won quotations." : undefined} onClick={() => void editSavedQuote(quote.id)}>Edit</Button>
                <Button type="button" size="sm" variant="outline" className="h-10" disabled={loadingQuoteId !== null} onClick={() => void emailSavedQuote(quote.id)}>{loadingQuoteId === quote.id ? "Loading…" : <><Mail className="h-4 w-4" />Email</>}</Button>
                <Button type="button" size="sm" variant="outline" className="h-10" disabled={loadingQuoteId !== null} onClick={() => void viewSavedQuote(quote.id)}>{loadingQuoteId === quote.id ? "Loading…" : "View"}</Button>
              </div> },
            ]}
            renderCard={(quote) => <article className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{quote.customer}</div>
                  <div className="mt-1 text-sm text-muted-foreground">Offer {quote.offerNo}{quote.revision ? `/R${quote.revision}` : ""} · {quote.date}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold">{formatINR(quote.total)}</div>
                  <StatusBadge status={quote.status ?? "Draft"} />
                </div>
              </div>
              <details className="relative mt-3">
                <summary className="flex h-11 cursor-pointer list-none items-center justify-center rounded-lg border border-border text-sm font-medium">Actions</summary>
                <div className="absolute right-0 z-10 mt-1 flex min-w-36 flex-col gap-1 rounded-lg border border-border bg-card p-2 shadow-lg">
                  <Button type="button" variant="ghost" className="justify-start" disabled={loadingQuoteId !== null || (!isManager && ["sent", "won"].includes((quote.status ?? "").trim().toLowerCase()))} onClick={() => void editSavedQuote(quote.id)}>Edit</Button>
                  <Button type="button" variant="ghost" className="justify-start" disabled={loadingQuoteId !== null} onClick={() => void emailSavedQuote(quote.id)}>Email</Button>
                  <Button type="button" variant="ghost" className="justify-start" disabled={loadingQuoteId !== null} onClick={() => void viewSavedQuote(quote.id)}>View</Button>
                </div>
              </details>
            </article>}
          />}
        {savedQuotesHasMore && <Button type="button" variant="outline" className="w-full" disabled={loadingMoreQuotes} onClick={loadMoreSavedQuotes}>
          {loadingMoreQuotes && <LoaderCircle className="h-4 w-4 animate-spin" />}Load more quotations
        </Button>}
      </div>
    </section>
  </div>;

  if (readOnlyPdfUrl) return <div className="space-y-4">
    <PageHeader title="Saved quotation PDF" mobileFloating={false} action={<div className="flex flex-wrap gap-2">
        <a className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium" href={readOnlyPdfUrl} target="_blank" rel="noopener noreferrer">Open PDF</a>
        <Button type="button" variant="outline" onClick={() => { setReadOnlyPdfUrl(""); setSavedOpen(true); }}>Back to quotations</Button>
      </div>} />
    <iframe title="Saved quotation PDF" src={readOnlyPdfUrl} className="h-[78dvh] w-full rounded-lg border border-border bg-white" />
  </div>;

  if (readOnlyQuote) {
    const linkedLead = myLeads.find((item) => item.id === readOnlyQuote.leadId);
    const savedLead: QuotationCustomer = {
      ...linkedLead,
      id: readOnlyQuote.leadId,
      name: readOnlyQuote.contactName || linkedLead?.name || readOnlyQuote.customer || "",
      company: readOnlyQuote.company || linkedLead?.company || "",
      phone: readOnlyQuote.phone || linkedLead?.phone || "",
      email: readOnlyQuote.email || linkedLead?.email,
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
      <PageHeader title="Saved quotation PDF" action={<Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={openSavedQuotes}>
          <History className="h-4 w-4" /> {savedQuotesCount === null ? "Saved quotations" : `Saved quotations (${savedQuotesCount})`}
        </Button>} mobileFloating={false} />
      <Offer
        lead={savedLead}
        offerNo={readOnlyQuote.offerNo}
        revision={readOnlyQuote.revision}
        setOfferNo={() => undefined}
        items={readOnlyQuote.items ?? []}
        extraCharges={readOnlyQuote.gstBreakdown?.extraCharges ?? []}
        subject={readOnlyQuote.subject || offerSubject((readOnlyQuote.items ?? []).map((item) => item.model))}
        setSubject={() => undefined}
        onBack={() => setReadOnlyQuote(null)}
        onMarkSent={markSavedQuoteSent}
        readOnly
        editableOfferNo={false}
        customer={readOnlyQuote.customer}
        savedTotal={readOnlyQuote.total}
        savedStatus={readOnlyQuote.status}
        storedPdfUrl={pdfUrls[readOnlyQuote.id]}
        gstBreakdown={readOnlyQuote.gstBreakdown}
        offerDate={readOnlyQuote.date}
        validTill={readOnlyQuote.validTill}
        savedQuoteId={readOnlyQuote.id}
        savedSubject={readOnlyQuote.subject}
        emailInitiallyOpen={emailSavedQuoteId === readOnlyQuote.id}
        onEmailDialogOpenConsumed={() => setEmailSavedQuoteId(null)}
      />
      {savedDialog}
    </div>;
  }

  if (step === 3 && wizard.savedQuotation && lead) return <div className="space-y-6">
    <PageHeader title="Create Quotation" action={<Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={openSavedQuotes}>
        <History className="h-4 w-4" /> {savedQuotesCount === null ? "Saved quotations" : `Saved quotations (${savedQuotesCount})`}
      </Button>} mobileFloating={false} />
    {pdfPreparing && <p role="status" aria-live="polite" className="rounded-lg border border-border bg-muted p-3 text-sm">Generating and storing the quotation PDF…</p>}
    {quoteSaveError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{quoteSaveError}</p>}
    <QuotationStepper step={step} hasLead={!!lead} productsValid={productsValid} hasSavedQuote={hasSavedQuote} onStep={setStep} />
    <Offer lead={lead} offerNo={wizard.savedQuotation.offerNo} revision={wizard.savedQuotation.revision} setOfferNo={setOfferNo} items={wizard.savedQuotation.items ?? items} extraCharges={wizard.savedQuotation.gstBreakdown?.extraCharges ?? extraCharges} subject={wizard.subject || offerSubject((wizard.savedQuotation.items ?? items).map((item) => item.model))} setSubject={(subject) => setWizard((current) => ({ ...current, subject }))} onBack={() => setStep(2)} onMarkSent={markQuotationSent} editableOfferNo={false} editableSubject={false} customer={wizard.savedQuotation.customer} savedTotal={wizard.savedQuotation.total} savedStatus={wizard.savedQuotation.status} storedPdfUrl={pdfUrls[wizard.savedQuotation.id]} gstBreakdown={wizard.savedQuotation.gstBreakdown} savedQuoteId={wizard.savedQuotation.id} />
    {savedDialog}
  </div>;

  const setQty = (i: number, v: string) => upd(i, { qty: Math.min(10000, Math.max(1, Math.floor(Number(v)) || 1)) });
  const remove = (i: number) => setRows(rows.filter((_, j) => j !== i));
  return (
    <div className={`min-w-0 space-y-6 ${lead && productsValid ? "pb-[calc(14rem+env(safe-area-inset-bottom))] lg:pb-6" : "pb-6"}`}>
      <PageHeader title="Create Quotation" action={<Button ref={savedButtonRef} variant="outline" className="h-11 w-full sm:w-auto" onClick={openSavedQuotes}>
          <History className="h-4 w-4" /> {savedQuotesCount === null ? "Saved quotations" : `Saved quotations (${savedQuotesCount})`}
        </Button>} mobileFloating={false} />
      <QuotationStepper step={step} hasLead={!!lead} productsValid={productsValid} hasSavedQuote={hasSavedQuote} customerLocked={!!wizard.editingQuoteId} onStep={setStep} />
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
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
        <div className="hidden min-w-0 overflow-x-auto xl:block">
          <table className="w-full min-w-[1040px] table-fixed border-separate border-spacing-0 text-sm">
            <thead className="bg-secondary text-left text-secondary-foreground">
              <tr>
                <th className="w-14 rounded-tl-lg px-3 py-3">S.No</th>
                <th className="w-[30%] px-3 py-3">Product</th>
                <th className="w-20 px-3 py-3">Unit</th>
                <th className="w-28 px-3 py-3">Qty</th>
                <th className="w-32 px-3 py-3 text-right">Rate</th>
                <th className="w-32 px-3 py-3 text-right">Discount</th>
                <th className="w-28 px-3 py-3">GST %</th>
                <th className="w-36 px-3 py-3 text-right">Amount</th>
                <th className="w-14 rounded-tr-lg" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => { const p = byId.get(r.productId); return (
                <tr key={i} className="border-b border-border/70 align-middle hover:bg-muted/30">
                  <td className="px-3 py-3">{i + 1}</td>
                  <td className="px-3 py-3"><ProductPicker products={products} value={r.productId} onChange={(productId, product) => upd(i, { productId, taxRate: product?.gstRate ?? byId.get(productId)?.gstRate ?? GST_RATE })} onCreated={(product) => setProducts((current) => uniqueProducts([...current, product]))} label={`Item ${i + 1} product`} isManager={isManager} refreshing={refreshingProducts} refreshFailed={productRefreshFailed} onOpen={loadProductsOnPickerOpen} onRefresh={refreshProducts} /></td>
                  <td className="px-3 py-3">{p?.unit}</td>
                  <td className="px-3 py-3"><input aria-label="Quantity" type="number" min={1} className={fieldClass} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /></td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">{formatINR(p?.price ?? 0)}</td>
                  <td className="px-3 py-3"><input aria-label="Discount" type="number" min={0} className={fieldClass} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></td>
                  <td className="px-3 py-3"><TaxRateField compact label={`GST rate for item ${i + 1}`} value={r.taxRate ?? p?.gstRate ?? GST_RATE} onChange={(taxRate) => { if (taxRate !== undefined) upd(i, { taxRate }); }} /></td>
                  <td className="px-3 py-3 text-right font-semibold whitespace-nowrap">{formatINR((p?.price ?? 0) * r.qty - r.discount)}</td>
                  <td className="px-3 py-3"><Button variant="ghost" size="icon" aria-label="Remove row" onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></td>
                </tr>); })}
            </tbody>
          </table>
        </div>
        <div className="space-y-3 xl:hidden">
          {rows.map((r, i) => { const p = byId.get(r.productId); return (
            <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-3 shadow-sm">
              <div className="flex min-h-11 items-center justify-between"><span className="font-semibold">Item {i + 1}</span>
                <Button variant="ghost" size="icon" className="h-11 w-11" aria-label={`Remove item ${i + 1}`} onClick={() => remove(i)}><Trash2 className="h-5 w-5" /></Button></div>
              <ProductPicker products={products} value={r.productId} onChange={(productId, product) => upd(i, { productId, taxRate: product?.gstRate ?? byId.get(productId)?.gstRate ?? GST_RATE })} onCreated={(product) => setProducts((current) => uniqueProducts([...current, product]))} label={`Item ${i + 1} product`} isManager={isManager} refreshing={refreshingProducts} refreshFailed={productRefreshFailed} onOpen={loadProductsOnPickerOpen} onRefresh={refreshProducts} />
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Quantity ({p?.unit || "Unit"})</span><div className="grid grid-cols-[44px_1fr_44px]"><Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-r-none" aria-label={`Decrease quantity for item ${i + 1}`} onClick={() => setQty(i, String(Math.max(1, r.qty - 1)))}><Minus /></Button><input aria-label={`Quantity for item ${i + 1}`} type="number" min={1} inputMode="numeric" className={`${fieldClass} min-h-11 rounded-none text-center text-base`} value={r.qty} onChange={(e) => setQty(i, e.target.value)} /><Button type="button" variant="outline" size="icon" className="h-11 w-11 rounded-l-none" aria-label={`Increase quantity for item ${i + 1}`} onClick={() => setQty(i, String(r.qty + 1))}><Plus /></Button></div></label>
                <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Discount</span><input aria-label={`Discount for item ${i + 1}`} type="number" min={0} inputMode="numeric" className={`${fieldClass} min-h-11 text-base`} value={r.discount} onChange={(e) => upd(i, { discount: Math.max(0, Number(e.target.value) || 0) })} /></label>
                <TaxRateField label={`GST rate for item ${i + 1}`} value={r.taxRate ?? p?.gstRate ?? GST_RATE} onChange={(taxRate) => { if (taxRate !== undefined) upd(i, { taxRate }); }} />
              </div>
              <div className="text-sm"><span className="text-xs font-medium text-muted-foreground">Rate</span><div className="mt-1 min-h-11 rounded-lg border border-border bg-secondary px-3 py-2.5">{formatINR(p?.price ?? 0)}</div></div>
              {validateQuoteLine(r.qty, r.discount, p?.price ?? 0) && <p className="text-xs font-medium text-destructive">{validateQuoteLine(r.qty, r.discount, p?.price ?? 0)}</p>}
              <div className="text-right font-semibold"><span>Amount: </span>{r.discount > 0 && <span className="mr-2 text-sm text-muted-foreground">-{formatINR(r.discount)}</span>}<span>{formatINR(Math.max(0, (p?.price ?? 0) * r.qty - r.discount))}</span></div>
            </div>); })}
        </div>
        <Button variant="outline" size="lg" className="w-full border-dashed sm:w-auto" disabled={rows.length >= 50 || !products.length}
          onClick={() => setRows([...rows, { productId: "", qty: 1, discount: 0, taxRate: GST_RATE }])}><Plus className="h-5 w-5" /> Add item</Button>
        <section aria-label="Extra charges" className="space-y-3 rounded-xl border border-border p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">Extra charges</h3>
            <Button type="button" variant="outline" size="sm" onClick={() => setExtraCharges((current) => [...current, { label: "", amount: 0 }])}><Plus className="h-4 w-4" /> Add charge</Button>
          </div>
          {extraCharges.map((charge, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_auto] sm:items-end">
              <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Charge label</span><input aria-label={`Extra charge ${index + 1} label`} className={fieldClass} maxLength={100} value={charge.label} placeholder="Freight, installation…" onChange={(event) => setExtraCharges((current) => current.map((item, row) => row === index ? { ...item, label: event.target.value } : item))} /></label>
              <label className="space-y-1"><span className="block text-xs font-medium text-muted-foreground">Amount</span><input aria-label={`Extra charge ${index + 1} amount`} className={fieldClass} type="number" min={0} step="0.01" value={charge.amount} onChange={(event) => setExtraCharges((current) => current.map((item, row) => row === index ? { ...item, amount: Math.max(0, Number(event.target.value) || 0) } : item))} /></label>
              <TaxRateField label={`GST rate for extra charge ${index + 1}`} allowNoTax value={charge.taxRate} onChange={(taxRate) => setExtraCharges((current) => current.map((item, row) => {
                if (row !== index) return item;
                const next = { ...item };
                if (taxRate === undefined) delete next.taxRate;
                else next.taxRate = taxRate;
                return next;
              }))} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove extra charge ${index + 1}`} onClick={() => setExtraCharges((current) => current.filter((_, row) => row !== index))}><Trash2 className="h-5 w-5" /></Button>
            </div>
          ))}
        </section>
        </div>
        <aside className="hidden lg:block">
          <div className="2xl:sticky 2xl:top-24"><Totals t={t} /></div>
        </aside>
        </div>
        <div className={`fixed inset-x-0 bottom-[calc(8rem+env(safe-area-inset-bottom))] z-20 p-3 lg:hidden ${lead && productsValid ? "" : "hidden"}`}>
          <div className="mx-auto max-w-md"><Totals t={t} /></div>
        </div>
        <div className={`fixed inset-x-0 bottom-16 z-20 border-t border-border bg-card p-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] shadow-sm lg:hidden ${lead && productsValid ? "" : "hidden"}`}>
          <div className="mx-auto flex max-w-md gap-2">
            <Button type="button" variant="outline" className="h-12 flex-1" disabled={!!wizard.editingQuoteId} onClick={() => setStep(1)}>Back</Button>
            <Button type="button" size="lg" className="h-12 flex-1" disabled={pending || !productsValid} onClick={previewOffer}>{wizard.editingQuoteId ? "Save revision" : "Preview"}</Button>
          </div>
        </div>
        <div className="hidden gap-3 lg:flex">
          <Button type="button" variant="outline" className="h-14" disabled={!!wizard.editingQuoteId} onClick={() => setStep(1)}>Back</Button>
          <Button type="button" size="lg" className="h-14 flex-1 text-base" disabled={pending || !productsValid} onClick={previewOffer}><Eye className="h-5 w-5" /> {pdfPreparing ? "Generating PDF…" : pending ? (wizard.editingQuoteId ? "Saving revision…" : "Saving…") : wizard.editingQuoteId ? "Save revision" : "Preview Offer"}</Button>
          {pdfPreparing && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Saving quotation and generating its PDF…</p>}
        </div>
      </section>}

      {savedDialog}
    </div>
  );
}

function ProductPicker({ products, value, onChange, onCreated, label, isManager, refreshing, refreshFailed, onOpen, onRefresh }: {
  products: Product[];
  value: string;
  onChange: (value: string, product?: Product) => void;
  onCreated: (product: Product) => void;
  label: string;
  isManager: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const PRODUCT_OPTION_HEIGHT = 56;
  const PRODUCT_OVERSCAN = 4;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [addingProduct, setAddingProduct] = useState(false);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [createError, setCreateError] = useState("");
  const [newProduct, setNewProduct] = useState<{ name: string; code: string; unit: string; price: string; gstRate: number }>({ name: "", code: "", unit: "Nos", price: "", gstRate: GST_RATE });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = products.find((product) => product.id === value);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = products.filter((product) =>
    `${product.model} ${product.code ?? ""} ${product.description ?? ""}`.toLowerCase().includes(normalizedQuery),
  );
  const firstVisibleIndex = Math.max(0, Math.floor(scrollTop / PRODUCT_OPTION_HEIGHT) - PRODUCT_OVERSCAN);
  const visibleCount = Math.ceil(Math.max(listViewportHeight, PRODUCT_OPTION_HEIGHT) / PRODUCT_OPTION_HEIGHT) + PRODUCT_OVERSCAN * 2;
  const lastVisibleIndex = Math.min(matches.length, firstVisibleIndex + visibleCount);

  const createProduct = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingProduct) return;
    setCreatingProduct(true);
    setCreateError("");
    try {
      const result = await createProductAction({ ...newProduct, price: Number(newProduct.price) });
      if (!result.ok || !result.data) {
        setCreateError(result.ok ? "The product was created without a result. Refresh the catalogue and try again." : result.error);
        return;
      }
      onCreated(result.data);
      onChange(result.data.id, result.data);
      toast.success(`${result.data.model} added to products`);
      setAddingProduct(false);
      setOpen(false);
      setNewProduct({ name: "", code: "", unit: "Nos", price: "", gstRate: GST_RATE });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add the product.";
      setCreateError(message);
      toast.error(message);
    } finally {
      setCreatingProduct(false);
    }
  };

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

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const updateViewportHeight = () => setListViewportHeight(list.clientHeight);
    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(list);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    setScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [normalizedQuery]);

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
          className="flex h-[80dvh] min-h-0 w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl md:max-h-[80dvh] md:max-w-[720px] md:rounded-2xl"
        >
          <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border px-2 py-2 sm:gap-2 sm:px-4">
            <h2 id="product-picker-title" className="min-w-0 flex-1 truncate font-semibold">{addingProduct ? "Add new product" : "Choose product"}</h2>
            {isManager && !addingProduct && <Button type="button" variant="outline" size="sm" className="ml-auto mr-2" onClick={() => { setCreateError(""); setAddingProduct(true); }}>
              <Plus className="h-4 w-4 shrink-0" /><span className="hidden sm:inline">Add new product</span><span className="sm:hidden">Add</span>
            </Button>}
            {isManager && addingProduct && <Button type="button" variant="outline" size="sm" className="ml-auto mr-2" onClick={() => { setCreateError(""); setAddingProduct(false); }}>
              <span className="hidden sm:inline">Back to products</span><span className="sm:hidden">Back</span>
            </Button>}
            {isManager && !addingProduct && <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
              <RefreshCw className={`h-4 w-4 shrink-0 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{refreshing ? "Refreshing…" : refreshFailed ? "Retry refresh" : "Refresh"}</span>
            </Button>}
            <Button type="button" variant="ghost" size="icon" className="h-10 w-10 shrink-0" aria-label="Close product picker" onClick={() => setOpen(false)}><X /></Button>
          </header>
          {!addingProduct && <div className="sticky top-0 z-10 shrink-0 border-b border-border bg-card p-4 pb-2">
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
          </div>}
          {addingProduct ? <form onSubmit={createProduct} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Product name</span>
              <input aria-label="New product name" className={fieldClass} maxLength={120} required value={newProduct.name} onChange={(event) => setNewProduct((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="block space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Product code</span>
              <input aria-label="New product code" className={fieldClass} maxLength={60} required value={newProduct.code} onChange={(event) => setNewProduct((current) => ({ ...current, code: event.target.value }))} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">Unit</span>
                <input aria-label="New product unit" className={fieldClass} maxLength={40} required value={newProduct.unit} onChange={(event) => setNewProduct((current) => ({ ...current, unit: event.target.value }))} />
              </label>
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">Price</span>
                <input aria-label="New product price" className={fieldClass} type="number" min="0.01" step="0.01" required value={newProduct.price} onChange={(event) => setNewProduct((current) => ({ ...current, price: event.target.value }))} />
              </label>
            </div>
            <TaxRateField label="New product GST rate" value={newProduct.gstRate} onChange={(gstRate) => { if (gstRate !== undefined) setNewProduct((current) => ({ ...current, gstRate })); }} />
            {createError && <p role="alert" className="text-sm text-destructive">{createError}</p>}
            <Button type="submit" className="w-full" disabled={creatingProduct}>
              {creatingProduct ? "Adding product…" : "Add product"}
            </Button>
          </form> : <div
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
            role="listbox"
            aria-label="Products"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div aria-hidden="true" style={{ height: firstVisibleIndex * PRODUCT_OPTION_HEIGHT }} />
            {matches.slice(firstVisibleIndex, lastVisibleIndex).map((product, visibleIndex) => {
              const index = firstVisibleIndex + visibleIndex;
              return (
              <button
                key={product.id}
                type="button"
                role="option"
                aria-selected={product.id === value}
                aria-posinset={index + 1}
                aria-setsize={matches.length}
                onClick={() => { onChange(product.id, product); setOpen(false); }}
                className={`grid h-14 w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${product.id === value ? "bg-secondary text-secondary-foreground" : "hover:bg-secondary/60"}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium" title={product.model}>{product.model}</span>
                  <span className="block truncate text-xs text-muted-foreground">{product.code || product.description || " "}</span>
                </span>
                <span className="text-right text-xs text-muted-foreground"><span className="block">{product.unit}</span><span className="block font-medium text-foreground">{formatINR(product.price)}</span></span>
              </button>
              );
            })}
            <div aria-hidden="true" style={{ height: (matches.length - lastVisibleIndex) * PRODUCT_OPTION_HEIGHT }} />
            {!matches.length && <p className="p-4 text-sm text-muted-foreground">No products found</p>}
          </div>}
        </section>
      </div>}
    </>
  );
}

function Totals({ t }: { t: QuoteGstBreakdown }) {
  return (
    <dl className="ml-auto w-full max-w-md space-y-2 rounded-xl border border-border bg-card p-4 text-foreground shadow-sm sm:p-5">
      <div className="mb-3 border-b border-border pb-3"><dt className="text-sm font-semibold text-foreground">Quotation summary</dt><dd className="mt-1 text-xs text-muted-foreground">Tax and pricing breakdown</dd></div>
      <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatINR(t.subtotal)}</dd></div>
      {t.discount > 0 && <div className="flex justify-between"><dt>Discount</dt><dd>-{formatINR(t.discount)}</dd></div>}
      {(t.gstByRate ?? []).map((group) => <div key={group.rate} className="flex justify-between"><dt>GST @ {formatTaxRate(group.rate)}%</dt><dd>{formatINR(group.amount)}</dd></div>)}
      {(t.extraCharges ?? []).map((charge, index) => <div key={`${charge.label}-${index}`} className="flex justify-between"><dt>{charge.label}{charge.taxRate !== undefined ? ` (+ GST ${formatTaxRate(charge.taxRate)}%)` : ""}</dt><dd>{formatINR(charge.amount)}</dd></div>)}
      <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-primary/8 px-3 py-3 text-base font-bold text-foreground"><dt>Grand Total</dt><dd className="text-lg tabular-nums">{formatINR(t.total)}</dd></div>
    </dl>
  );
}

const GST_RATE_OPTIONS = [0, 5, 12, 18, 28] as const;
const formatTaxRate = (rate: number) => String(Number((rate * 100).toFixed(2)));

function TaxRateField({ label, value, onChange, allowNoTax = false, compact = false }: {
  label: string;
  value: number | undefined;
  onChange: (rate: number | undefined) => void;
  allowNoTax?: boolean;
  compact?: boolean;
}) {
  const isPreset = value === undefined ? allowNoTax : GST_RATE_OPTIONS.some((rate) => rate / 100 === value);
  return <label className="block min-w-0 space-y-1">
    <span className={compact ? "sr-only" : "block text-xs font-medium text-muted-foreground"}>{label}</span>
    <select
      aria-label={label}
      className={`${fieldClass} min-h-11 w-full min-w-[5rem] text-sm`}
      value={value === undefined && allowNoTax ? "none" : isPreset ? String((value ?? GST_RATE) * 100) : "custom"}
      onChange={(event) => {
        if (event.target.value === "none") onChange(undefined);
        else if (event.target.value === "custom") onChange(value !== undefined && !isPreset ? value : 18);
        else onChange(Number(event.target.value) / 100);
      }}
    >
      {allowNoTax && <option value="none">No GST</option>}
      {GST_RATE_OPTIONS.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
      <option value="custom">Custom</option>
    </select>
    {!isPreset && <input
      aria-label={`${label} custom percent`}
      className={`${fieldClass} mt-1 min-h-11`}
      type="number"
      min={0}
      max={100}
      step="0.01"
      value={formatTaxRate(value ?? GST_RATE)}
      onChange={(event) => onChange(Math.min(100, Math.max(0, Number(event.target.value) || 0)) / 100)}
    />}
  </label>;
}

type Item = { productId?: string; model: string; description?: string; unit: string; qty: number; price: number; discount?: number; taxRate?: number };

class SharePreparationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SharePreparationError";
  }
}

function Offer({ lead, offerNo, revision = 0, setOfferNo, items, extraCharges, subject, setSubject, onBack, onMarkSent, readOnly = false, editableOfferNo = true, editableSubject = true, customer: savedCustomer, savedTotal, savedStatus, storedPdfUrl, offerDate, validTill: savedValidTill, savedQuoteId, savedSubject, gstBreakdown, emailInitiallyOpen = false, onEmailDialogOpenConsumed }: {
 lead: QuotationCustomer; offerNo: string; revision?: number; setOfferNo: (s: string) => void; items: Item[]; extraCharges: QuoteExtraCharge[]; subject: string; setSubject: (subject: string) => void;
  onBack: () => void; onMarkSent: () => Promise<void>;
  readOnly?: boolean; editableOfferNo?: boolean; editableSubject?: boolean; customer?: string; savedTotal?: number; savedStatus?: string; storedPdfUrl?: string; offerDate?: string; validTill?: string; savedQuoteId?: string; savedSubject?: string; gstBreakdown?: QuoteGstBreakdown; emailInitiallyOpen?: boolean; onEmailDialogOpenConsumed?: () => void;
}) {
  const isLegacySavedQuote = !!savedQuoteId && !gstBreakdown;
  const computedBreakdown = quotationGstBreakdown(items, extraCharges);
  const t: QuoteGstBreakdown = gstBreakdown ?? (isLegacySavedQuote
    ? { ...computedBreakdown, gst: 0, gstByRate: [], total: savedTotal ?? items.reduce((sum, item) => sum + item.qty * item.price - (item.discount ?? 0), 0) }
    : computedBreakdown);
  const displayedGstByRate = gstBreakdown?.gstByRate ?? (isLegacySavedQuote ? [] : computedBreakdown.gstByRate);
  const displayedExtraCharges = gstBreakdown?.extraCharges ?? extraCharges;
  const offerMoney = formatQuotationMoney;
  const offerReference = formatOfferReference(offerNo, items, revision);
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
  const renderPart = (part: Item[], title: string, gst: string, startIndex = 0, storedTotals?: QuoteGstTotals) => {
    const partTotals: QuoteGstTotals = storedTotals ?? (isLegacySavedQuote
      ? {
          subtotal: part.reduce((sum, item) => sum + item.qty * item.price, 0),
          discount: 0,
          gst: 0,
          total: part.reduce((sum, item) => sum + item.qty * item.price - (item.discount ?? 0), 0),
        }
      : quotationGstBreakdown(part).partA);
    const partGstByRate = quotationGstBreakdown(part).gstByRate ?? [];
    return (
    <section className="mt-4">
      <div className="border-y border-border py-2 text-center font-bold">{title}</div>
      <table className="w-full table-fixed border-collapse text-[9px]">
        <thead><tr>{["S.No", "Description", "Unit", "Qty", ...(hasDiscount ? ["Discount (Rs)"] : []), "Basic Rate (Rs)", "GST %", "Amount (Rs)"].map((heading) => <th key={heading} className="break-words border border-border px-1 py-2">{heading}</th>)}</tr></thead>
        <tbody>{part.map((item, index) => (
          <tr key={`${item.model}-${index}`} className="border border-border">
            <td className="border border-border px-1 py-2 text-center">{startIndex + index + 1}</td>
            <td className="border border-border px-1 py-2"><span className="font-semibold">{item.model}</span>{item.description && <div className="mt-1 break-words text-muted-foreground">{item.description}</div>}</td>
            <td className="border border-border px-1 py-2 text-center">{item.unit}</td>
            <td className="border border-border px-1 py-2 text-center">{item.qty}</td>
            {hasDiscount && <td className="border border-border px-1 py-2 text-right">{offerMoney(item.discount ?? 0)}</td>}
            <td className="border border-border px-1 py-2 text-right">{offerMoney(item.price)}</td>
            <td className="border border-border px-1 py-2 text-right">{formatTaxRate(item.taxRate ?? GST_RATE)}%</td>
            <td className="border border-border px-1 py-2 text-right">{offerMoney(lineAmount(item))}</td>
          </tr>
        ))}</tbody>
      </table>
      {isLegacySavedQuote
        ? <><div className="mt-1 grid grid-cols-2 border border-border p-2 font-semibold"><span>Basic Sub Total - {title.includes("PART A") ? "Part A" : "Part B"}</span><span className="text-right">{offerMoney(partTotals.total)}</span></div><div className="mt-1 text-center text-[10px] font-semibold">{gst}</div></>
        : <div className="mt-1 space-y-1 border border-border p-2 text-sm">
            <div className="grid grid-cols-2 font-semibold"><span>Subtotal - {title.includes("PART A") ? "Part A" : "Part B"}</span><span className="text-right">{offerMoney(partTotals.subtotal)}</span></div>
            {partTotals.discount > 0 && <div className="grid grid-cols-2"><span>Discount</span><span className="text-right">-{offerMoney(partTotals.discount)}</span></div>}
            {partGstByRate.map((group) => <div key={group.rate} className="grid grid-cols-2"><span>GST @ {formatTaxRate(group.rate)}%</span><span className="text-right">{offerMoney(group.amount)}</span></div>)}
            <div className="grid grid-cols-2 border-t border-border pt-1 font-bold"><span>Total - {title.includes("PART A") ? "Part A" : "Part B"}</span><span className="text-right">{offerMoney(partTotals.total)}</span></div>
          </div>}
    </section>
  );};
  const shortMessage = `Offer ${offerReference} for ${customer || "customer"}\nGrand total: ${offerMoney(t.total)}\n${COMPANY.name}`;
  const resolvedWaPhone = normalizeWhatsAppPhone(lead.phone);
  const canCreatePdf = canCreateQuotationPdf({ offerNo, customer, leadId: lead.id, items }, !!savedQuoteId);
  const [downloading, setDownloading] = useState(false);
  const [shareUrl, setShareUrl] = useState(storedPdfUrl ?? "");
  const [phoneEntryOpen, setPhoneEntryOpen] = useState(false);
  const [phoneEntry, setPhoneEntry] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState(lead.email ?? "");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason | "">("");
  const [outcomeStatus, setOutcomeStatus] = useState(savedStatus ?? "Draft");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const missingBlobHintShown = useRef(false);
  useEffect(() => {
    if (storedPdfUrl) setShareUrl(storedPdfUrl);
  }, [storedPdfUrl]);
  useEffect(() => {
    setEmailRecipient(lead.email ?? "");
  }, [lead.email]);
  useEffect(() => {
    if (!emailInitiallyOpen) return;
    setEmailOpen(true);
    onEmailDialogOpenConsumed?.();
  }, [emailInitiallyOpen, onEmailDialogOpenConsumed]);

  const buildPdfFile = async (): Promise<File> => {
    if (!offerNo.trim()) throw new Error("Offer reference is missing.");
    if (!customer.trim() && !savedQuoteId) throw new Error("Customer name is missing.");
    if (!lead.id.trim() && !savedQuoteId) throw new Error("Customer record is missing.");
    if (!items.length || (!savedQuoteId && items.some((item) => !item.productId))) throw new Error("Add at least one valid product.");
    const response = shareUrl
      ? await fetch(shareUrl)
      : await fetch("/api/quotations/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(savedQuoteId ? { quoteId: savedQuoteId } : { leadId: lead.id }),
            offerNo,
            subject: savedSubject || subject,
            items: items.map((item) => ({ productId: item.productId, qty: item.qty, discount: item.discount ?? 0, taxRate: item.taxRate ?? GST_RATE })),
            extraCharges,
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
    if (shareUrl) return shareUrl;
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
        items: items.map((item) => ({ productId: item.productId, qty: item.qty, discount: item.discount ?? 0, taxRate: item.taxRate ?? GST_RATE })),
        extraCharges,
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
          const publicUrl = shareUrl || await prepareShareUrl();
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
  const emailQuotation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!savedQuoteId || sendingEmail) return;
    setSendingEmail(true);
    const downloadForManualEmail = async (message: string) => {
      if (!message.includes("BLOB_READ_WRITE_TOKEN")) return false;
      downloadFile(await buildPdfFile());
      setEmailOpen(false);
      toast.warning("PDF storage is unavailable. The PDF was downloaded; attach it to your email.");
      return true;
    };
    try {
      await prepareShareUrl();
      const result = await sendQuotationEmailAction({ quoteId: savedQuoteId, to: emailRecipient.trim() });
      if (!result.ok) {
        if (await downloadForManualEmail(result.error)) return;
        toast.error(result.error);
        return;
      }
      toast.success(`Quotation emailed to ${emailRecipient.trim()}`, result.data?.noteLogged === false
        ? { description: "The email was sent, but its CRM note could not be logged." }
        : undefined);
      setEmailOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not send the quotation email.";
      try {
        if (await downloadForManualEmail(message)) return;
      } catch (downloadError) {
        toast.error(downloadError instanceof Error ? downloadError.message : "Could not generate the quotation PDF.");
        return;
      }
      toast.error(message);
    } finally {
      setSendingEmail(false);
    }
  };
  const markLeadOutcome = async (outcome: "Won" | "Lost Lead") => {
    if (!savedQuoteId || savingOutcome || (outcome === "Lost Lead" && !lostReason)) return;
    setSavingOutcome(true);
    try {
      const result = await executeMutation(setLeadOutcomeAction, {
        leadId: lead.id,
        outcome,
        ...(outcome === "Lost Lead" ? { lostReason } : {}),
      });
      if (!result.ok) throw new Error(result.error);
      setOutcomeStatus(outcome);
      toast.success(outcome === "Won" ? "Lead marked won." : "Lead marked lost.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the lead outcome.");
    } finally {
      setSavingOutcome(false);
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
          <Button type="button" variant="outline" className="h-12" onClick={() => setEmailOpen(true)} disabled={!savedQuoteId || sendingEmail}><Mail className="h-4 w-4" /> Email</Button>
          {shareUrl && <Button type="button" variant="outline" className="h-12" onClick={copyShareLink}><Copy className="h-4 w-4" /> Copy link</Button>}
        </div>
      </div>
      <div className="no-print fixed inset-x-0 bottom-16 z-30 border-t border-border bg-card/95 p-2 pb-[calc(.5rem+env(safe-area-inset-bottom))] shadow-lg backdrop-blur sm:hidden">
        <div className="mx-auto grid max-w-md grid-cols-3 gap-2">
          <Button aria-label="Download quotation PDF" title="Download quotation PDF" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] leading-none" onClick={downloadPdf} disabled={downloading || !canCreatePdf}>
            <Printer className="h-4 w-4 shrink-0" /> <span>{downloading ? "Preparing…" : "PDF"}</span>
          </Button>
          <Button aria-label="Share quotation on WhatsApp" title={!resolvedWaPhone ? "Enter the customer's mobile number to continue" : "Share on WhatsApp"} variant="outline" className="h-11 min-w-0 flex-col gap-0.5 bg-white px-1 text-[11px] leading-none text-slate-900 hover:bg-slate-50 hover:text-slate-900" onClick={() => void shareOnWhatsApp()} disabled={downloading}>
            <WhatsAppIcon className="h-4 w-4 shrink-0" /> <span>{downloading ? "Preparing…" : "WhatsApp"}</span>
          </Button>
          <Button aria-label="Email quotation" title="Email quotation" type="button" variant="outline" className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] leading-none" onClick={() => setEmailOpen(true)} disabled={!savedQuoteId || sendingEmail}>
            <Mail className="h-4 w-4 shrink-0" /> <span>Email</span>
          </Button>
        </div>
      </div>
      <article className="print-area offer-document mx-auto min-w-0 max-w-full rounded-xl bg-card p-3 text-[11px] leading-snug shadow-sm sm:max-w-3xl sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-4">
          <Image src="/brand/atpl-logo.png" alt={COMPANY.name} width={150} height={60} sizes="150px" quality={100} className="h-auto max-w-full object-contain" priority />
          <div className="max-w-full text-right">
            <div className="text-lg font-bold">{COMPANY.name}</div>
            <div className="mt-1 text-[10px]">{COMPANY.address}</div>
            <div className="text-[10px]">{COMPANY.contact}</div>
            <div className="mt-1 text-[10px] font-semibold">GSTIN - {COMPANY.gstin}</div>
          </div>
        </header>
        {savedQuoteId && <details className="no-print border-b border-slate-200 py-2">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
            <span>Update lead outcome</span>
            <span className="text-[11px] font-normal text-slate-500">{outcomeStatus || "Choose status"} · Tap to manage</span>
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
            <Button type="button" variant="outline" className="h-10" disabled={savingOutcome || outcomeStatus === "Won"} onClick={() => void markLeadOutcome("Won")}>Mark Won</Button>
            <select aria-label="Lost reason" className={`${fieldClass} min-w-0 text-sm`} value={lostReason} onChange={(event) => setLostReason(event.target.value as LostReason | "")}>
              <option value="">Select lost reason</option>
              {LOST_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
            </select>
            <Button type="button" variant="destructive" className="h-10" disabled={savingOutcome || !lostReason || outcomeStatus === "Lost Lead"} onClick={() => void markLeadOutcome("Lost Lead")}>Mark Lost</Button>
          </div>
        </details>}
        <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
          <div className="offer-no-break space-y-1 border-slate-300 sm:border-r sm:pr-4">
            <div className="flex items-center justify-between gap-2">
              <h1 id="offer-heading" tabIndex={-1} className="text-base font-bold outline-none">OFFER</h1>
              {savedQuoteId && <span className="print:hidden"><StatusBadge status={outcomeStatus} /></span>}
            </div>
            <label className="grid grid-cols-[70px_1fr] items-center gap-2"><span className="font-semibold">Offer Ref</span>
              {readOnly || !editableOfferNo ? <span className="font-medium">{offerReference || "Offer reference unavailable"}</span> : <input aria-label="Offer reference" className="h-8 rounded-lg border border-input px-2 font-medium" pattern="\d{1,4}/\d{2}-\d{2}" value={offerNo} onChange={(event) => setOfferNo(event.target.value)} maxLength={9} />}
            </label>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Valid Till</span><span>{validTill}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Date</span><span>{date}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Sales Person</span><span>{COMPANY.signatory}</span></div>
            <div className="grid grid-cols-[70px_1fr] gap-2"><span className="font-semibold">Grand Total</span><span>{offerMoney(t.total)}</span></div>
          </div>
          <div>
            <div className="offer-no-break">
              <div className="font-bold">Client</div>
              <div className="mt-1">{lead.name.trim() || customer.trim() || lead.company.trim() || "Customer details not saved with this quote"}</div>
              {lead.company.trim() && lead.company.trim() !== lead.name.trim() && <div>{lead.company.trim()}</div>}
              {lead.address?.trim() && <div>{lead.address.trim()}</div>}
              {!lead.address?.trim() && lead.area.trim() && <div>{lead.area.trim()}</div>}
              {lead.phone.trim() && <div>{lead.phone.trim()}</div>}
              {lead.email?.trim() && <div>{lead.email.trim()}</div>}
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
          <div className="font-bold">EQUIPMENT REQUIRED</div>
          <div className="font-bold">Total Units: {splitParts.equipment.reduce((sum, item) => sum + item.qty, 0)}</div>
        </section>
        <div className="min-w-0 max-w-full">
          {renderPart(splitParts.equipment, OFFER_TEXT.partA, OFFER_TEXT.partAGst, 0, gstBreakdown?.partA)}
          {splitParts.ancillary.length > 0 && renderPart(splitParts.ancillary, OFFER_TEXT.partB, OFFER_TEXT.partBGst, splitParts.equipment.length, gstBreakdown?.partB)}
        </div>
        <div className="mt-3 grid grid-cols-2 border border-border p-2 font-bold"><span>TOTAL PART A + B</span><span className="text-right">{offerMoney(t.partA.total + t.partB.total)}</span></div>

        <div className="offer-no-break mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2">
          <div>
            <div className="font-bold">Authority Signature</div>
            <div className="mt-5">for {COMPANY.name}</div>
            <div>{COMPANY.signatory}</div>
            <div>{COMPANY.phones}</div>
          </div>
          <div className="text-right">
            <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>Subtotal</span><span>{offerMoney(t.subtotal)}</span></div>
            {!isLegacySavedQuote && t.discount > 0 && <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>Discount</span><span>-{offerMoney(t.discount)}</span></div>}
            {(isLegacySavedQuote ? [] : displayedGstByRate ?? []).map((group) => <div key={group.rate} className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>GST @ {formatTaxRate(group.rate)}%</span><span>{offerMoney(group.amount)}</span></div>)}
            {isLegacySavedQuote && <div className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>GST</span><span>{offerMoney(t.gst)}</span></div>}
            {displayedExtraCharges.map((charge, index) => <div key={`${charge.label}-${index}`} className="grid grid-cols-[1fr_auto] gap-6 py-1"><span>{charge.label}{charge.taxRate !== undefined ? ` (+ GST ${formatTaxRate(charge.taxRate)}%)` : ""}</span><span>{offerMoney(charge.amount)}</span></div>)}
            <div className="mt-1 grid grid-cols-[1fr_auto] gap-6 bg-muted px-2 py-2 font-bold text-foreground"><span>Grand Total</span><span>{offerMoney(isLegacySavedQuote ? (savedTotal ?? t.total) : t.total)}</span></div>
          </div>
        </div>

        <section className="mt-4 space-y-2">
          <div className="offer-no-break"><span className="font-bold">NOTE</span><p>Quantities are tentative and final billing will be based on actual measurements.</p></div>
          <div className="offer-no-break"><div className="font-bold">ITEMS EXCLUDED</div><ol className="list-decimal pl-5"><li>Main incoming electrical cabling &amp; civil works such as core cutting, wall chipping in client scope</li><li>In case of Cat walk requirement for outdoor unit, the same shall be in client scope</li></ol></div>
          <div className="offer-no-break"><div className="font-bold">TERMS &amp; CONDITIONS</div>
            <dl className="grid grid-cols-[90px_1fr] gap-x-2">
              <dt>Validity</dt><dd>30 days</dd>
              <dt>Taxes</dt><dd>GST at applicable line-item and extra-charge rates, as shown above</dd>
              <dt>Delivery</dt><dd>1-2 weeks from the date of order</dd>
              <dt>Payment Terms</dt><dd>100% advance for equipment; 60% advance for Part B and 40% on completion</dd>
            </dl>
          </div>
          <p>We hope our offer is in line with your requirement and look forward to receive your valued order.</p>
          <p>Thanking you and assuring you of our best attention at all times, we remain,</p>
        </section>
      </article>
    </div>
    {emailOpen && <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="quotation-email-title"
        className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-5 shadow-xl"
        onSubmit={(event) => void emailQuotation(event)}
      >
        <div>
          <h2 id="quotation-email-title" className="font-semibold">Email quotation</h2>
          <p className="mt-1 text-sm text-muted-foreground">Offer {offerReference} · PDF link included</p>
        </div>
        <label className="block space-y-1 text-sm font-medium" htmlFor="quotation-email-recipient">
          Recipient email
          <input
            id="quotation-email-recipient"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            className={`${fieldClass} h-11`}
            value={emailRecipient}
            onChange={(event) => setEmailRecipient(event.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={() => setEmailOpen(false)}>Cancel</Button>
          <Button type="submit" className="h-11" disabled={sendingEmail || !emailRecipient.trim()}><Mail className="h-4 w-4" />{sendingEmail ? "Sending…" : "Send email"}</Button>
        </div>
      </form>
    </div>}
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