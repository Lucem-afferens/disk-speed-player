// Own the entire Space press, including keyup (native buttons activate there).
// Keep focus and normal Enter activation; only text editing owns its own spaces.
export function bindPlaybackSpace({ isActive, toggle }) {
  let held = false;
  const isSpace = (event) =>
    event.code === "Space" || event.key === " " || event.key === "Spacebar";
  function editing(event) {
    return event.composedPath().some((node) => {
      if (!(node instanceof Element)) return false;
      if (
        node.isContentEditable ||
        node.matches('textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"]')
      ) return true;
      return (
        node instanceof HTMLInputElement &&
        !["range", "checkbox", "radio", "button", "submit", "reset"].includes(node.type)
      );
    });
  }
  function eligible(event) {
    return (
      isActive() && !event.isComposing && !event.altKey &&
      !event.ctrlKey && !event.metaKey && !editing(event)
    );
  }
  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  document.addEventListener("keydown", (event) => {
    if (!isSpace(event) || (!held && !eligible(event))) return;
    consume(event);
    const firstPress = !held && !event.repeat;
    held = true;
    if (firstPress) toggle();
  }, true);
  document.addEventListener("keyup", (event) => {
    if (!isSpace(event) || (!held && !eligible(event))) return;
    consume(event);
    held = false;
  }, true);
  window.addEventListener("blur", () => { held = false; });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) held = false;
  });
}

// Fullscreen chrome follows user activity, never playback timeupdate events.
export function autoHideControls({
  player,
  isExpanded,
  isBlocked,
  delay = 3000,
}) {
  let timer,
    lastActivity = performance.now(),
    pressed = false,
    keyboard = false,
    wakeClick = false;
  const panels = ".player-heading, .controls, .center-play, #speed-panel";
  function refresh() {
    clearTimeout(timer);
    if (!isExpanded()) {
      player.classList.remove("controls-hidden");
      return;
    }
    if (
      pressed ||
      isBlocked() ||
      (keyboard &&
        player.contains(document.activeElement) &&
        document.activeElement.closest(panels))
    )
      return;
    const remaining = delay - (performance.now() - lastActivity);
    if (remaining <= 0) player.classList.add("controls-hidden");
    else timer = setTimeout(refresh, remaining);
  }
  function show() {
    lastActivity = performance.now();
    player.classList.remove("controls-hidden");
    refresh();
  }
  player.addEventListener(
    "pointerdown",
    () => {
      wakeClick = player.classList.contains("controls-hidden");
      pressed = true;
      keyboard = false;
      show();
    },
    true,
  );
  // A first tap on a clean video only reveals chrome; it must not pause it.
  player.addEventListener(
    "click",
    (event) => {
      if (wakeClick) {
        wakeClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        show();
      }
    },
    true,
  );
  window.addEventListener("pointerup", () => {
    if (pressed) {
      pressed = false;
      show();
    }
  });
  window.addEventListener("pointercancel", () => {
    pressed = false;
    wakeClick = false;
    show();
  });
  player.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") {
      keyboard = false;
      show();
    }
  });
  player.addEventListener("input", show);
  document.addEventListener(
    "keydown",
    () => {
      if (isExpanded()) {
        keyboard = true;
        show();
      }
    },
    true,
  );
  player.addEventListener("focusout", () => setTimeout(refresh, 0));
  document.addEventListener("visibilitychange", () => {
    pressed = false;
    if (document.hidden) clearTimeout(timer);
    else show();
  });
  for (const dialog of document.querySelectorAll("dialog"))
    dialog.addEventListener("close", show);
  return { show, refresh };
}
