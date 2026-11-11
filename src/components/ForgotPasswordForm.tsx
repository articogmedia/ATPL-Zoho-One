"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

const MESSAGE = "If an account exists for that email address, a password reset link will be sent.";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSubmitted(false);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Reset request failed.");
      setSubmitted(true);
    } catch {
      setError("We could not submit your request. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label htmlFor="forgot-email" className="block text-sm font-medium text-slate-700">
        Registered email address
        <input id="forgot-email" name="email" type="email" required maxLength={254} autoComplete="email" value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 h-12 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base focus:bg-white focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
      </label>
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Sending…" : "Send reset link"}</Button>
      {submitted && <p role="status" className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">{MESSAGE}</p>}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </form>
  );
}
