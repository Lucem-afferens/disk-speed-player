import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
const code = readFileSync(
  new URL("../stream-worker.js", import.meta.url),
  "utf8",
);
const origin = "https://player.example",
  token = "test-token";
const makeEntry = () => ({
  href: "https://storage.yandex.net/original",
  size: 16,
  patches: [4],
  expires: Date.now() + 60000,
  source: { key: "https://disk.yandex.ru/d/test-public", path: "/camera.mp4" },
});
function boot({ db = new Map(), clients = [], fetcher, storage = {} } = {}) {
  const handlers = new Map(),
    store = {
      get: async (k) => db.get(k),
      put: async (k, v) => db.set(k, structuredClone(v)),
      delete: async (k) => db.delete(k),
      clear: async () => db.clear(),
      clean: async () => {},
      ...storage,
    };
  const scope = {
    registration: { scope: origin + "/" },
    location: { origin },
    clients: {
      get: async (id) => clients.find((c) => c.id === id),
      matchAll: async () => clients,
      claim: async () => {},
    },
    skipWaiting: async () => {},
    addEventListener: (t, h) => handlers.set(t, h),
  };
  vm.runInNewContext(code, {
    self: scope,
    importScripts: () => {},
    StreamStore: store,
    URL,
    URLSearchParams,
    Request,
    Response,
    TransformStream,
    MessageChannel,
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch:
      fetcher ||
      (() => {
        throw Error("Unexpected network request");
      }),
  });
  return {
    async message(type, extra = {}) {
      let promise, reply;
      handlers.get("message")({
        data: { type, token, ...extra },
        ports: [{ postMessage: (value) => (reply = value) }],
        waitUntil: (p) => (promise = p),
      });
      await promise;
      return reply;
    },
    forward(request) {
      let result;
      handlers.get("fetch")({ request, respondWith: (p) => (result = p) });
      return result;
    },
    async register(entry = makeEntry()) {
      let promise, reply;
      handlers.get("message")({
        data: { type: "disk-play-register", token, entry },
        ports: [{ postMessage: (value) => (reply = value) }],
        waitUntil: (p) => (promise = p),
      });
      await promise;
      return reply;
    },
    request(range = "bytes=0-15", clientId = "internal-media-client") {
      let result;
      handlers.get("fetch")({
        clientId,
        request: new Request(origin + "/_stream/" + token, {
          headers: range ? { Range: range } : {},
        }),
        respondWith: (p) => (result = p),
      });
      return result;
    },
    async status() {
      let result;
      handlers.get("fetch")({
        request: new Request(origin + "/_stream/" + token + "?status=1"),
        respondWith: (p) => (result = p),
      });
      return (await result).json();
    },
  };
}
function rangeResponse(start = 0, end = 15) {
  const bytes = Uint8Array.from(
    { length: end - start + 1 },
    (_, i) => start + i,
  );
  return new Response(bytes, {
    status: 206,
    headers: { "Content-Range": `bytes ${start}-${end}/16` },
  });
}
test("forwards cross-origin Yandex Range requests without losing their headers", async () => {
  const original = new Request("https://storage.yandex.net/video", {
    headers: { Range: "bytes=0-15" },
    credentials: "omit",
    cache: "no-store",
  });
  let forwarded;
  const worker = boot({
    fetcher: async (request) => {
      forwarded = request;
      return rangeResponse();
    },
  });
  const response = await worker.forward(original);
  assert.equal(response.status, 206);
  assert.equal(forwarded, original);
  assert.equal(forwarded.headers.get("Range"), "bytes=0-15");
  assert.equal(forwarded.credentials, "omit");
  assert.equal(
    worker.forward(new Request("https://example.net/unrelated")),
    undefined,
  );
  await response.arrayBuffer();
});
test("stream survives worker restart without any window clients", async () => {
  const db = new Map();
  const first = boot({ db });
  assert.equal((await first.register()).persistent, true);
  const restarted = boot({ db, fetcher: async () => rangeResponse() });
  const response = await restarted.request();
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-length"), "16");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(4, 8)), "hvc1");
  assert.equal(bytes[8], 8);
});
test("unknown internal media client falls back to open windows when storage is empty", async () => {
  const clients = [
    {
      id: "window-1",
      postMessage(message, ports) {
        if (message.type === "disk-play-source")
          ports[0].postMessage(makeEntry());
      },
    },
  ];
  const worker = boot({ clients, fetcher: async () => rangeResponse() });
  const response = await worker.request();
  assert.equal(response.status, 206);
  await response.arrayBuffer();
});
test("range starting inside the patched tag changes only requested bytes", async () => {
  const worker = boot({ fetcher: async () => rangeResponse(6, 9) });
  await worker.register();
  const response = await worker.request("bytes=6-9");
  assert.equal(response.headers.get("content-range"), "bytes 6-9/16");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [99, 49, 8, 9],
  );
});
test("a shorter valid partial range is accepted with its actual length", async () => {
  const worker = boot({ fetcher: async () => rangeResponse(0, 1) });
  await worker.register();
  const response = await worker.request();
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-1/16");
  assert.equal((await response.arrayBuffer()).byteLength, 2);
});
test("expired upstream URL is renewed once and persisted", async () => {
  const calls = [],
    db = new Map();
  const worker = boot({
    db,
    fetcher: async (url) => {
      calls.push(url);
      if (url.includes("cloud-api.yandex.net"))
        return Response.json({ href: "https://storage.yandex.net/renewed" });
      if (url.endsWith("/original")) return new Response(null, { status: 403 });
      return rangeResponse();
    },
  });
  await worker.register();
  const response = await worker.request();
  assert.equal(response.status, 206);
  await response.arrayBuffer();
  assert.equal(calls.length, 3);
  assert.equal(db.get(token).href, "https://storage.yandex.net/renewed");
});
test("rate limiting stays a transport diagnostic, not a codec diagnosis", async () => {
  const worker = boot({
    fetcher: async () => new Response(null, { status: 429 }),
  });
  await worker.register();
  const response = await worker.request();
  assert.equal(response.status, 502);
  const status = await worker.status();
  assert.equal(status.failure.code, "upstream_http");
  assert.equal(status.failure.status, 429);
});
test("missing source and impossible range are explicit and never fetch media", async () => {
  const worker = boot();
  assert.equal((await worker.request()).status, 410);
  assert.equal((await worker.status()).failure.code, "source_missing");
  await worker.register();
  assert.equal((await worker.request("bytes=20-")).status, 416);
  assert.equal((await worker.request("bytes=-0")).status, 416);
});
test("rejects mismatching ranges and invalid registration sources", async () => {
  const worker = boot({ fetcher: async () => rangeResponse(1, 15) });
  assert.equal(
    (
      await worker.register({
        ...makeEntry(),
        href: "https://example.net/video",
      })
    ).ok,
    false,
  );
  await worker.register();
  assert.equal((await worker.request()).status, 502);
  assert.equal((await worker.status()).failure.code, "range_mismatch");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const type of ["disk-play-release", "disk-play-clear"]) {
  test(`${type} cannot be undone by an in-flight URL renewal`, async () => {
    const entered = deferred(),
      finish = deferred(),
      db = new Map();
    let renewalSignal;
    const worker = boot({
      db,
      fetcher: async (url, options) => {
        if (url.includes("cloud-api.yandex.net")) {
          renewalSignal = options.signal;
          entered.resolve();
          await finish.promise; // Deliberately ignore abort to exercise the stale-write guard.
          return Response.json({ href: "https://storage.yandex.net/renewed" });
        }
        return new Response(null, { status: 403 });
      },
    });
    await worker.register();
    const request = worker.request();
    await entered.promise;
    await worker.message(type, { detail: { id: "reset-1" } });
    assert.equal(renewalSignal.aborted, true);
    finish.resolve();
    await request;
    assert.equal(db.size, 0);
    assert.equal((await worker.request()).status, 410);
  });
  test(`${type} rejects a late client recovery reply`, async () => {
    const entered = deferred(),
      db = new Map();
    let port;
    const worker = boot({
      db,
      clients: [
        {
          id: "window",
          postMessage(message, ports) {
            if (message.type === "disk-play-source") {
              port = ports[0];
              entered.resolve();
            }
          },
        },
      ],
    });
    const pending = worker.request();
    await entered.promise;
    await worker.message(type, { detail: { id: "reset-2" } });
    port.postMessage(makeEntry());
    assert.equal((await pending).status, 410);
    assert.equal(db.size, 0);
  });
}
test("clear waits for pending storage writes and then removes every source", async () => {
  const entered = deferred(),
    finish = deferred(),
    db = new Map();
  const worker = boot({
    db,
    storage: {
      put: async (key, value) => {
        entered.resolve();
        await finish.promise;
        db.set(key, value);
      },
    },
  });
  const register = worker.register();
  await entered.promise;
  let cleared = false;
  const clear = worker.message("disk-play-clear").then((reply) => {
    cleared = true;
    return reply;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared, false);
  finish.resolve();
  assert.equal((await register).ok, false);
  assert.equal((await clear).ok, true);
  assert.equal(db.size, 0);
});
test("clear reports a storage failure instead of claiming success", async () => {
  const worker = boot({
    storage: {
      clear: async () => {
        throw Error("disk failure");
      },
    },
  });
  assert.equal((await worker.message("disk-play-clear")).ok, false);
});
test("clear cancels an already returned streaming body and allows new sources", async () => {
  let cancelled = false;
  const db = new Map();
  const worker = boot({
    db,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0, 1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 206, headers: { "Content-Range": "bytes 0-15/16" } },
      ),
  });
  await worker.register();
  const response = await worker.request(),
    reader = response.body.getReader();
  await reader.read();
  await worker.message("disk-play-clear");
  await assert.rejects(() => reader.read(), { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.equal(db.size, 0);
  const fresh = await worker.message("disk-play-register", {
    token: "new-token",
    entry: makeEntry(),
  });
  assert.equal(fresh.ok, true);
  assert.equal(db.size, 1);
});

test("a registration started during clear is persisted after the clear", async () => {
  const entered = deferred(),
    finish = deferred(),
    db = new Map();
  const worker = boot({
    db,
    storage: {
      clear: async () => {
        entered.resolve();
        await finish.promise;
        db.clear();
      },
    },
  });
  await worker.register();
  const clear = worker.message("disk-play-clear");
  const registration = worker.message("disk-play-register", {
    token: "next-token",
    entry: makeEntry(),
  });
  await entered.promise;
  finish.resolve();
  assert.equal((await clear).ok, true);
  assert.equal((await registration).ok, true);
  assert.deepEqual([...db.keys()], ["next-token"]);
});

test("large open-ended media ranges are delivered in bounded 4 MiB parts", async () => {
  const size = 10 * 1024 * 1024,
    requests = [];
  const worker = boot({
    fetcher: async (url, options) => {
      const range = options.headers.Range;
      requests.push(range);
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range).map(Number);
      return new Response(new Uint8Array(end - start + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${size}` },
      });
    },
  });
  await worker.register({ ...makeEntry(), size });
  const first = await worker.request("bytes=0-");
  assert.equal(first.headers.get("Content-Range"), `bytes 0-4194303/${size}`);
  assert.equal((await first.arrayBuffer()).byteLength, 4194304);
  const next = await worker.request("bytes=4194304-");
  assert.equal(
    next.headers.get("Content-Range"),
    `bytes 4194304-8388607/${size}`,
  );
  assert.equal((await next.arrayBuffer()).byteLength, 4194304);
  assert.deepEqual(requests, ["bytes=0-4194303", "bytes=4194304-8388607"]);
});
