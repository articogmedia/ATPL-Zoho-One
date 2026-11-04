export function shouldClearLeadDuplicate(flaggedPhone: string | null, currentPhone: string): boolean {
  return !flaggedPhone || flaggedPhone !== currentPhone;
}

export function claimLeadSubmission(submitted: { current: boolean }): boolean {
  if (submitted.current) return false;
  submitted.current = true;
  return true;
}
