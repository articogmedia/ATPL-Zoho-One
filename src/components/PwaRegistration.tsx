"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").then((registration) => {
      const announceWaitingWorker = () => {
        if (registration.waiting && navigator.serviceWorker.controller) {
          window.dispatchEvent(new Event("atpl:pwa-update-ready"));
        }
      };
      announceWaitingWorker();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", announceWaitingWorker);
      });
    }).catch((error: unknown) => {
      console.error("[pwa] service worker registration failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  return null;
}
