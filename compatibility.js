import { inspectRemoteMP4 } from "./mp4.js?v=20261115.3";
import "./stream-store.js?v=20261115.3";
export const VERSION = "20261115.3";
const sources = new Map(),
  inspections = new Map(),
  errors = new Map();
let registration = null,
  sourceEpoch = 0;
const resetKey = "disk-play:v1:reset";
const resetIds = new Set();
let resetChannel;
try {
  resetChannel = new BroadcastChannel("disk-play-reset");
} catch {}
function forgetSources() {
  sourceEpoch++;
  sources.clear();
  inspections.clear();
  errors.clear();
}
function receiveClear(detail) {
  if (!detail || typeof detail.id !== "string" || resetIds.has(detail.id))
    return;
  resetIds.add(detail.id);
  if (resetIds.size > 100) resetIds.delete(resetIds.values().next().value);
  forgetSources();
  window.dispatchEvent(new CustomEvent("disk-play-cleared", { detail }));
}
if (resetChannel) resetChannel.onmessage = (event) => receiveClear(event.data);
window.addEventListener("storage", (event) => {
  if (event.key !== resetKey || !event.newValue) return;
  try {
    receiveClear(JSON.parse(event.newValue));
  } catch {}
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "disk-play-source") {
      const entry = sources.get(event.data.token);
      if (entry) entry.expires = Date.now() + 21600000;
      event.ports[0]?.postMessage(entry || null);
    } else if (event.data?.type === "disk-play-cleared")
      receiveClear(event.data.detail);
    else if (
      event.data?.type === "disk-play-stream-error" &&
      sources.has(event.data.token)
    )
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
  const epoch = sourceEpoch;
  // Update an already installed worker BEFORE asking for ranges: the old worker
  // can trigger WebKit's dropped-Range pass-through bug on the first request.
  await worker();
  if (signal?.aborted || epoch !== sourceEpoch)
    throw new DOMException("Cancelled", "AbortError");
  if (identity && inspections.has(identity)) return inspections.get(identity);
  const info = await inspectRemoteMP4(href, size, signal);
  if (signal?.aborted || epoch !== sourceEpoch)
    throw new DOMException("Cancelled", "AbortError");
  if (identity) {
    if (inspections.size >= 128)
      inspections.delete(inspections.keys().next().value);
    inspections.set(identity, info);
  }
  return info;
}
export async function compatibleSource(href, size, signal, options = {}) {
  const epoch = sourceEpoch;
  const info =
    options.info || (await inspectSource(href, size, signal, options.identity));
  if (!info.patches.length) return null;
  if (signal?.aborted || epoch !== sourceEpoch)
    throw new DOMException("Cancelled", "AbortError");
  const active = await worker();
  if (signal?.aborted || epoch !== sourceEpoch)
    throw new DOMException("Cancelled", "AbortError");
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
    if (signal?.aborted || epoch !== sourceEpoch)
      throw new DOMException("Cancelled", "AbortError");
  } catch (error) {
    releaseSource(token);
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
export async function clearSources(detail) {
  resetIds.add(detail.id);
  forgetSources();
  resetChannel?.postMessage(detail);
  try {
    localStorage.setItem(resetKey, JSON.stringify(detail));
  } catch {}
  const existing = await navigator.serviceWorker?.getRegistration(
    new URL("./", import.meta.url).href,
  );
  if (!existing) {
    // A suspended worker may have left metadata even without a controller.
    await StreamStore.clear();
    return;
  }
  const active = await worker();
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Хранилище не ответило. Нажмите очистку ещё раз."));
    }, 10000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      if (event.data?.ok && event.data.version === VERSION) resolve();
      else
        reject(
          new Error("Не удалось удалить временные данные. Повторите очистку."),
        );
    };
    active.postMessage({ type: "disk-play-clear", detail }, [channel.port2]);
  });
}
