type OverlayElement = HTMLElement & { hidden: boolean };

const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]';

function focusableElements(overlay: HTMLElement): HTMLElement[] {
  return Array.from(overlay.querySelectorAll<HTMLElement>(focusableSelector)).filter(element => {
    if (element.tabIndex < 0) return false;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || style?.display === "none" || style?.visibility === "hidden") return false;
      if (current === overlay) break;
    }
    return true;
  });
}

/** 検証済みdata属性だけを解釈する、公開SSRとeditor preview共通のoverlay runtime。 */
export function initializeSitePresentation(scope: ParentNode = document): () => void {
  const ownerDocument = scope.nodeType === 9 ? scope as Document : (scope as Node).ownerDocument;
  if (!ownerDocument) return () => {};
  const cleanups: Array<() => void> = [], html = ownerDocument.documentElement;
  let openOverlay: OverlayElement | null = null, opener: HTMLElement | null = null, previousOverflow = "", previousGutter = "";
  const listen = (target: EventTarget, type: string, listener: EventListener) => {
    target.addEventListener(type, listener); cleanups.push(() => target.removeEventListener(type, listener));
  };
  const controls = (name: "open" | "close", id: string) => Array.from(scope.querySelectorAll<HTMLElement>(`[data-nw-overlay-${name}]`))
    .filter((control) => control.dataset[name === "open" ? "nwOverlayOpen" : "nwOverlayClose"] === id);
  const setExpanded = (id: string, value: boolean) => controls("open", id).forEach((control) => control.setAttribute("aria-expanded", String(value)));
  const close = (restoreFocus = true) => {
    if (!openOverlay) return;
    const closing = openOverlay, returnTarget = opener;
    closing.hidden = true; setExpanded(closing.id, false); html.style.overflow = previousOverflow; html.style.scrollbarGutter = previousGutter;
    openOverlay = null; opener = null;
    if (restoreFocus && returnTarget?.isConnected) returnTarget.focus();
  };
  const open = (overlay: OverlayElement, control: HTMLElement) => {
    if (openOverlay === overlay) return;
    if (openOverlay && openOverlay !== overlay) close(false);
    openOverlay = overlay; opener = control; previousOverflow = html.style.overflow; previousGutter = html.style.scrollbarGutter;
    if (ownerDocument.defaultView && html.clientWidth < ownerDocument.defaultView.innerWidth) html.style.scrollbarGutter = "stable";
    overlay.hidden = false; html.style.overflow = "hidden"; setExpanded(overlay.id, true);
    (focusableElements(overlay)[0] ?? overlay).focus();
  };
  for (const overlay of Array.from(scope.querySelectorAll<OverlayElement>("[data-nw-overlay]"))) {
    if (!overlay.id || overlay.dataset.nwOverlay !== overlay.id) continue;
    if (!overlay.hasAttribute("data-nw-overlay-editing")) overlay.hidden = true;
    for (const control of controls("open", overlay.id)) {
      control.setAttribute("aria-controls", overlay.id); control.setAttribute("aria-expanded", "false");
      listen(control, "click", ((event: Event) => { event.preventDefault(); event.stopPropagation(); open(overlay, control); }) as EventListener);
      listen(control, "keydown", ((event: Event) => { const key = event as KeyboardEvent; if (key.code === "Space") { key.preventDefault(); key.stopPropagation(); open(overlay, control); } }) as EventListener);
    }
    for (const control of controls("close", overlay.id)) {
      listen(control, "click", ((event: Event) => { event.preventDefault(); event.stopPropagation(); close(); }) as EventListener);
      listen(control, "keydown", ((event: Event) => { const key = event as KeyboardEvent; if (key.code === "Space") { key.preventDefault(); key.stopPropagation(); close(); } }) as EventListener);
    }
    listen(overlay, "click", ((event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest("a[href]")) close(false);
    }) as EventListener);
  }
  listen(ownerDocument, "keydown", ((event: Event) => {
    const key = event as KeyboardEvent;
    if (!openOverlay) return;
    if (key.key === "Escape") { key.preventDefault(); close(); return; }
    if (key.key !== "Tab") return;
    const focusable = focusableElements(openOverlay);
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !last) { key.preventDefault(); openOverlay.focus(); return; }
    const outside = !openOverlay.contains(ownerDocument.activeElement);
    if (key.shiftKey && (ownerDocument.activeElement === first || outside)) { key.preventDefault(); last.focus(); }
    else if (!key.shiftKey && (ownerDocument.activeElement === last || outside)) { key.preventDefault(); first.focus(); }
  }) as EventListener);
  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    close(false);
    openOverlay = null; opener = null;
  };
}
