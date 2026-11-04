export function friendlyZohoError(status?: number, code?: string): string {
  if (code === "DUPLICATE_DATA") {
    return "Zoho already has a lead with this mobile number. Open the existing lead instead.";
  }
  if (code === "INVALID_DATA" || code === "MANDATORY_NOT_FOUND") {
    return "Some details are missing or invalid. Please check the form.";
  }
  if (status === 429) {
    return "Too many requests. Please wait a few seconds and try again.";
  }
  const reference = code || status || "UNKNOWN";
  return `Something went wrong. Please try again. (Ref: ${reference})`;
}
