"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

const MESSAGE = "If an account exists for that username, a password reset link will be sent.";

export function ForgotPasswordForm() {
  const [username, setUsername] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
        cache: "no-store",
      });
    } catch {
      // The response remains generic if the network is unavailable.
    } finally {
      setSubmitted(true);
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label htmlFor="forgot-username" className="block text-sm font-medium text-slate-700">
        Username
        <input id="forgot-username" name="username" required maxLength={64} autoComplete="username" value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mt-1 h-12 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base focus:bg-white focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
      </label>
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Submitting…" : "Send reset link"}</Button>
      {submitted && <p role="status" className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">{MESSAGE}</p>}
    </form>
  );
}
