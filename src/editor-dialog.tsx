"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** 背後を inert にした上で使う focus trap 付きの確認ダイアログ。閉じると元の要素へ focus を戻す。 */
export function Dialog({ name, children, dismiss }: { name: string; children: ReactNode; dismiss: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { const previous = window.document.activeElement; return () => { if (previous && "focus" in previous && typeof previous.focus === "function") previous.focus(); }; }, []);
  return <div className="e-dialog-backdrop"><section ref={root} className="e-dialog" role="dialog" aria-modal="true" aria-label={name} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]"));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
  }}>{children}</section></div>;
}
