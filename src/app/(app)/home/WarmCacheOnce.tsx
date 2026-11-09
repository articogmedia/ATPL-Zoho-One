"use client";

import { useEffect } from "react";

let warmRequested = false;

export function WarmCacheOnce() {
  useEffect(() => {
    if (warmRequested) return;
    warmRequested = true;
    void fetch("/api/warm", { method: "GET", cache: "no-store" }).catch(() => undefined);
  }, []);

  return null;
}
