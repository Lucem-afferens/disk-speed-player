import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, webkit, devices } from "playwright";

const root = new URL("../", import.meta.url);
const clip = await readFile(new URL("fixtures/clip.mp4", import.meta.url));
const types = {
  js: "text/javascript",
  html: "text/html",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
  webmanifest: "application/manifest+json",
};
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://local").pathname;
    const file = new URL("." + (path === "/" ? "/index.html" : path), root);
    if (!file.href.startsWith(root.href)) throw Error("Invalid path");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type":
        types[file.pathname.split(".").at(-1)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

try {
  for (const [name, engine, profile] of [
    ["chromium", chromium, devices["Pixel 7"]],
    ["webkit", webkit, devices["iPhone 13"]],
  ]) {
    const browser = await engine.launch({
      headless: true,
      ...(name === "chromium" && process.env.CHROMIUM_CHANNEL
        ? { channel: process.env.CHROMIUM_CHANNEL }
        : {}),
    });
    try {
      const context = await browser.newContext(profile),
        page = await context.newPage(),
        errors = [];
      context.on("page", (p) =>
        p.on("pageerror", (e) => errors.push(e.message)),
      );
      page.on("pageerror", (e) => errors.push(e.message));
      const waiting = new Map();
      await context.route("https://cloud-api.yandex.net/**", async (route) => {
        const url = new URL(route.request().url()),
          id = url.searchParams.get("public_key").split("/").at(-1);
        if (
          waiting.has(id) &&
          (!waiting.get(id).downloadOnly || url.pathname.endsWith("/download"))
        ) {
          const task = waiting.get(id);
          task.entered.resolve();
          await task.finish.promise;
        }
        if (id === "missing")
          return route.fulfill({ status: 404, json: { error: "not_found" } });
        if (url.pathname.endsWith("/download"))
          return route.fulfill({
            json: { href: `https://storage.yandex.net/${id}/camera` },
          });
        const item = {
          type: "file",
          name: "camera",
          path: "/camera",
          size: clip.length,
          mime_type: "video/mp4",
        };
        return route.fulfill({
          json: {
            type: "dir",
            name: `Folder ${id}`,
            _embedded: {
              items: id === "empty" ? [] : [item],
              total: id === "empty" ? 0 : 1,
            },
          },
        });
      });
      await context.route("https://storage.yandex.net/**", async (route) => {
        const value = route.request().headers().range;
        const match = /bytes=(\d+)-(\d*)/.exec(value || "");
        const start = match ? Number(match[1]) : 0,
          end = match?.[2]
            ? Math.min(Number(match[2]), clip.length - 1)
            : clip.length - 1;
        await route.fulfill({
          status: match ? 206 : 200,
          headers: {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            ...(match
              ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` }
              : {}),
          },
          body: clip.subarray(start, end + 1),
        });
      });
      const open = async (id, target = page) => {
        await target.locator("#source").fill(`https://disk.yandex.ru/d/${id}`);
        await target.locator("#open-source").click();
      };
      const ready = async (id, target = page) =>
        target.waitForFunction((id) => {
          const v = document.querySelector("#video");
          return (
            v.readyState >= 1 &&
            v.src.includes(`/${id}/`) &&
            !document.querySelector("#play").disabled
          );
        }, id);
      const empty = async (target = page) => {
        assert.equal(await target.locator("#video").getAttribute("src"), null);
        assert.equal(
          await target.locator("#video").evaluate((v) => v.paused),
          true,
        );
        assert.equal(await target.locator("#play").isDisabled(), true);
        assert.equal(await target.locator(".item-open").count(), 0);
        assert.equal(
          await target.locator("#video-name").innerText(),
          "Ваше видео будет здесь",
        );
      };
      const clear = async (forget = false) => {
        await page.locator("#clear-source").click();
        if (forget) await page.locator("#clear-saved-history").check();
        await page.locator("#clear-confirm").click();
        await page.waitForFunction(
          () =>
            !document.querySelector("#open-source").disabled &&
            document
              .querySelector("#source-status")
              .textContent.startsWith("Плеер очищен."),
        );
      };
      await page.goto(base);
      await open("A");
      await ready("A");
      await page.locator("#mark-watched").click();
      await page.locator("#play").click();
      await page.waitForFunction(
        () => !document.querySelector("#video").paused,
      );
      // Pending folder load stops media immediately, before the API returns.
      const slow = { entered: deferred(), finish: deferred() };
      waiting.set("slow", slow);
      await open("slow");
      await slow.entered.promise;
      await empty();
      await open("B");
      await ready("B");
      slow.finish.resolve();
      waiting.delete("slow");
      assert.equal(await page.locator(".item-status").innerText(), ""); // Same path/size, different source.
      await open("empty");
      await page.waitForFunction(
        () => document.querySelector("#cancel-load").hidden,
      );
      await empty();
      await open("A");
      await ready("A");
      await open("missing");
      await page.waitForFunction(() =>
        document.querySelector("#source-status").classList.contains("error"),
      );
      await empty();
      await open("A");
      await ready("A");
      await clear();
      await empty();
      assert.ok(
        await page.evaluate(() =>
          Object.values(
            JSON.parse(localStorage.getItem("disk-play:v1:history")),
          ).some((x) => x.watched),
        ),
      );
      await open("B");
      await ready("B");
      const held = { entered: deferred(), finish: deferred() };
      waiting.set("held", held);
      await open("held");
      await held.entered.promise;
      await clear();
      await empty();
      held.finish.resolve();
      waiting.delete("held");
      await open("B");
      await ready("B");
      const delayedDownload = {
        entered: deferred(),
        finish: deferred(),
        downloadOnly: true,
      };
      waiting.set("delayed-download", delayedDownload);
      await open("delayed-download");
      await delayedDownload.entered.promise;
      await clear();
      delayedDownload.finish.resolve();
      waiting.delete("delayed-download");
      await empty();
      await open("B");
      await ready("B");
      const second = await context.newPage();
      await second.goto(base);
      await open("C", second);
      await ready("C", second);
      // A real worker + real IndexedDB, also when this page did not use HEVC.
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.register(
          "./stream-worker.js?v=20261115.3",
          { scope: "./" },
        );
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
          await new Promise((r) =>
            navigator.serviceWorker.addEventListener("controllerchange", r, {
              once: true,
            }),
          );
        const mod = await import("./compatibility.js?v=20261115.3");
        const result = await mod.compatibleSource(
          "https://storage.yandex.net/test",
          16,
          null,
          {
            info: { patches: [4] },
            source: { key: "https://disk.yandex.ru/d/test", path: "/camera" },
          },
        );
        window.testToken = result.token;
      });
      await clear(true);
      await empty();
      await empty(second);
      assert.equal(await second.locator("#source").inputValue(), "");
      const stored = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("disk-play-streams", 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const count = await new Promise((resolve) => {
          const r = db.transaction("sources").objectStore("sources").count();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return {
          count,
          history: JSON.parse(localStorage.getItem("disk-play:v1:history")),
          source: JSON.parse(localStorage.getItem("disk-play:v1:source")),
        };
      });
      assert.deepEqual(stored, { count: 0, history: {}, source: "" });
      assert.equal(
        await page.evaluate(
          async () => (await fetch("./_stream/" + window.testToken)).status,
        ),
        410,
      );
      await page.reload();
      assert.equal(await page.locator("#source").inputValue(), "");
      await empty();
      for (const width of [320, 390, 844]) {
        await page.setViewportSize({
          width,
          height: width === 844 ? 390 : 844,
        });
        await page.locator("#clear-source").click();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        await page.locator("#clear-cancel").click();
      }
      assert.deepEqual(errors, []);
      console.log(
        `${name}: source replacement, empty/error folders, late responses, reset, real worker/IndexedDB, multi-tab history reset and mobile layout passed`,
      );
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
