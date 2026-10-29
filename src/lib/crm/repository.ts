import type {
  Lead, LeadSource, LeadStatus, LeadUpdate, NewVisit, Product, Quotation, User, Visit, VisitStatus,
} from "@/lib/domain";

export type NewLead = { name: string; company: string; phone: string; area: string; source: LeadSource; remarks: string };
export type LeadPatch = { status?: LeadStatus; remarks?: string; assignedTo?: string | null };
export type NewQuote = { offerNo: string; leadId: string; items: { productId: string; qty: number }[] };
export type VisitPatch = { status?: VisitStatus; notes?: string; date?: string; time?: string };

/**
 * The only thing the rest of the app knows about the CRM. Zoho CRM is the system of
 * record; `mockRepository` exists for demos and tests. Authorization is NOT done here:
 * server actions check permissions before calling these methods.
 */
export interface CrmRepository {
  listUsers(): Promise<User[]>;
  findUserByEmail(email: string): Promise<User | null>;

  listLeads(): Promise<Lead[]>;
  getLead(id: string): Promise<Lead | null>;
  createLead(input: NewLead, actor: User, assignTo: string | null): Promise<Lead>;
  updateLead(id: string, patch: LeadPatch, actor: User): Promise<void>;
  getLeadHistory(id: string): Promise<LeadUpdate[]>;

  listProducts(): Promise<Product[]>;
  listQuotes(): Promise<Quotation[]>;
  createQuote(input: NewQuote, actor: User, executive: string): Promise<Quotation>;

  listVisits(): Promise<Visit[]>;
  getVisit(id: string): Promise<Visit | null>;
  createVisit(input: NewVisit, actor: User): Promise<void>;
  updateVisit(id: string, patch: VisitPatch, actor: User): Promise<void>;
}
