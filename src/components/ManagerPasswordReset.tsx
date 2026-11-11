"use client";

import { useState, type FormEvent } from "react";
import { managerResetPassword } from "@/app/actions/passwords";
import { Button } from "@/components/ui/button";

type Props = { users: { username: string; name: string }[] };

export function ManagerPasswordReset({ users }: Props) {
  const [username, setUsername] = useState(users[0]?.username ?? "");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const result = await managerResetPassword({ username, password });
      if (result.success) {
        setPassword("");
        setMessage("Password updated. The user's existing sessions have been signed out.");
      } else {
        setMessage(result.error ?? "Password reset failed.");
      }
    } finally {
      setPending(false);
    }
  }

  if (users.length === 0) return null;
  return (
    <details className="mt-6 rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer font-semibold">User access &amp; password reset</summary>
      <p className="mt-2 text-sm text-muted-foreground">Managers can set a temporary password for a team member. Their existing sessions will be signed out after the reset.</p>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          User
          <select value={username} onChange={(event) => setUsername(event.target.value)} className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3">
            {users.map((user) => <option key={user.username} value={user.username}>{user.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">
          Temporary password
          <input type="password" value={password} minLength={10} maxLength={128} required autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3" />
        </label>
        <Button type="submit" className="sm:col-span-2" disabled={pending}>{pending ? "Updating…" : "Reset password"}</Button>
        {message && <p role="status" className="text-sm text-muted-foreground sm:col-span-2">{message}</p>}
      </form>
    </details>
  );
}
