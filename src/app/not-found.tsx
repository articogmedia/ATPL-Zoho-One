"use client";

import { AppErrorState } from "@/components/AppErrorState";

export default function NotFound() {
  return <AppErrorState title="Page not found" message="This page may have moved or the address may be incorrect." />;
}
