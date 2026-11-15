// Keep startup independent of the module graph: a failed import must be visible,
// not leave an apparently working Open button. Never reload automatically.
(() => {
  const build = document.currentScript.dataset.version;
  const key = "disk-play:v1:diagnostics";
  let events = [];
  try {
    events = JSON.parse(sessionStorage.getItem(key)) || [];
  } catch {}
  if (!Array.isArray(events)) events = [];
  function record(event, values = {}) {
    events.push({ time: new Date().toISOString(), event, build, ...values });
    events = events.slice(-40);
    try {
      sessionStorage.setItem(key, JSON.stringify(events));
    } catch {}
  }
  window.diskPlayDiagnostics = {
    record,
    read: () => ({
      build,
      workerBuild: navigator.serviceWorker?.controller
        ? new URL(
            navigator.serviceWorker.controller.scriptURL,
          ).searchParams.get("v")
        : null,
      standalone:
        navigator.standalone === true ||
        matchMedia("(display-mode: standalone)").matches,
      events: [...events],
    }),
  };
  record("boot", {
    discarded: document.wasDiscarded === true,
    navigation:
      performance.getEntriesByType("navigation")[0]?.type || "unknown",
  });
  addEventListener("pagehide", (event) =>
    record("pagehide", { persisted: event.persisted }),
  );
  addEventListener("pageshow", (event) =>
    record("pageshow", { persisted: event.persisted }),
  );
  document.addEventListener("visibilitychange", () =>
    record("visibility", { state: document.visibilityState }),
  );
  addEventListener("error", () => record("script-error"));
  addEventListener("unhandledrejection", () => record("unhandled-rejection"));
  navigator.serviceWorker?.addEventListener("controllerchange", () =>
    record("worker-controller-change"),
  );
  const status = document.getElementById("boot-status");
  const text = document.getElementById("boot-message");
  const open = document.getElementById("open-source");
  const timer = setTimeout(() => {
    text.textContent =
      "Плеер загружается дольше обычного. Проверьте интернет или обновите страницу.";
  }, 10000);
  import(`./app.js?v=${build}`)
    .then(() => {
      clearTimeout(timer);
      document.documentElement.dataset.appReady = "true";
      status.hidden = true;
      document.getElementById("source").disabled = false;
      open.disabled = false;
      record("ready");
      dispatchEvent(new Event("disk-play-ready"));
    })
    .catch(() => {
      clearTimeout(timer);
      record("startup-failed");
      status.classList.add("error");
      text.textContent =
        "Не удалось загрузить плеер. Проверьте интернет и нажмите «Обновить страницу».";
    });
})();
