import { inspectRemoteMP4 } from "./mp4.js?v=20261115.2";
export const VERSION = "20261115.2";
const sources = new Map(),
  inspections = new Map(),
  errors = new Map();
let registration = null;
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "disk-play-source") {
      const entry = sources.get(event.data.token);
      if (entry) entry.expires = Date.now() + 21600000;
      event.ports[0]?.postMessage(entry || null);
    } else if (event.data?.type === "disk-play-stream-error")
      errors.set(event.data.token, event.data);
  });
function activated(worker) {
  if (worker?.state === "activated") return Promise.resolve();
  if (!worker)
    return Promise.reject(new Error("Не удалось запустить совместимый поток."));
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", changed);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (worker.state === "activated") finish();
      else if (worker.state === "redundant")
        finish(new Error("Подготовка потока прервалась. Повторите попытку."));
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Подготовка потока заняла слишком много времени. Повторите попытку.",
          ),
        ),
      10000,
    );
    worker.addEventListener("statechange", changed);
    changed();
  });
}
async function worker() {
  if (!("serviceWorker" in navigator))
    throw new Error(
      "Этот браузер не поддерживает совместимый поток. Откройте страницу в Safari или Chrome.",
    );
  const script = new URL("./stream-worker.js?v=" + VERSION, import.meta.url)
    .href;
  if (!registration)
    registration = navigator.serviceWorker
      .register(script, { scope: "./", updateViaCache: "none" })
      .catch((error) => {
        registration = null;
        throw error;
      });
  const result = await registration;
  await activated(result.installing || result.waiting || result.active);
  if (navigator.serviceWorker.controller?.scriptURL !== script)
    await new Promise((resolve, reject) => {
      const changed = () => {
        if (navigator.serviceWorker.controller?.scriptURL === script) {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            changed,
          );
          resolve();
        }
      };
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          changed,
        );
        reject(
          new Error(
            "Обновление плеера ещё не завершилось. Перезагрузите страницу.",
          ),
        );
      }, 8000);
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      changed();
    });
  return navigator.serviceWorker.controller;
}
export async function inspectSource(href, size, signal, identity) {
  // Update an already installed worker BEFORE asking for ranges: the old worker
  // can trigger WebKit's dropped-Range pass-through bug on the first request.
  await worker();
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  if (identity && inspections.has(identity)) return inspections.get(identity);
  const info = await inspectRemoteMP4(href, size, signal);
  if (identity) {
    if (inspections.size >= 128)
      inspections.delete(inspections.keys().next().value);
    inspections.set(identity, info);
  }
  return info;
}
export async function compatibleSource(href, size, signal, options = {}) {
  const info =
    options.info || (await inspectSource(href, size, signal, options.identity));
  if (!info.patches.length) return null;
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const active = await worker();
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const token = crypto.randomUUID(),
    entry = {
      href,
      size,
      patches: info.patches,
      source: options.source,
      expires: Date.now() + 21600000,
    };
  sources.set(token, entry);
  try {
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel(),
        timer = setTimeout(() => {
          channel.port1.close();
          reject(
            new Error("Совместимый поток не отвечает. Повторите попытку."),
          );
        }, 8000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        event.data?.ok
          ? resolve()
          : reject(new Error("Не удалось подготовить поток."));
      };
      active.postMessage({ type: "disk-play-register", token, entry }, [
        channel.port2,
      ]);
    });
  } catch (error) {
    sources.delete(token);
    throw error;
  }
  return {
    url: new URL("./_stream/" + token, import.meta.url).href,
    token,
    duration: info.duration,
  };
}
export async function streamFailure(token, url) {
  if (url)
    try {
      const response = await fetch(url + "?status=1", { cache: "no-store" });
      if (response.ok) return (await response.json()).failure;
    } catch {}
  return errors.get(token) || null;
}
export function releaseSource(token) {
  if (!token) return;
  sources.delete(token);
  errors.delete(token);
  navigator.serviceWorker?.controller?.postMessage({
    type: "disk-play-release",
    token,
  });
}
export function clearSources() {
  sources.clear();
  errors.clear();
  navigator.serviceWorker?.controller?.postMessage({ type: "disk-play-clear" });
}
