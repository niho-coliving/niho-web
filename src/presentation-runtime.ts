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
export function initializeSitePresentation(scope: ParentNode = document, options: { interactive?: boolean } = {}): () => void {
  const ownerDocument = scope.nodeType === 9 ? scope as Document : (scope as Node).ownerDocument;
  if (!ownerDocument) return () => {};
  const cleanups: Array<() => void> = [], html = ownerDocument.documentElement;
  let openOverlay: OverlayElement | null = null, opener: HTMLElement | null = null, previousOverflow = "", previousGutter = "";
  const listen = (target: EventTarget, type: string, listener: EventListener) => {
    target.addEventListener(type, listener); cleanups.push(() => target.removeEventListener(type, listener));
  };
  const sizedFrames = Array.from(scope.querySelectorAll<HTMLIFrameElement>('iframe[data-nw-frame-key][sandbox="allow-scripts"]')).map((frame) => {
    const key = frame.dataset.nwFrameKey ?? "", maximum = Number(frame.dataset.nwFrameMaxHeight), wrapper = frame.closest<HTMLElement>("[data-nw-host-view]");
    return { frame, key, maximum, wrapper, frameHeight: frame.style.height, wrapperHeight: wrapper?.style.height ?? "" };
  }).filter(({ key, maximum }) => !!key && Number.isInteger(maximum) && maximum >= 200 && maximum <= 4000);
  if (sizedFrames.length && ownerDocument.defaultView) {
    listen(ownerDocument.defaultView, "message", ((event: Event) => {
      const message = event as MessageEvent, value = message.data;
      if (message.origin !== "null" || !value || typeof value !== "object" || Array.isArray(value)) return;
      const data = value as Record<string, unknown>;
      if (Object.keys(data).sort().join(",") !== "frameKey,height,type" || data.type !== "niho-native-frame-size" || typeof data.frameKey !== "string" || typeof data.height !== "number" || !Number.isFinite(data.height) || !Number.isInteger(data.height)) return;
      const binding = sizedFrames.find(({ frame, key }) => key === data.frameKey && message.source === frame.contentWindow);
      if (!binding || data.height < 100 || data.height > binding.maximum) return;
      binding.frame.style.height = `${data.height}px`;
      if (binding.wrapper) binding.wrapper.style.height = `${data.height}px`;
    }) as EventListener);
    cleanups.push(() => sizedFrames.forEach(({ frame, wrapper, frameHeight, wrapperHeight }) => {
      frame.style.height = frameHeight;
      if (wrapper) wrapper.style.height = wrapperHeight;
    }));
    for (const { frame, key } of sizedFrames) {
      const requestSize = () => frame.contentWindow?.postMessage({ type: "niho-native-frame-request-size", frameKey: key }, "*");
      listen(frame, "load", requestSize);
      requestSize();
    }
  }
  // Frame sizing is required while editing too. Navigation and animation are preview-only.
  if (options.interactive === false) return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>("[data-nw-carousel]"))) {
    const id = root.dataset.nwCarousel;
    if (!id) continue;
    const owner = root.closest<HTMLElement>("[data-nw-host-view]");
    const container = owner?.dataset.nwHostView === id ? owner : root;
    const slides = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-slide]"))
      .sort((left, right) => Number(left.dataset.nwCarouselSlide) - Number(right.dataset.nwCarouselSlide));
    if (slides.length < 2 || slides.some((slide, index) => Number(slide.dataset.nwCarouselSlide) !== index)) continue;
    const previous = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-previous]"));
    const next = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-next]"));
    const playPause = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-play-pause]"));
    const originals = slides.map((slide) => ({ hidden: slide.hidden, ariaHidden: slide.getAttribute("aria-hidden") }));
    const originalPressed = playPause.map((control) => control.getAttribute("aria-pressed"));
    const interval = Number(root.dataset.nwCarouselAutoplay), autoplay = Number.isInteger(interval) && interval >= 1000 && interval <= 60000;
    const fade = Number(root.dataset.nwCarouselFade), fadeMs = Number.isInteger(fade) && fade >= 0 && fade <= 3000 ? fade : 0;
    let animations: Animation[] = [];
    const cancelFade = () => { const previous = animations; animations = []; previous.forEach(animation => animation.cancel()); };
    const loop = root.dataset.nwCarouselLoop !== "false", swipe = root.dataset.nwCarouselSwipe === "true";
    const reducedMotion = ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
    let index = 0, timer: number | undefined, hoverPaused = false, focusPaused = false, userPaused = root.dataset.nwCarouselPaused === "true", pointerStart: { id: number; x: number } | null = null;
    const render = () => {
      cancelFade();
      slides.forEach((slide, at) => { slide.hidden = at !== index; slide.setAttribute("aria-hidden", String(at !== index)); });
      playPause.forEach((control) => control.setAttribute("aria-pressed", String(userPaused)));
    };
    const stopTimer = () => { if (timer !== undefined) ownerDocument.defaultView?.clearInterval(timer); timer = undefined; };
    const startTimer = () => {
      stopTimer();
      if (!autoplay || hoverPaused || focusPaused || userPaused || reducedMotion?.matches) return;
      timer = ownerDocument.defaultView?.setInterval(() => move(1), interval);
    };
    const move = (delta: number) => {
      const previous = index, candidate = index + delta;
      index = loop ? (candidate + slides.length) % slides.length : Math.max(0, Math.min(slides.length - 1, candidate));
      render();
      const outgoing = slides[previous]!, incoming = slides[index]!;
      if (previous !== index && fadeMs > 0 && !reducedMotion?.matches && typeof incoming.animate === "function") {
        outgoing.hidden = false;
        animations = [outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fadeMs, easing: "ease-in-out", fill: "both" }), incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: "ease-in-out", fill: "both" })];
        const active = animations;
        void Promise.all(active.map(animation => animation.finished)).then(() => { if (animations === active) render(); }, () => {});
      }
      startTimer();
    };
    const action = (callback: () => void) => ((event: Event) => { event.preventDefault(); event.stopPropagation(); callback(); }) as EventListener;
    previous.forEach((control) => { listen(control, "click", action(() => move(-1))); listen(control, "keydown", ((event: Event) => { if ((event as KeyboardEvent).code === "Space") action(() => move(-1))(event); }) as EventListener); });
    next.forEach((control) => { listen(control, "click", action(() => move(1))); listen(control, "keydown", ((event: Event) => { if ((event as KeyboardEvent).code === "Space") action(() => move(1))(event); }) as EventListener); });
    playPause.forEach((control) => {
      const toggle = () => { userPaused = !userPaused; render(); startTimer(); };
      listen(control, "click", action(toggle));
      listen(control, "keydown", ((event: Event) => { if ((event as KeyboardEvent).code === "Space") action(toggle)(event); }) as EventListener);
    });
    listen(container, "mouseenter", (() => { hoverPaused = true; stopTimer(); }) as EventListener);
    listen(container, "mouseleave", (() => { hoverPaused = false; startTimer(); }) as EventListener);
    listen(container, "focusin", (() => { focusPaused = true; stopTimer(); }) as EventListener);
    listen(container, "focusout", ((event: Event) => { if (!container.contains((event as FocusEvent).relatedTarget as Node | null)) { focusPaused = false; startTimer(); } }) as EventListener);
    if (reducedMotion) listen(reducedMotion, "change", (() => { render(); startTimer(); }) as EventListener);
    if (swipe) {
      listen(root, "pointerdown", ((event: Event) => { const pointer = event as PointerEvent; if (pointer.isPrimary) pointerStart = { id: pointer.pointerId, x: pointer.clientX }; }) as EventListener);
      listen(root, "pointerup", ((event: Event) => { const pointer = event as PointerEvent, start = pointerStart; pointerStart = null; if (!start || start.id !== pointer.pointerId) return; const distance = pointer.clientX - start.x; if (Math.abs(distance) >= 40) move(distance > 0 ? -1 : 1); }) as EventListener);
      listen(root, "pointercancel", (() => { pointerStart = null; }) as EventListener);
    }
    render(); startTimer();
    cleanups.push(() => { stopTimer(); cancelFade(); slides.forEach((slide, at) => { slide.hidden = originals[at]!.hidden; const value = originals[at]!.ariaHidden; if (value === null) slide.removeAttribute("aria-hidden"); else slide.setAttribute("aria-hidden", value); });
      playPause.forEach((control, at) => { const value = originalPressed[at]; if (value === null) control.removeAttribute("aria-pressed"); else control.setAttribute("aria-pressed", value!); }); });
  }
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
      if (target?.closest?.("a[href]")) close(event.defaultPrevented);
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
