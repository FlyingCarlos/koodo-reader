import React, { createContext, useEffect, useState } from "react";
import { translationApi } from "./api";
import { PDF_TRANSLATION_UPDATE } from "./events";

export type LibraryTranslation = { completed: number; total: number; complete: boolean };
export const TranslationLibrary = createContext<Record<string, LibraryTranslation>>({});

// One request for the bookshelf, shared across card, detail and list views.
export function TranslationLibraryProvider({ children }: {children: React.ReactNode}) {
  const [books, setBooks] = useState<Record<string, LibraryTranslation>>({});
  useEffect(() => {
    let disposed = false, pending = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true; controller = new AbortController();
      try {
        const result = await translationApi<Record<string, LibraryTranslation>>("/library", {signal: controller.signal});
        if (!disposed) setBooks(result);
      } catch { /* Keep the last known state; native library use never depends on this service. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    window.addEventListener("focus", refresh);
    window.addEventListener(PDF_TRANSLATION_UPDATE, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true; controller?.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PDF_TRANSLATION_UPDATE, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return <TranslationLibrary.Provider value={books}>{children}</TranslationLibrary.Provider>;
}
