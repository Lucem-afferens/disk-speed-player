// Real keydown/keyup and native button activation on synthetic video only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const root = new URL("../", import.meta.url);
const clip = await readFile(new URL("fixtures/clip.mp4", import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://local").pathname;
    const file = new URL("." + (pathname === "/" ? "/index.html" : pathname), root);
    if (!file.href.startsWith(root.href)) throw Error("Invalid path");
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": ({ js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml" })[file.pathname.split(".").at(-1)] || "application/octet-stream" });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
    if (process.env.ENGINE && process.env.ENGINE !== name) continue;
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const errors = [], requests = [];
      await context.route("https://cloud-api.yandex.net/**", route => {
        const url = new URL(route.request().url()); requests.push(url.pathname);
        if (url.pathname.endsWith("/download")) return route.fulfill({ json: { href: "https://storage.yandex.net/fixture/clip.mp4" } });
        // Extensionless H.264 fixture, identified by MIME, keeps this keyboard
        // test independent of Safari's HEVC worker (covered by source-reset).
        return route.fulfill({ json: { type: "dir", name: "Keyboard fixture", _embedded: { total: 2, items: [1, 2].map(n => ({ type: "file", name: `Camera ${n}`, path: `/clip${n}`, size: clip.length, mime_type: "video/mp4" })) } } });
      });
      await context.route("https://storage.yandex.net/**", route => {
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || "");
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
        return route.fulfill({ status: range ? 206 : 200, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", ...(range ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` } : {}) }, body: clip.subarray(start, end + 1) });
      });
      const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
      await page.goto(base);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
      await page.locator("#source").fill("https://disk.yandex.ru/d/keyboard-fixture");
      await page.locator("#open-source").click();
      // WebKit may retain only metadata until the first user playback gesture.
      try {
        await page.waitForFunction(() => document.querySelector("#video").readyState >= 1 && !document.querySelector("#play").disabled);
      } catch (error) {
        console.error(name, await page.evaluate(() => ({ready:document.querySelector('#video').readyState,mediaError:document.querySelector('#video').error?.code,src:document.querySelector('#video').src,status:document.querySelector('#source-status').textContent,error:document.querySelector('#video-error-text').textContent})), errors, requests);
        throw error;
      }
      await page.locator("#video").evaluate(v => { v.pause(); v.loop = true; });
      await page.locator("#autonext").uncheck();
      await page.evaluate(() => {
        window.testClicks = 0;
        document.addEventListener("click", () => window.testClicks++, true);
      });
      const state = () => page.evaluate(() => ({
        clicks: window.testClicks, src: document.querySelector("#video").currentSrc,
        name: document.querySelector("#video-name").textContent,
        rate: document.querySelector("#speed").textContent,
        muted: document.querySelector("#video").muted,
        volume: document.querySelector("#volume").value,
        autonext: document.querySelector("#autonext").checked,
        watched: document.querySelector("#mark-watched").textContent,
        expanded: document.querySelector("#player").classList.contains("expanded"),
        clearDialog: document.querySelector("#clear-dialog").open,
        speedPanel: document.querySelector("#speed-panel").hidden,
      }));
      async function pair(selector) {
        await page.locator("#video").evaluate(v => v.pause());
        await page.locator(selector).focus(); const before = await state();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => !document.querySelector("#video").paused);
        await page.keyboard.press("Space");
        await page.waitForFunction(() => document.querySelector("#video").paused);
        assert.deepEqual(await state(), before, `${name}: Space must only toggle playback after ${selector}`);
      }
      // A clicked speed button retains focus even though its menu closes.
      await page.locator("#speed").click(); await page.locator('[data-rate="4"]').click();
      await page.keyboard.press("Space"); await page.waitForFunction(() => !document.querySelector("#video").paused);
      await page.keyboard.press("Space"); await page.waitForFunction(() => document.querySelector("#video").paused);
      assert.match(await page.locator("#speed").textContent(), /4/);
      for (const selector of ["#play", "#speed", "#mute", "#volume", "#seek", "#autonext", "#mark-watched", "#next-video", "#open-source", "#clear-source", "#video"])
        await pair(selector);
      await page.locator("#speed").click(); await pair('[data-rate="2"]'); await page.locator("#speed-close").click();
      // Holding a key must not cycle play/pause or activate a button on release.
      await page.locator("#mute").focus(); const beforeHold = await state();
      await page.keyboard.down("Space"); await page.waitForFunction(() => !document.querySelector("#video").paused);
      for (let i = 0; i < 4; i++) await page.keyboard.down("Space");
      assert.equal(await page.locator("#video").evaluate(v => v.paused), false);
      await page.locator("#clear-source").focus(); await page.keyboard.up("Space");
      assert.deepEqual(await state(), beforeHold);
      await page.keyboard.press("Space"); await page.waitForFunction(() => document.querySelector("#video").paused);
      // Text spaces and Enter activation still retain their normal meanings.
      await page.locator("#source").fill("A"); await page.keyboard.press("End"); await page.keyboard.press("Space"); await page.keyboard.type("B");
      assert.equal(await page.locator("#source").inputValue(), "A B");
      assert.equal(await page.locator("#video").evaluate(v => v.paused), true);
      await page.locator("#mute").focus(); const muted = await page.locator("#video").evaluate(v => v.muted);
      await page.keyboard.press("Enter"); assert.equal(await page.locator("#video").evaluate(v => v.muted), !muted);
      // Test both the inline and expanded player with its actual controls.
      await page.locator("#expand").click(); await page.waitForFunction(() => document.querySelector("#player").classList.contains("expanded"));
      for (const selector of ["#close-expanded", "#play", "#mute", "#volume", "#seek", "#speed"]) await pair(selector);
      await page.locator("#close-expanded").click();
      await page.waitForFunction(() => !document.querySelector("#player").classList.contains("expanded"));
      assert.deepEqual(errors, []);
      console.log(`${name}: Space after buttons/sliders/checkboxes, keyup, hold, focus change, fullscreen, text editing and Enter passed`);
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
