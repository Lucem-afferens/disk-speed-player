import { inspectRemoteMP4 } from "./mp4.js";
const sources = new Map();
let registration = null;
// Media source credentials live only in this tab's memory. Rehydrate a worker
// after suspension without putting signed URLs into persistent storage or URLs.
if ("serviceWorker" in navigator)
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "disk-play-source")
      event.ports[0]?.postMessage(sources.get(event.data.token) || null);
  });
async function worker() {
  if (!("serviceWorker" in navigator))
    throw new Error("Совместимый поток не поддерживается этим браузером.");
  if (!registration)
    registration = navigator.serviceWorker
      .register(new URL("./stream-worker.js", import.meta.url), { scope: "./" })
      .catch((error) => {
        registration = null;
        throw error;
      });
  const result = await registration;
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          changed,
        );
        reject(
          new Error(
            "Не удалось включить совместимый поток. Обновите страницу.",
          ),
        );
      }, 5000);
      function changed() {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          changed,
        );
        resolve();
      }
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      if (navigator.serviceWorker.controller) changed();
    });
  return result.active;
}
export async function compatibleSource(href, size, signal) {
  const info = await inspectRemoteMP4(href, size, signal);
  if (!info.patches.length) return null;
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const active = await worker(),
    token = crypto.randomUUID();
  const entry = {
    href,
    size,
    patches: info.patches,
    expires: Date.now() + 3600000,
  };
  sources.set(token, entry);
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("Совместимый поток не отвечает."));
    }, 5000);
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
  return {
    url: new URL(`./_stream/${token}`, import.meta.url).href,
    token,
    duration: info.duration,
  };
}
export function releaseSource(token) {
  if (!token) return;
  sources.delete(token);
  navigator.serviceWorker?.controller?.postMessage({
    type: "disk-play-release",
    token,
  });
}
