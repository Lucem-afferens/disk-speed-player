// Runs entirely on the viewer's device. Persists only expiring source metadata.
importScripts("./stream-store.js?v=20261115.2");
const VERSION = "20261115.2",
  sources = new Map(),
  renewals = new Map(),
  failures = new Map();
const prefix = new URL("./_stream/", self.registration.scope).pathname;
const mediaHost =
  /(^|\.)(yandex\.(ru|net|com|com\.tr|by|kz)|yandexcloud\.net)$/;
function valid(entry) {
  try {
    const u = new URL(entry.href);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      mediaHost.test(u.hostname) &&
      Number.isSafeInteger(entry.size) &&
      entry.size > 0 &&
      entry.expires > Date.now() &&
      Array.isArray(entry.patches) &&
      entry.patches.length <= 100 &&
      entry.patches.every(
        (p) => Number.isSafeInteger(p) && p >= 0 && p + 4 <= entry.size,
      )
    );
  } catch {
    return false;
  }
}
function validSource(source) {
  try {
    const u = new URL(source.key);
    return (
      u.protocol === "https:" &&
      [
        "disk.yandex.ru",
        "disk.yandex.com",
        "disk.yandex.by",
        "disk.yandex.kz",
        "disk.360.yandex.ru",
        "yadi.sk",
      ].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      /^\/[di]\/[^/]+$/.test(u.pathname) &&
      (!source.path ||
        (typeof source.path === "string" &&
          source.path.startsWith("/") &&
          source.path.length < 8192))
    );
  } catch {
    return false;
  }
}
async function remember(token, entry) {
  sources.set(token, entry);
  try {
    await StreamStore.put(token, entry);
    return true;
  } catch {
    return false;
  }
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    Promise.all([self.clients.claim(), StreamStore.clean().catch(() => {})]),
  ),
);
self.addEventListener("message", (event) => {
  const { type, token, entry } = event.data || {};
  event.waitUntil(
    (async () => {
      if (type === "disk-play-register") {
        if (typeof token === "string" && valid(entry)) {
          failures.delete(token);
          const persistent = await remember(token, entry);
          await StreamStore.clean().catch(() => {});
          event.ports[0]?.postMessage({
            ok: true,
            persistent,
            version: VERSION,
          });
        } else event.ports[0]?.postMessage({ ok: false, version: VERSION });
      } else if (type === "disk-play-release") {
        sources.delete(token);
        failures.delete(token);
        await StreamStore.delete(token).catch(() => {});
      } else if (type === "disk-play-clear") {
        sources.clear();
        failures.clear();
        await StreamStore.clear().catch(() => {});
        event.ports[0]?.postMessage({ ok: true });
      }
    })(),
  );
});
async function lookup(token, clientId) {
  if (valid(sources.get(token))) return sources.get(token);
  try {
    const saved = await StreamStore.get(token);
    if (valid(saved)) {
      sources.set(token, saved);
      return saved;
    }
  } catch {}
  // Some Safari media requests use an internal client id, not a WindowClient.
  const primary = clientId ? await self.clients.get(clientId) : null;
  const all = await self.clients.matchAll({ type: "window" });
  const clients = [
    ...(primary ? [primary] : []),
    ...all.filter((client) => client.id !== primary?.id),
  ];
  for (const client of clients) {
    const value = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        resolve(null);
      }, 2500);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(event.data);
      };
      client.postMessage({ type: "disk-play-source", token }, [channel.port2]);
    });
    if (valid(value)) {
      await remember(token, value);
      return value;
    }
  }
  return null;
}
function rangeOf(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? { start, end, partial: true }
    : null;
}
async function report(token, code, status = 0) {
  const detail = { code, status, version: VERSION, time: Date.now() };
  failures.set(token, detail);
  for (const client of await self.clients.matchAll({ type: "window" }))
    client.postMessage({ type: "disk-play-stream-error", token, ...detail });
}
async function renew(token, entry) {
  if (!validSource(entry.source)) throw new Error("No source for renewal");
  if (!renewals.has(token))
    renewals.set(
      token,
      (async () => {
        const params = new URLSearchParams({ public_key: entry.source.key });
        if (entry.source.path && entry.source.path !== "/")
          params.set("path", entry.source.path);
        const response = await fetch(
          "https://cloud-api.yandex.net/v1/disk/public/resources/download?" +
            params,
          {
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(20000),
          },
        );
        if (!response.ok) {
          const error = new Error("Download URL renewal failed");
          error.status = response.status;
          throw error;
        }
        const body = await response.json();
        const next = {
          ...entry,
          href: body.href,
          expires: Date.now() + 21600000,
        };
        if (!valid(next)) throw new Error("Invalid renewed source");
        Object.assign(entry, next);
        await remember(token, entry);
      })().finally(() => renewals.delete(token)),
    );
  await renewals.get(token);
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // WebKit drops Range on the browser's implicit pass-through once a worker
  // controls the page. Explicitly forwarding the original request preserves it.
  if (
    url.protocol === "https:" &&
    mediaHost.test(url.hostname) &&
    event.request.headers.has("Range")
  ) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix))
    return;
  const token = url.pathname.slice(prefix.length);
  if (url.searchParams.has("status")) {
    event.respondWith(
      new Response(
        JSON.stringify({
          version: VERSION,
          failure: failures.get(token) || null,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      ),
    );
    return;
  }
  event.respondWith(stream(event, token));
});
async function stream(event, token) {
  if (!["GET", "HEAD"].includes(event.request.method))
    return new Response(null, { status: 405 });
  const entry = await lookup(token, event.clientId);
  if (!entry) {
    await report(token, "source_missing", 410);
    return new Response("Обновите ссылку в плеере.", { status: 410 });
  }
  const range = rangeOf(event.request.headers.get("Range"), entry.size);
  if (!range)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${entry.size}` },
    });
  const { start } = range;
  let end = range.end;
  let headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "no-store",
  };
  if (range.partial)
    headers["Content-Range"] = `bytes ${start}-${end}/${entry.size}`;
  if (event.request.method === "HEAD")
    return new Response(null, { status: range.partial ? 206 : 200, headers });
  try {
    const get = () =>
      fetch(entry.href, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: event.request.signal,
        cache: "no-store",
      });
    let response;
    try {
      response = await get();
    } catch (error) {
      if (event.request.signal.aborted) throw error;
      await renew(token, entry);
      response = await get();
    }
    if (
      [401, 403, 404, 410].includes(response.status) &&
      validSource(entry.source)
    ) {
      await response.body?.cancel();
      await renew(token, entry);
      response = await get();
    }
    if (response.status !== 206 || !response.body) {
      const status = response.status;
      await response.body?.cancel();
      await report(token, "upstream_http", status);
      return new Response("Диск временно не отдаёт видео.", { status: 502 });
    }
    const remoteRange = response.headers.get("Content-Range");
    if (remoteRange) {
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(remoteRange);
      if (
        !match ||
        Number(match[1]) !== start ||
        Number(match[2]) > end ||
        Number(match[2]) < start ||
        Number(match[3]) !== entry.size
      ) {
        await response.body.cancel();
        await report(token, "range_mismatch", 502);
        return new Response(null, { status: 502 });
      }
      end = Number(match[2]);
    }
    headers["Content-Length"] = String(end - start + 1);
    const partial = range.partial || start !== 0 || end !== entry.size - 1;
    if (partial)
      headers["Content-Range"] = `bytes ${start}-${end}/${entry.size}`;
    failures.delete(token);
    let position = start;
    const replacement = [104, 118, 99, 49];
    const output = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (position + chunk.length > end + 1)
            throw new Error("Invalid range body");
          let data = chunk;
          for (const patch of entry.patches)
            if (patch < position + chunk.length && patch + 4 > position) {
              if (data === chunk) data = chunk.slice();
              for (let i = 0; i < 4; i++) {
                const index = patch + i - position;
                if (index >= 0 && index < data.length)
                  data[index] = replacement[i];
              }
            }
          position += chunk.length;
          controller.enqueue(data);
        },
        flush() {
          if (position !== end + 1) throw new Error("Truncated response");
        },
      }),
    );
    return new Response(output, { status: partial ? 206 : 200, headers });
  } catch (error) {
    if (!event.request.signal.aborted)
      await report(token, "network", error.status || 0);
    return new Response("Соединение с Диском прервалось.", { status: 502 });
  }
}
