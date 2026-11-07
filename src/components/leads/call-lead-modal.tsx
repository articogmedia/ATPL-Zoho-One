"use client";

import { useEffect, useState, useTransition } from "react";
import { LoaderCircle, Phone, X } from "lucide-react";
import { toast } from "sonner";
import { logCallAction } from "@/app/actions/crm";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui-bits";
import { normalizePhone, type CallOutcome, type LeadStatus } from "@/lib/domain";
import { clearExpiredAction, isRetryableActionMessage, isSessionExpiredMessage, readExpiredAction, redirectForExpiredSession } from "@/lib/session-recovery";

const OUTCOMES: { value: CallOutcome; label: string; status: LeadStatus }[] = [
  { value: "Connected", label: "Answered", status: "Contacted" },
  { value: "No Answer", label: "Not answered", status: "Attempted to Contact" },
  { value: "Call Back Later", label: "Call back", status: "Callback in Future" },
  { value: "Wrong Number", label: "Wrong number", status: "Not Responsive" },
];

export function CallLeadModal({
  lead, onClose, onOptimistic, onRollback, onPendingChange, onSaved,
}: {
  lead: { id: string; name: string; phone: string };
  onClose: () => void;
  onOptimistic?: (status: LeadStatus, followUp?: string) => void;
  onRollback?: () => void;
  onPendingChange?: (pending: boolean) => void;
  onSaved: (status: LeadStatus, followUp?: string) => void;
}) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [remarks, setRemarks] = useState("");
  const [retryableError, setRetryableError] = useState(false);
  const [pending, start] = useTransition();
  const digits = normalizePhone(lead.phone);
  const phone = digits.length === 10 ? `+91${digits}` : "";
  const whatsapp = digits.length === 10 ? `https://wa.me/91${digits}` : "";

  useEffect(() => {
    const saved = readExpiredAction<{ type: string; payload: { leadId?: string; outcome?: CallOutcome; remarks?: string; followUp?: string } }>();
    if (saved?.type !== "call-outcome" || saved.payload.leadId !== lead.id) return;
    setOutcome(saved.payload.outcome ?? null);
    setRemarks(saved.payload.remarks ?? "");
    setFollowUp(saved.payload.followUp ?? "");
    clearExpiredAction();
  }, [lead.id]);

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(lead.phone);
      toast.success("Copied");
    } catch (error) {
      console.error("[leads] clipboard copy failed", error);
      toast.error("Could not copy the number. Check clipboard permissions.");
    }
  };

  const saveOutcome = () => {
    const selected = OUTCOMES.find((item) => item.value === outcome);
    if (!selected || (selected.value === "Call Back Later" && !followUp)) return;
    onOptimistic?.(selected.status, selected.value === "Call Back Later" ? followUp : undefined);
    onPendingChange?.(true);
    start(async () => {
      try {
        const result = await logCallAction({
          leadId: lead.id,
          outcome: selected.value,
          remarks,
          ...(selected.value === "Call Back Later" && followUp ? { followUp } : {}),
        });
        if (!result.ok) {
          onRollback?.();
          if (isSessionExpiredMessage(result.error)) {
            redirectForExpiredSession({
              type: "call-outcome",
              payload: {
                leadId: lead.id, outcome: selected.value, remarks,
                ...(selected.value === "Call Back Later" && followUp ? { followUp } : {}),
              },
            });
            return;
          }
          setRetryableError(isRetryableActionMessage(result.error));
          toast.error(result.error);
          return;
        }
        setRetryableError(false);
        if (result.data?.partialWarning) toast.warning(result.data.partialWarning);
        else if (result.data?.historyWarning) toast.warning(result.data.historyWarning);
        else toast.success("Call outcome saved");
        onSaved(selected.status, selected.value === "Call Back Later" ? followUp : undefined);
      } catch (error) {
        onRollback?.();
        setRetryableError(true);
        toast.error(error instanceof Error ? error.message : "Could not save the call outcome. Please retry.");
      } finally {
        onPendingChange?.(false);
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="presentation">
      <button className="absolute inset-0 cursor-default" aria-label="Close dialog" onClick={onClose} />
      <section role="dialog" aria-modal="true" aria-labelledby="call-lead-title" className="relative max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-t-2xl border border-border bg-card p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:pb-5">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="call-lead-title" className="text-lg font-bold">Call lead</h2>
            <p className="break-words font-medium">{lead.name}</p>
            <p className="text-sm text-muted-foreground">{lead.phone || "No phone number"}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>
        </header>

        <div className="grid grid-cols-3 gap-2">
          <Button type="button" variant="outline" className="min-w-0 px-2" onClick={() => void copyNumber()} disabled={!lead.phone}>
            Copy number
          </Button>
          {phone
            ? <Button asChild type="button" variant="outline" className="min-w-0 gap-1 px-1 text-xs"><a href={`tel:${phone}`}><Phone className="h-4 w-4" />Open dialer</a></Button>
            : <Button type="button" variant="outline" className="min-w-0 gap-1 px-1 text-xs" disabled><Phone className="h-4 w-4" />Open dialer</Button>}
          {whatsapp
            ? <Button asChild type="button" variant="outline" className="min-w-0 gap-1 px-1 text-xs"><a href={whatsapp} target="_blank" rel="noreferrer"><WhatsAppIcon className="h-4 w-4" />WhatsApp</a></Button>
            : <Button type="button" variant="outline" className="min-w-0 gap-1 px-1 text-xs" disabled><WhatsAppIcon className="h-4 w-4" />WhatsApp</Button>}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Call outcome</legend>
          <div className="grid grid-cols-2 gap-2">
            {OUTCOMES.map((item) => (
              <Button key={item.value} type="button" variant={outcome === item.value ? "default" : "outline"} aria-pressed={outcome === item.value} onClick={() => setOutcome(item.value)}>
                {item.label}
              </Button>
            ))}
          </div>
        </fieldset>

        {outcome === "Call Back Later" && (
          <label className="block text-sm font-medium">Follow-up date
            <input aria-label="Follow-up date" type="date" className={`${fieldClass} mt-1`} value={followUp} onChange={(event) => setFollowUp(event.target.value)} required />
          </label>
        )}
        <label className="block text-sm font-medium">Remarks
          <textarea className={`${fieldClass} mt-1 h-20 py-2`} value={remarks} onChange={(event) => setRemarks(event.target.value)} maxLength={500} />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={pending || !outcome || (outcome === "Call Back Later" && !followUp)} onClick={saveOutcome}>
            {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            {pending ? "Saving…" : retryableError ? "Retry save" : "Save outcome"}
          </Button>
        </div>
      </section>
    </div>
  );
}
