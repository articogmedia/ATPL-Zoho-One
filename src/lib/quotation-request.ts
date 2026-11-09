import { z } from "zod";

export const quotationRequestSchema = z.object({
  leadId: z.string().trim().min(1, "Customer is missing.").optional(),
  quoteId: z.string().trim().min(1).optional(),
  offerNo: z.string().trim().min(1, "Offer reference is missing.").regex(/^\d{1,4}\/\d{2}-\d{2}$/, "Offer reference must use the format NNN/YY-YY."),
  subject: z.string().trim().min(1, "Quotation subject is missing.").max(300, "Quotation subject is too long."),
  items: z.array(z.object({
    productId: z.string().trim().min(1, "A product is missing.").optional(),
    qty: z.number().int("Quantity must be a whole number.").positive("Quantity must be at least one.").max(10000, "Quantity is too large."),
    discount: z.number().nonnegative().max(100000000).optional(),
  }).strict()).min(1, "Add at least one product.").max(100, "A quotation cannot contain more than 100 products."),
}).strict().refine((value) => !!value.leadId || !!value.quoteId, {
  message: "Customer or saved quotation is missing.",
  path: ["leadId"],
}).refine((value) => !!value.quoteId || value.items.every((item) => !!item.productId), {
  message: "A product is missing.",
  path: ["items"],
});
