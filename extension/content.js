(() => {
  if (window.__aiondaBrowseMcpLoaded) return;
  window.__aiondaBrowseMcpLoaded = true;

  let refs = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  async function handleMessage(message) {
    if (!message || !message.command) return null;
    const payload = message.payload ?? {};

    switch (message.command) {
      case "ping":
        return { ok: true };
      case "snapshot":
        return snapshot({ compact: false });
      case "snapshotCompact":
        return snapshot({
          compact: true,
          textLimit: clampNumber(payload.textLimit, 0, 12000, 2000),
          elementLimit: clampNumber(payload.elementLimit, 1, 500, 80),
          nameLimit: clampNumber(payload.nameLimit, 16, 500, 120),
          includeBounds: payload.includeBounds === true,
          query: typeof payload.query === "string" ? payload.query : "",
        });
      case "click":
        return click(payload.ref, payload.button ?? "left");
      case "clickAt":
        return clickAt(payload.x, payload.y, payload.button ?? "left");
      case "type":
        return typeInto(payload.ref, payload.text ?? "", payload.clear === true, payload.submit === true);
      case "pressKey":
        return pressKey(payload.key);
      case "evaluate":
        return evaluate(payload.code);
      case "scroll":
        return scrollPage(payload.direction, payload.amount);
      case "scrollIntoView":
        return scrollRefIntoView(payload.ref);
      case "markFileInput":
        return markFileInput(payload.ref, payload.selector);
      case "unmarkFileInput":
        return unmarkFileInput(payload.selector);
      default:
        throw new Error(`Unknown command: ${message.command}`);
    }
  }

  function snapshot(options) {
    refs = new Map();
    const elements = [];
    let counter = 0;
    const candidates = collectCandidates();
    const query = compactText(options.query || "").toLowerCase();
    const textLimit = options.compact ? options.textLimit : 12000;
    const nameLimit = options.compact ? options.nameLimit : 0;
    const elementLimit = options.compact ? options.elementLimit : Number.POSITIVE_INFINITY;

    for (const element of candidates) {
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) continue;
      if (!isVisible(element)) continue;

      const rect = element.getBoundingClientRect();
      const text = compactText(elementText(element));
      const name = accessibleName(element);
      if (query && !`${name} ${text}`.toLowerCase().includes(query)) continue;

      const ref = `e${++counter}`;
      refs.set(ref, element);
      const entry = {
        ref,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || inferredRole(element),
        name: limitText(name, nameLimit),
        text: limitText(text, nameLimit),
        value: formValue(element),
        checked: checkedValue(element),
        disabled: isDisabled(element),
        href: element instanceof HTMLAnchorElement ? element.href : undefined,
      };

      if (!options.compact || options.includeBounds) {
        entry.bounds = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      elements.push(entry);
      if (elements.length >= elementLimit) break;
    }

    return {
      url: location.href,
      title: document.title,
      text: limitText(compactText(document.body?.innerText ?? ""), textLimit),
      elements,
    };
  }

  function collectCandidates() {
    const selector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "label",
      "[role]",
      "[tabindex]",
      "[contenteditable='true']",
      "[onclick]",
      "[aria-label]",
      "[aria-labelledby]",
    ].join(",");
    return collectCandidatesInDocument(document, selector);
  }

  function collectCandidatesInDocument(rootDocument, selector) {
    const candidates = Array.from(rootDocument.querySelectorAll(selector));
    for (const iframe of rootDocument.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument) candidates.push(...collectCandidatesInDocument(iframe.contentDocument, selector));
      } catch {
        // Cross-origin iframes cannot be inspected from the content script.
      }
    }
    return candidates;
  }

  function click(ref, button) {
    const element = resolveRef(ref);
    scrollToElement(element);

    if (button === "right") {
      element.dispatchEvent(new MouseEvent("contextmenu", mouseOptions()));
      return { clicked: ref, button };
    }

    element.dispatchEvent(new MouseEvent("mousedown", mouseOptions()));
    element.dispatchEvent(new MouseEvent("mouseup", mouseOptions()));
    element.click();
    return { clicked: ref, button };
  }

  function clickAt(x, y, button) {
    const pointX = clampNumber(x, 0, innerWidth, Math.round(innerWidth / 2));
    const pointY = clampNumber(y, 0, innerHeight, Math.round(innerHeight / 2));
    const element = targetFromPoint(document, pointX, pointY);
    if (!element) throw new Error(`No element at viewport coordinates ${pointX},${pointY}.`);

    if (element instanceof HTMLElement || element instanceof SVGElement) {
      element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }

    const options = mouseOptions({ clientX: pointX, clientY: pointY, button: mouseButton(button) });
    const target = element instanceof Element ? element : document.body;

    if (button === "right") {
      target.dispatchEvent(new MouseEvent("contextmenu", options));
      return { clickedAt: { x: pointX, y: pointY }, tag: target.tagName?.toLowerCase(), button };
    }

    target.dispatchEvent(new PointerEvent("pointerdown", { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mousedown", options));
    target.dispatchEvent(new PointerEvent("pointerup", { ...options, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mouseup", options));
    target.dispatchEvent(new MouseEvent("click", options));
    if (typeof target.click === "function") target.click();
    return { clickedAt: { x: pointX, y: pointY }, tag: target.tagName?.toLowerCase(), button };
  }

  function targetFromPoint(rootDocument, x, y) {
    const element = rootDocument.elementFromPoint(x, y);
    if (!(element instanceof HTMLIFrameElement)) return element;

    try {
      const iframeDocument = element.contentDocument;
      if (!iframeDocument) return element;
      const rect = element.getBoundingClientRect();
      return targetFromPoint(iframeDocument, x - rect.left, y - rect.top) || element;
    } catch {
      return element;
    }
  }

  function typeInto(ref, text, clear, submit) {
    const element = resolveRef(ref);
    scrollToElement(element);
    focusElement(element);

    if (isEditableInput(element)) {
      if (clear) element.value = "";
      element.value += text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      if (clear) element.textContent = "";
      document.execCommand("insertText", false, text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      throw new Error(`Element ${ref} is not editable.`);
    }

    if (submit) pressKey("Enter");
    return { typed: ref, length: text.length, submitted: submit };
  }

  function pressKey(key) {
    const target = document.activeElement || document.body;
    const normalized = normalizeKey(key);
    if (normalized.key === "Tab") {
      moveFocus(normalized.shiftKey ? -1 : 1);
      return { pressed: key };
    }

    target.dispatchEvent(new KeyboardEvent("keydown", { ...normalized, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { ...normalized, bubbles: true, cancelable: true }));

    if (normalized.key === "Enter" && target instanceof HTMLElement) {
      const form = target.closest("form");
      if (form instanceof HTMLFormElement) form.requestSubmit();
    }

    return { pressed: key };
  }

  function evaluate(code) {
    if (typeof code !== "string" || code.trim() === "") throw new Error("code is required.");
    const result = Function(`"use strict"; return (${code});`)();
    return toJsonSafe(result);
  }

  function scrollPage(direction, amount) {
    const dir = typeof direction === "string" ? direction.toLowerCase() : "down";
    const scroller = document.scrollingElement || document.documentElement || document.body;
    const maxScroll = Math.max(0, (scroller?.scrollHeight ?? 0) - innerHeight);
    const viewportStep = Math.max(1, innerHeight - 100);
    const step = typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? Math.round(amount) : viewportStep;

    switch (dir) {
      case "top":
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        break;
      case "bottom":
        window.scrollTo({ top: maxScroll, left: 0, behavior: "instant" });
        break;
      case "up":
        window.scrollBy({ top: -step, left: 0, behavior: "instant" });
        break;
      case "down":
      default:
        window.scrollBy({ top: step, left: 0, behavior: "instant" });
        break;
    }

    return scrollMetrics({ direction: dir, amount: dir === "up" || dir === "down" ? step : undefined });
  }

  function scrollRefIntoView(ref) {
    const element = resolveRef(ref);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return scrollMetrics({ ref });
  }

  function scrollMetrics(extra) {
    const scroller = document.scrollingElement || document.documentElement || document.body;
    return {
      ...extra,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      innerHeight: Math.round(innerHeight),
      scrollHeight: Math.round(scroller?.scrollHeight ?? 0),
      atTop: window.scrollY <= 0,
      atBottom: window.scrollY + innerHeight >= (scroller?.scrollHeight ?? 0) - 1,
    };
  }

  function resolveRef(ref) {
    const element = refs.get(ref);
    if (!element) throw new Error(`Unknown element ref "${ref}". Call browser_snapshot again.`);
    return element;
  }

  // Locate the target file <input>, tag it with a unique attribute, and return a
  // selector the background page can resolve via the debugger (DOM.setFileInputFiles).
  // The real <input type=file> is usually visually hidden, so it is not in the snapshot
  // ref map — default to the first file input on the page.
  function markFileInput(ref, selector) {
    let element = null;
    if (ref) {
      element = refs.get(ref) || null;
    } else if (typeof selector === "string" && selector.trim() !== "") {
      element = document.querySelector(selector);
    } else {
      element = document.querySelector('input[type="file"]');
    }

    // If the resolved element is a wrapper (e.g. a dropzone), dig out its file input.
    if (element && !(element instanceof HTMLInputElement && element.type === "file")) {
      const nested = element.querySelector ? element.querySelector('input[type="file"]') : null;
      if (nested) element = nested;
    }

    if (!(element instanceof HTMLInputElement) || element.type !== "file") {
      throw new Error("No file <input> found to upload into. Pass a selector or ref that resolves to one.");
    }

    const token = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    element.setAttribute("data-relay-file-target", token);
    return { selector: `[data-relay-file-target="${token}"]`, multiple: element.multiple === true };
  }

  function unmarkFileInput(selector) {
    if (typeof selector === "string") {
      const element = document.querySelector(selector);
      if (element) element.removeAttribute("data-relay-file-target");
    }
    return { unmarked: true };
  }

  function scrollToElement(element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }

  function focusElement(element) {
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(" ");
      if (label) return compactText(label);
    }
    return compactText(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        (element instanceof HTMLInputElement ? element.placeholder : "") ||
        elementText(element)
    );
  }

  function elementText(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value || element.placeholder || "";
    if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.textContent || "";
    return element.textContent || "";
  }

  function compactText(text) {
    return String(text).replace(/\s+/g, " ").trim();
  }

  function limitText(text, limit) {
    if (!limit || text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
  }

  function clampNumber(value, min, max, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  function formValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
    return undefined;
  }

  function checkedValue(element) {
    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) return element.checked;
    return undefined;
  }

  function isDisabled(element) {
    return Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
  }

  function inferredRole(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = element.getAttribute("type") || "text";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return undefined;
  }

  function isEditableInput(element) {
    return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !["button", "checkbox", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type));
  }

  function moveFocus(direction) {
    const focusable = collectCandidates().filter((element) => element instanceof HTMLElement && isVisible(element) && !isDisabled(element));
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + focusable.length) % focusable.length;
    const next = focusable[nextIndex];
    if (next instanceof HTMLElement) next.focus();
  }

  function normalizeKey(chord) {
    const parts = String(chord).split("+");
    const key = parts.pop() || chord;
    return {
      key: keyName(key),
      code: keyCode(key),
      ctrlKey: parts.includes("Ctrl") || parts.includes("Control"),
      metaKey: parts.includes("Meta") || parts.includes("Cmd") || parts.includes("Mod"),
      altKey: parts.includes("Alt") || parts.includes("Option"),
      shiftKey: parts.includes("Shift"),
    };
  }

  function keyName(key) {
    const aliases = { Return: "Enter", Esc: "Escape", Space: " ", Cmd: "Meta" };
    return aliases[key] || key;
  }

  function keyCode(key) {
    const normalized = keyName(key);
    if (normalized.length === 1) return `Key${normalized.toUpperCase()}`;
    return normalized;
  }

  function mouseOptions(overrides = {}) {
    return { bubbles: true, cancelable: true, view: window, ...overrides };
  }

  function mouseButton(button) {
    if (button === "middle") return 1;
    if (button === "right") return 2;
    return 0;
  }

  function toJsonSafe(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }
})();
