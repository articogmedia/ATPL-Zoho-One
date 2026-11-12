import type {
  CallActivity, CallOutcome, Invoice, Lead, LeadSource, LeadStatus, LeadTimelineItem, LeadUpdate, LostReason, NewVisit, Product, Quotation, QuoteExtraCharge, User, Visit, VisitStatus,
} from "@/lib/domain";

export type NewLead = { name: string; company: string; phone: string; area: string; source: LeadSource; remarks: string };
export type LeadPatch = {
  name?: string; company?: string; phone?: string; source?: LeadSource;
  status?: LeadStatus; lostReason?: LostReason; remarks?: string; assignedTo?: string | null; followUp?: string;
};
export type NewQuote = { offerNo: string; leadId: string; subject?: string; items: { productId: string; qty: number; discount: number; taxRate?: number }[]; extraCharges?: QuoteExtraCharge[] };
export type NewProduct = { name: string; code: string; unit: string; price: number; gstRate: number };
export type VisitPatch = { status?: VisitStatus; notes?: string; date?: string; time?: string; followUp?: string };
export type LogCallInput = { leadId: string; outcome: CallOutcome; remarks: string; followUp?: string; followUpTime?: string; notResponsiveAttempts?: number };

/**
 * The only thing the rest of the app knows about the CRM. Zoho CRM is the system of
 * record; `mockRepository` exists for demos and tests. Authorization is NOT done here:
 * server actions check permissions before calling these methods.
 */
export interface CrmRepository {
  listUsers(): Promise<User[]>;
  findUserByEmail(email: string): Promise<User | null>;

  listLeads(): Promise<Lead[]>;
  listLeadsPage?(page: number, pageSize?: number, ownerId?: string): Promise<{ leads: Lead[]; total: number; hasMore: boolean }>;
  listLeadSources(): Promise<LeadSource[]>;
  searchLeads(query: string, page?: number): Promise<{ leads: Lead[]; hasMore: boolean }>;
  getLead(id: string): Promise<Lead | null>;
  findLeadByPhone(phone: string): Promise<{ lead: Lead; matchedField: "Mobile" | "Phone" } | null>;
  listAssignableUsers(): Promise<User[]>;
  createLead(input: NewLead, actor: User, assignToId: string | null, forceCreate?: boolean): Promise<Lead>;
  assignLead(id: string, assigneeId: string, actor: User): Promise<{ owner: string; ownerId: string; status: string; taskCreated: boolean; warningCheckId: string }>;
  fixAssignedLeads(actor: User): Promise<number>;
  listFixableAssignedLeads(actor: User): Promise<{ id: string; name: string; ownerName: string }[]>;
  updateLead(id: string, patch: LeadPatch, actor: User, current?: Lead): Promise<Lead | void>;
  deleteLead(id: string): Promise<void>;
  getLeadHistory(id: string): Promise<LeadUpdate[]>;
  addLeadNote(id: string, title: string, content: string): Promise<void>;
  getLeadTimeline(id: string): Promise<LeadTimelineItem[]>;
  logCall(input: LogCallInput, actor: User): Promise<{ historyWarning?: string; partialWarning?: string; callLogPending?: boolean; attempts?: number; lastOutcome?: CallOutcome; status?: LeadStatus }>;
  listCalls(): Promise<CallActivity[]>;

  listProducts(): Promise<Product[]>;
  createProduct(input: NewProduct): Promise<Product>;
  listQuotes(): Promise<Quotation[]>;
  listQuotesPage(page: number): Promise<{ quotes: Quotation[]; hasMore: boolean; count?: number }>;
  countQuotes?(ownerId?: string): Promise<number>;
  listInvoiceCandidates(): Promise<{ quotes: Quotation[]; leads: Lead[] }>;
  suggestOfferNo(): Promise<string>;
  getQuote(id: string): Promise<Quotation | null>;
  markQuoteSent(id: string): Promise<void>;
  createQuote(input: NewQuote, actor: User, executive: string): Promise<Quotation>;
  updateQuote(id: string, input: Omit<NewQuote, "offerNo">, actor: User): Promise<Quotation>;
  listInvoices(): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | null>;
  createInvoice(quote: Quotation, lead: Lead, actor: User, gstin: string): Promise<Invoice>;

  listVisits(): Promise<Visit[]>;
  getVisitsWarning?(): string | null;
  getVisit(id: string): Promise<Visit | null>;
  createVisit(input: NewVisit, actor: User): Promise<Visit>;
  updateVisit(id: string, patch: VisitPatch, actor: User, current?: Visit): Promise<void>;
}
