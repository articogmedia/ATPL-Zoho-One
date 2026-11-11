"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [updated, setUpdated] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
        cache: "no-store",
      });
      const result = await response.json() as { message?: string; error?: string };
      setUpdated(response.ok);
      setMessage(result.message ?? result.error ?? "Password reset is temporarily unavailable. Please try again.");
    } catch {
      setUpdated(false);
      setMessage("Password reset is temporarily unavailable. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label htmlFor="new-password" className="block text-sm font-medium text-slate-700">
        New password
        <input id="new-password" name="password" type="password" required minLength={10} maxLength={128}
          autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)}
          className="mt-1 h-12 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base focus:bg-white focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
      </label>
      <Button type="submit" className="w-full" disabled={pending || !token}>{pending ? "Updating…" : "Update password"}</Button>
      {message && <p role={updated ? "status" : "alert"} className="rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">{message}</p>}
      {updated && <Link href="/login" className="block text-center text-sm text-primary underline-offset-4 hover:underline">Sign in</Link>}
    </form>
  );
}
