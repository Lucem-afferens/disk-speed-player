import {
  RATES,
  parseLink,
  mediaKey,
  isVideo,
  localCatalog,
  timeLabel,
  sizeLabel,
  safeMediaURL,
  nativeRate,
  bufferedEnd,
  overviewTarget,
} from "./core.js?v=20261117.1";
import {
  VERSION,
  compatibleSource,
  inspectSource,
  releaseSource,
  clearSources,
  streamFailure,
} from "./compatibility.js?v=20261115.5";
import { inspectRemoteMP4 } from "./mp4.js?v=20261115.5";
import { autoHideControls, bindPlaybackSpace } from "./player-controls.js?v=20261115.7";
const $ = (id) => document.getElementById(id);
const video = $("video"),
  player = $("player"),
  API = "https://cloud-api.yandex.net/v1/disk/";
const PREFIX = "disk-play:v1:";
const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* Private mode or full storage: playback remains available. */
    }
  },
};
let history = store.get("history", {}),
  current = null,
  source = null,
  items = [],
  folders = [],
  folderStack = [],
  folderPath = "",
  folderName = "";
if (!history || typeof history !== "object" || Array.isArray(history))
  history = {};
let requested = RATES.includes(store.get("rate", 1)) ? store.get("rate", 1) : 1;
let supported = 1,
  actual = 1,
  overview = false,
  limited = false,
  previousMuted = false,
  savingAt = 0,
  lastAdapt = 0,
  tick = 0;
let loadingController = null,
  localUrl = null,
  mediaController = null,
  mediaGeneration = 0,
  metadataTarget = null,
  toastTimer,
  durationTimer,
  probe = null;
let dragging = false,
  playerReady = false,
  expandedBeforeFocus = null;
let pageActive = true;
let restoringSession = false,
  sessionTimer;
const SESSION_KEY = PREFIX + "session";
const resetStamp = () => store.get("reset", null)?.id || null;
let activeResetStamp = resetStamp();
function saveSession() {
  if (!source || source.local || restoringSession) return;
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        version: 1,
        source: linkFor(source, { path: source.path }),
        path: folderPath,
        stack: folderStack,
        currentPath: current?.item.path || null,
        currentKey: current?.key || null,
        position: playerReady
          ? video.currentTime
          : metadataTarget?.position || 0,
        filter: $("filter").value,
        unwatchedOnly: $("unwatched-only").checked,
        scrollY: window.scrollY,
        listScroll: $("playlist").scrollTop,
        resetStamp: activeResetStamp,
      }),
    );
  } catch {
    /* A storage restriction must not interrupt playback. */
  }
}
function readSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (!saved || saved.version !== 1 || saved.resetStamp !== resetStamp())
      return null;
    const origin = parseLink(saved.source);
    if (
      typeof saved.path !== "string" ||
      !Array.isArray(saved.stack) ||
      !saved.stack.every((path) => typeof path === "string")
    )
      return null;
    return { ...saved, origin };
  } catch {
    return null;
  }
}
const appleMobile =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const appleBrowser =
  appleMobile ||
  (/Safari/.test(navigator.userAgent) &&
    !/Chrome|Chromium|Android/.test(navigator.userAgent));
const standalone = () =>
  navigator.standalone === true ||
  matchMedia("(display-mode: standalone)").matches;
let nativeFullscreen = false;
const playerChrome = autoHideControls({
  player,
  isExpanded: () =>
    player.classList.contains("expanded") ||
    document.fullscreenElement === player,
  isBlocked: () =>
    !playerReady ||
    dragging ||
    !$("speed-panel").hidden ||
    !$("video-error").hidden ||
    document.querySelector("dialog[open]"),
});
const recordDiagnostic = (event, data) =>
  window.diskPlayDiagnostics?.record(event, data);
const collator = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});
const svg = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
$("back").innerHTML = `${svg("back")}<span>10</span>`;
$("forward").innerHTML = `${svg("forward")}<span>10</span>`;
const entryKey = (item) => mediaKey(source, item);
const record = (key) =>
  history[key] && typeof history[key] === "object" ? history[key] : {};
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3500);
}
function notice(message = "", error = false) {
  $("source-status").hidden = !message;
  $("source-status").textContent = message;
  $("source-status").classList.toggle("error", error);
}
function persist() {
  const entries = Object.entries(history).sort(
    (a, b) => (b[1].updated || 0) - (a[1].updated || 0),
  );
  history = Object.fromEntries(entries.slice(0, 1000));
  store.set("history", history);
}
function updateRecord(key, change) {
  history[key] = { ...record(key), ...change, updated: Date.now() };
  persist();
}
function savePosition(force = false) {
  if (!current || !playerReady || (!force && Date.now() - savingAt < 2000))
    return;
  savingAt = Date.now();
  updateRecord(current.key, {
    position: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : undefined,
  });
  saveSession();
}
async function api(endpoint, params, signal) {
  const timeout = new AbortController();
  const relay = () => timeout.abort();
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  signal?.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => timeout.abort(), 25000);
  try {
    const response = await fetch(
      API + endpoint + "?" + new URLSearchParams(params),
      {
        signal: timeout.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      const messages = {
        400: "Не удалось прочитать ссылку. Скопируйте её заново из «Поделиться».",
        401: "Ссылка требует входа. Используйте публичную ссылку.",
        403: "Доступ запрещён. Проверьте, что владелец разрешил скачивание и не установил пароль.",
        404: "Видео или папка не найдены. Возможно, ссылка больше не действует.",
        429: "Диск ограничил частоту запросов. Подождите немного и повторите.",
      };
      throw new Error(
        messages[response.status] ||
          "Яндекс Диск временно недоступен. Попробуйте ещё раз.",
      );
    }
    const body = await response.json();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    return body;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (error.name === "AbortError")
      throw new Error(
        "Диск отвечает слишком долго. Проверьте интернет и повторите.",
      );
    if (error instanceof TypeError)
      throw new Error(
        "Не удалось связаться с Диском. Проверьте интернет или блокировку запросов браузером.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}
async function resource(origin, path, signal) {
  const params = {
    public_key: origin.key,
    limit: "100",
    offset: "0",
    sort: "name",
  };
  if (path) params.path = path;
  const data = await api("public/resources", params, signal);
  if (data.type !== "dir") return data;
  let list = [...(data._embedded?.items || [])];
  const total = data._embedded?.total ?? list.length;
  while (list.length < total) {
    params.offset = String(list.length);
    const page = await api("public/resources", params, signal);
    const next = page._embedded?.items || [];
    if (!next.length)
      throw new Error("Диск вернул неполный список. Откройте папку ещё раз.");
    list.push(...next);
    notice(`Загружаем список: ${Math.min(list.length, total)} из ${total}…`);
    if (list.length > 20000)
      throw new Error(
        "В папке слишком много файлов. Вставьте ссылку на одну из вложенных папок.",
      );
  }
  return { ...data, _embedded: { ...data._embedded, items: list } };
}
function linkFor(origin, item) {
  if (origin?.local) return "";
  const url =
    origin.key +
    (item.path && item.path !== "/"
      ? "/" +
        item.path
          .replace(/^\//, "")
          .split("/")
          .map(encodeURIComponent)
          .join("/")
      : "");
  return url;
}
function releaseLocalUrl() {
  if (!localUrl) return;
  URL.revokeObjectURL(localUrl);
  localUrl = null;
}
function localMediaURL(item) {
  if (!item.file)
    throw new Error("Выберите видео ещё раз: браузер больше не держит этот файл.");
  releaseLocalUrl();
  localUrl = URL.createObjectURL(item.file);
  return localUrl;
}
async function loadLocal(files) {
  const catalog = localCatalog(
    [...files].map((file, index) => ({
      index,
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
    })),
  );
  if (!catalog) {
    notice(
      "В выбранном нет видео. Выберите папку с роликами или отдельные видеофайлы.",
      true,
    );
    return;
  }
  const byIndex = [...files];
  resetSession();
  source = { local: true, key: catalog.identity, identity: catalog.identity, path: "" };
  items = catalog.items.map((item) => ({ ...item, file: byIndex[item.index] }));
  folders = [];
  folderName = catalog.title;
  document.body.classList.add("has-source");
  $("folder-name").textContent = folderName;
  $("folder-nav").hidden = true;
  $("video-count").textContent = String(items.length);
  $("list-tools").hidden = !items.length;
  notice(
    catalog.truncated
      ? `Показаны первые ${items.length} видео. Остальные выберите отдельной папкой.`
      : "Файлы остаются на устройстве и никуда не отправляются. После обновления страницы выберите их снова.",
  );
  renderList();
  if (items[0]) await openVideo(items[0], false);
}
async function hrefFor(origin, item, signal) {
  if (item.file) return localMediaURL(item);
  const params = { public_key: origin.key };
  if (item.path && item.path !== "/") params.path = item.path;
  return safeMediaURL(
    (await api("public/resources/download", params, signal)).href,
  );
}
async function loadSource(
  origin,
  path = origin.path,
  stack = [],
  restored = null,
) {
  if (clearing) return;
  resetSession();
  restoringSession = Boolean(restored);
  store.set("source", "");
  const controller = new AbortController();
  loadingController = controller;
  $("cancel-load").hidden = false;
  $("empty").hidden = true;
  showLoading(
    true,
    restored
      ? "Восстанавливаем открытое видео…"
      : "Загружаем папку и первое видео…",
  );
  notice("Получаем список с Яндекс Диска…");
  try {
    const data = await resource(origin, path, controller.signal);
    if (controller.signal.aborted || loadingController !== controller) return;
    const entries = data.type === "dir" ? data._embedded.items : [data];
    const videos = entries
      .filter(isVideo)
      .sort((a, b) => collator.compare(a.name, b.name));
    const dirs = entries
      .filter((x) => x.type === "dir")
      .sort((a, b) => collator.compare(a.name, b.name));
    if (data.type !== "dir" && !videos.length)
      throw new Error(
        "По этой ссылке находится не видео. Выберите видеофайл или папку.",
      );
    source = origin;
    items = videos;
    folders = dirs;
    folderPath = path;
    folderName = data.name;
    folderStack = stack;
    // The list is ready. Remove its cancel control before restoring scroll;
    // otherwise its later disappearance changes the mobile form's height.
    $("cancel-load").hidden = true;
    document.body.classList.add("has-source");
    store.set("source", linkFor(origin, { path: origin.path }));
    $("filter").value =
      typeof restored?.filter === "string" ? restored.filter : "";
    $("unwatched-only").checked = restored?.unwatchedOnly === true;
    $("folder-name").textContent = folderName;
    $("folder-nav").hidden = data.type !== "dir";
    $("folder-back").disabled = !stack.length;
    $("video-count").textContent = items.length;
    $("list-tools").hidden = !items.length;
    notice(
      !items.length && !folders.length
        ? "В этой папке нет видео. Откройте другую папку."
        : "",
    );
    renderList();
    const first =
      items.find((item) => item.path === restored?.currentPath) || items[0];
    const opening = first
      ? openVideo(
          first,
          false,
          restored?.currentKey === entryKey(first) ? restored.position : null,
        )
      : null;
    if (!first) {
      showLoading(false);
      $("empty").hidden = false;
    }
    if (restored) {
      // Restore the viewport as soon as the list is laid out, without waiting
      // for the media network request or pulling the reader back to the player.
      const generation = mediaGeneration;
      requestAnimationFrame(() => {
        if (generation !== mediaGeneration) return;
        $("playlist").scrollTop = Number(restored.listScroll) || 0;
        window.scrollTo(0, Number(restored.scrollY) || 0);
        restoringSession = false;
        saveSession();
      });
    } else saveSession();
    await opening;
  } catch (error) {
    if (!controller.signal.aborted && loadingController === controller)
      notice(error.message, true);
  } finally {
    if (loadingController === controller) {
      loadingController = null;
      $("open-source").disabled = false;
      $("open-source").innerHTML = `Открыть ${svg("arrow")}`;
      $("cancel-load").hidden = true;
      if (!current) {
        showLoading(false);
        $("empty").hidden = false;
      }
    }
  }
}
$("source-form").addEventListener("submit", (event) => {
  event.preventDefault();
  recordDiagnostic("open-source");
  try {
    const origin = parseLink($("source").value);
    loadSource(origin);
  } catch (error) {
    recordDiagnostic("invalid-source");
    notice(error.message, true);
    $("source").focus();
  }
});
$("cancel-load").onclick = () => {
  resetSession();
  notice("Загрузка списка отменена.");
};
function chooseLocal(input) {
  input.value = "";
  input.click();
}
$("pick-local-folder").onclick = () => chooseLocal($("local-folder"));
$("pick-local-files").onclick = () => chooseLocal($("local-files"));
for (const input of [$("local-folder"), $("local-files")]) {
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) loadLocal(files);
  });
}
$("folder-back").onclick = () => {
  if (!folderStack.length) return;
  const next = folderStack.slice(0, -1);
  loadSource(source, folderStack.at(-1), next);
};
function renderList() {
  const list = $("playlist"),
    scroll = list.scrollTop;
  const query = $("filter").value.toLocaleLowerCase().trim(),
    onlyNew = $("unwatched-only").checked;
  const previous = new Map(
    [...list.children].map((row) => [row.dataset.key, row]),
  );
  const rows = [];
  for (const folder of folders) {
    if (query && !folder.name.toLocaleLowerCase().includes(query)) continue;
    const key = `folder:${source.identity}:${folder.path}`;
    let row = previous.get(key);
    if (!row) {
      row = document.createElement("div");
      row.className = "playlist-item folder-row";
      row.dataset.key = key;
      row.innerHTML = `<button class="item-open"><span class="item-number">${svg("folder")}</span><span class="item-details"><span class="item-name"></span><span class="item-meta">Открыть папку →</span></span></button>`;
    }
    row.querySelector(".item-name").textContent = folder.name;
    row.querySelector(".item-open").onclick = () =>
      loadSource(source, folder.path, [...folderStack, folderPath]);
    rows.push(row);
  }
  items.forEach((item, index) => {
    const key = entryKey(item),
      saved = record(key),
      selected = current?.key === key;
    if (
      (query && !item.name.toLocaleLowerCase().includes(query)) ||
      (onlyNew && saved.watched)
    )
      return;
    let row = previous.get(key);
    if (!row) {
      row = document.createElement("div");
      row.dataset.key = key;
      row.innerHTML = `<button class="item-open"><span class="item-number"></span><span class="item-details"><span class="item-name"></span><span class="item-meta"><span class="item-duration"></span><span class="item-size"></span><span class="item-status"></span></span></span></button><button class="item-mark">${svg("check")}</button><span class="item-progress" hidden></span>`;
    }
    row.className =
      "playlist-item" +
      (selected ? " current" : "") +
      (saved.watched ? " watched" : "");
    const open = row.querySelector(".item-open"),
      number = row.querySelector(".item-number");
    open.setAttribute("aria-current", String(selected));
    const numberKey = selected ? "playing" : String(index + 1);
    if (number.dataset.value !== numberKey) {
      number.innerHTML = selected ? svg("play") : String(index + 1);
      number.dataset.value = numberKey;
    }
    row.querySelector(".item-name").textContent = item.name;
    row.querySelector(".item-size").textContent =
      `· ${sizeLabel(item.size || 0)}`;
    row.querySelector(".item-duration").textContent = timeLabel(saved.duration);
    row.querySelector(".item-duration").title = saved.duration
      ? "Длительность видео"
      : "Длительность появится после чтения видео";
    row.querySelector(".item-status").textContent = saved.watched
      ? "✓ Просмотрено"
      : saved.started
        ? "◐ Начат просмотр"
        : "";
    open.onclick = () => {
      if (current?.key === key && playerReady && $("video-error").hidden)
        togglePlay();
      else openVideo(item, true);
    };
    const mark = row.querySelector(".item-mark");
    mark.setAttribute("aria-pressed", String(!!saved.watched));
    mark.setAttribute(
      "aria-label",
      (saved.watched
        ? "Снять отметку просмотра: "
        : "Отметить просмотренным: ") + item.name,
    );
    mark.onclick = () => toggleWatched(key);
    const bar = row.querySelector(".item-progress");
    bar.hidden = !(saved.duration && saved.position);
    if (!bar.hidden)
      bar.style.width =
        Math.min(100, (saved.position / saved.duration) * 100) + "%";
    rows.push(row);
  });
  if (!rows.length) {
    const empty = previous.get("empty") || document.createElement("div");
    empty.className = "list-empty";
    empty.dataset.key = "empty";
    empty.textContent =
      items.length || folders.length
        ? "Нет подходящих видео. Измените фильтр."
        : source
          ? "В этой папке нет видео."
          : "Вставьте ссылку, чтобы открыть видео или папку.";
    rows.push(empty);
  }
  // Keep existing rows attached during metadata/progress updates: replacing the
  // subtree interrupts focus and an ongoing touch scroll in mobile browsers.
  rows.forEach((row, index) => {
    if (list.children[index] !== row)
      list.insertBefore(row, list.children[index] || null);
  });
  while (list.children.length > rows.length) list.lastElementChild.remove();
  list.scrollTop = scroll;
  const watched = items.filter((item) => record(entryKey(item)).watched).length;
  $("list-summary").textContent = items.length
    ? `Просмотрено ${watched} из ${items.length} · Отметки на этом устройстве`
    : "Отметки и позиции сохраняются на этом устройстве.";
  updateCurrentActions();
}

function toggleWatched(key) {
  const next = !record(key).watched;
  updateRecord(key, { watched: next });
  renderList();
  toast(next ? "Отмечено как просмотренное" : "Отметка просмотра снята");
}
function currentIndex() {
  return current && source?.identity === current.origin.identity
    ? items.findIndex((x) => entryKey(x) === current.key)
    : -1;
}
function updateCurrentActions() {
  $("mark-watched").disabled = !current;
  $("mark-watched").querySelector("span").textContent =
    current && record(current.key).watched
      ? "Просмотрено · снять отметку"
      : "Отметить просмотренным";
  const index = currentIndex();
  $("next-video").disabled = index < 0 || index >= items.length - 1;
}
$("filter").oninput = $("unwatched-only").onchange = () => {
  renderList();
  saveSession();
};
$("mark-watched").onclick = () => current && toggleWatched(current.key);
$("next-video").onclick = () => {
  const index = currentIndex();
  if (index >= 0 && items[index + 1]) openVideo(items[index + 1], true);
};
$("autonext").checked = store.get("autonext", true);
$("autonext").onchange = () => store.set("autonext", $("autonext").checked);
$("source").value = store.get("source", "");
function controlsEnabled(enabled) {
  for (const id of ["play", "back", "forward", "seek", "mute", "volume"])
    $(id).disabled = !enabled;
}
function showLoading(visible, text = "Открываем видео…") {
  $("loading-video").hidden = !visible;
  $("loading-text").textContent = text;
}
// Invalidate asynchronous work BEFORE touching the media element. Even an empty
// folder, an API error or a late Safari recovery must leave the old source gone.
function resetSession() {
  savePosition(true);
  clearTimeout(sessionTimer);
  restoringSession = false;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  loadingController?.abort();
  loadingController = null;
  mediaController?.abort();
  mediaController = null;
  mediaGeneration++;
  clearTimeout(durationTimer);
  const token = current?.compatToken;
  current = null;
  metadataTarget = null;
  playerReady = false;
  dragging = false;
  tick = 0;
  stopProbe();
  clearTimeout(probeTimer);
  probed.clear();
  video.pause();
  video.removeAttribute("src");
  video.load();
  releaseLocalUrl();
  releaseSource(token);
  if (overview) video.muted = previousMuted;
  overview = limited = false;
  source = null;
  items = [];
  folders = [];
  folderStack = [];
  folderPath = folderName = "";
  document.body.classList.remove("has-source");
  $("video-name").textContent = "Ваше видео будет здесь";
  $("video-name").title = "";
  $("video-index").textContent = "ГОТОВ К ПРОСМОТРУ";
  $("folder-name").textContent = "";
  $("folder-nav").hidden = true;
  $("folder-back").disabled = true;
  $("video-count").textContent = "0";
  $("list-tools").hidden = true;
  $("filter").value = "";
  $("unwatched-only").checked = false;
  $("empty").hidden = false;
  $("center-play").hidden = true;
  $("video-error").hidden = true;
  $("error-diagnostics").textContent = "";
  $("error-details").open = false;
  $("disk-link").removeAttribute("href");
  $("elapsed").textContent = $("duration").textContent = "0:00";
  $("seek").value = 0;
  $("seek").style.setProperty("--progress", "0%");
  $("seek").setAttribute("aria-valuetext", "0:00 из 0:00");
  $("play").innerHTML = svg("play");
  $("play").setAttribute("aria-label", "Воспроизвести");
  $("cancel-load").hidden = true;
  controlsEnabled(false);
  showLoading(false);
  speedPanel(false);
  speedNote();
  renderList();
}
function showVideoError(message, detail = {}) {
  recordDiagnostic("video-error", {
    stage: current?.stage || "open",
    mediaCode: video.error?.code || 0,
  });
  playerChrome.show();
  clearTimeout(durationTimer);
  const diagnostic = {
    version: VERSION,
    stage: current?.stage || "open",
    mediaCode: video.error?.code || 0,
    compatibleStream: Boolean(current?.compatToken),
    online: navigator.onLine,
    hevc: video.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"') || "no",
    ...detail,
    browser: navigator.userAgent,
  };
  $("error-diagnostics").textContent = JSON.stringify(diagnostic, null, 2);
  $("error-details").open = false;
  showLoading(false);
  $("center-play").hidden = true;
  $("video-error-text").textContent = message;
  $("video-error").hidden = false;
  controlsEnabled(false);
}
function attachMedia(href, generation) {
  if (generation !== mediaGeneration) return;
  playerReady = false;
  current.stage = "load-video";
  video.src = href;
  video.load();
  clearTimeout(durationTimer);
  durationTimer = setTimeout(() => {
    if (generation === mediaGeneration && !playerReady)
      showVideoError(
        "Видео отвечает слишком долго. Проверьте соединение и повторите попытку.",
        { reason: "metadata-timeout" },
      );
  }, 35000);
}
async function prepareCompatible(href, generation) {
  const item = current.item,
    origin = current.origin;
  const controller = new AbortController(),
    parent = mediaController.signal;
  const relay = () => controller.abort();
  parent.addEventListener("abort", relay, { once: true });
  if (parent.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    current.stage = "inspect-mp4";
    const identity =
      current.key + ":" + (item.md5 || item.modified || "") + ":" + item.size;
    const info = await inspectSource(
      href,
      item.size,
      controller.signal,
      identity,
    );
    if (generation !== mediaGeneration) return null;
    if (!info.patches.length) return null;
    current.stage = "prepare-stream";
    showLoading(true, "Подготавливаем видео для Safari…");
    const result = await compatibleSource(href, item.size, controller.signal, {
      info,
      source: { key: origin.key, path: item.path },
    });
    if (generation !== mediaGeneration || controller.signal.aborted) {
      releaseSource(result?.token);
      if (controller.signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      return null;
    }
    current.compatToken = result.token;
    return result.url;
  } catch (error) {
    if (parent.aborted) throw error;
    if (error.name === "AbortError")
      throw new Error(
        "Подготовка видео заняла слишком много времени. Проверьте соединение и повторите попытку.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", relay);
  }
}
async function openVideo(
  item,
  autoplay = false,
  resumeOverride = null,
  recovery = false,
) {
  stopProbe();
  savePosition(true);
  mediaController?.abort();
  releaseSource(current?.compatToken);
  const generation = ++mediaGeneration;
  const controller = new AbortController();
  mediaController = controller;
  playerReady = false;
  video.pause();
  video.removeAttribute("src");
  video.load();
  const index = items.indexOf(item);
  current = {
    item,
    recovery,
    stage: "download-link",
    origin: { ...source },
    key: entryKey(item),
    index: index >= 0 ? index + 1 : current?.index || 1,
    total: index >= 0 ? items.length : current?.total || 1,
  };
  if (
    autoplay &&
    window.innerWidth < 850 &&
    !player.classList.contains("expanded")
  )
    player.scrollIntoView({ block: "start", behavior: "smooth" });
  metadataTarget = {
    position: resumeOverride ?? record(current.key).position ?? 0,
    autoplay,
    exactPosition: resumeOverride !== null,
  };
  $("video-name").textContent = item.name;
  $("video-name").title = item.name;
  $("video-index").textContent = `ВИДЕО ${current.index} ИЗ ${current.total}`;
  $("empty").hidden = true;
  $("center-play").hidden = true;
  $("video-error").hidden = true;
  if (item.file) {
    $("disk-link").hidden = true;
    $("disk-link").removeAttribute("href");
  } else {
    $("disk-link").hidden = false;
    $("disk-link").href = linkFor(current.origin, item);
  }
  $("elapsed").textContent = "0:00";
  $("duration").textContent = timeLabel(record(current.key).duration);
  $("seek").value = 0;
  $("seek").style.setProperty("--progress", "0%");
  controlsEnabled(false);
  showLoading(true);
  renderList();
  saveSession();
  try {
    const href = await hrefFor(current.origin, item, controller.signal);
    if (generation !== mediaGeneration) return;
    current.originalHref = href;
    let mediaHref = href;
    // Prepare known camera containers before Safari's media loader rejects hev1.
    if (
      !item.file &&
      appleBrowser &&
      /\.(mp4|mov|m4v)$/i.test(item.name) &&
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"')
    ) {
      current.compatTried = true;
      showLoading(true, "Проверяем совместимость видео…");
      mediaHref = (await prepareCompatible(href, generation)) || href;
    }
    attachMedia(mediaHref, generation);
  } catch (error) {
    if (error.name !== "AbortError" && generation === mediaGeneration)
      showVideoError(
        error instanceof TypeError
          ? "Не удалось прочитать видео с Диска. Проверьте соединение и повторите попытку."
          : error.message,
        { reason: error.name, httpStatus: error.status || null },
      );
  }
}
async function play() {
  if (!current || !playerReady) return;
  const generation = mediaGeneration;
  try {
    await video.play();
  } catch (error) {
    if (generation !== mediaGeneration) return;
    if (error.name !== "AbortError" && error.name !== "NotSupportedError") {
      $("center-play").hidden = false;
      showLoading(false);
      toast("Нажмите ▶ в плеере, чтобы начать просмотр.");
    }
  }
}
function togglePlay() {
  if (!playerReady) return;
  if (video.paused) play();
  else video.pause();
}
$("play").onclick = togglePlay;
$("center-play").onclick = play;
$("screen").onclick = (event) => {
  if (event.target === video) togglePlay();
};
$("retry-video").onclick = () => {
  if (!current) return;
  const item = current.item,
    origin = current.origin,
    key = current.key;
  // Retrying uses the original source even if the playlist was changed meanwhile.
  if (source?.identity !== origin.identity) {
    if (origin.local) {
      notice("Выберите папку или видео на устройстве ещё раз.", true);
      return;
    }
    $("source").value = origin.key;
    loadSource(origin, item.path);
    return;
  }
  openVideo(item, true, record(key).position || 0);
};
video.addEventListener("loadedmetadata", () => {
  if (
    !current ||
    !video.getAttribute("src") ||
    !Number.isFinite(video.duration) ||
    video.duration <= 0
  )
    return;
  clearTimeout(durationTimer);
  playerReady = true;
  playerChrome.refresh();
  current.stage = "ready";
  $("video-error").hidden = true;
  controlsEnabled(true);
  updateRecord(current.key, { duration: video.duration });
  $("duration").textContent = timeLabel(video.duration);
  const target = metadataTarget;
  metadataTarget = null;
  if (
    target?.position > 0 &&
    target.position < video.duration - (target.exactPosition ? 0 : 2)
  )
    video.currentTime = target.position;
  else {
    // iOS can stop at HAVE_METADATA with a black video surface. A tiny seek
    // requests a decoded first frame without autoplay or a hidden video decoder.
    video.currentTime = Math.min(0.001, video.duration / 2);
  }
  applySpeed();
  renderList();
  showLoading(video.readyState < 2, "Загружаем первый кадр…");
  $("center-play").hidden = video.readyState < 2;
  if (target?.autoplay) play();
  scheduleProbe();
});
video.addEventListener("loadeddata", () => {
  if (!current || !playerReady) return;
  showLoading(false);
  $("center-play").hidden = !video.paused || !$("video-error").hidden;
});
video.addEventListener("play", () => {
  if (current) current.wasPlaying = true;
  stopProbe();
  $("play").innerHTML = svg("pause");
  $("play").setAttribute("aria-label", "Пауза");
  $("center-play").hidden = true;
  if (current && !record(current.key).started) {
    updateRecord(current.key, { started: true });
    renderList();
  }
  tick = 0;
});
video.addEventListener("playing", () => {
  showLoading(false);
  $("center-play").hidden = true;
  tick = 0;
});
video.addEventListener("pause", () => {
  if (current && !video.error) current.wasPlaying = false;
  $("play").innerHTML = svg("play");
  $("play").setAttribute("aria-label", "Воспроизвести");
  $("center-play").hidden = !playerReady || !$("video-error").hidden;
  if (playerReady) showLoading(false);
  savePosition(true);
  tick = 0;
  scheduleProbe();
});
video.addEventListener("ended", () => {
  if (!current || !playerReady) return;
  if (current) updateRecord(current.key, { watched: true, position: 0 });
  renderList();
  const index = currentIndex();
  if ($("autonext").checked && index >= 0 && items[index + 1])
    openVideo(items[index + 1], true);
});
video.addEventListener("timeupdate", () => {
  if (!dragging) {
    $("elapsed").textContent = timeLabel(video.currentTime);
    const progress = Number.isFinite(video.duration)
      ? video.currentTime / video.duration
      : 0;
    $("seek").value = Math.round(progress * 1000);
    $("seek").style.setProperty("--progress", progress * 100 + "%");
    $("seek").setAttribute(
      "aria-valuetext",
      `${timeLabel(video.currentTime)} из ${timeLabel(video.duration)}`,
    );
  }
  savePosition();
});
video.addEventListener("waiting", () => {
  tick = 0;
  if (!video.paused && playerReady) {
    showLoading(true, "Буферизация…");
    adaptSpeed(true);
  }
});
video.addEventListener("seeking", () => {
  tick = 0;
});
video.addEventListener("seeked", () => {
  tick = !video.paused && video.readyState >= 3 ? performance.now() : 0;
  if (video.readyState >= 3 || video.paused) showLoading(false);
});
video.addEventListener("error", async () => {
  if (!video.getAttribute("src") || !current || current.handlingError) return;
  current.handlingError = true;
  clearTimeout(durationTimer);
  const generation = mediaGeneration,
    code = video.error?.code || 0;
  const position =
    metadataTarget?.position ??
    video.currentTime ??
    record(current.key).position ??
    0;
  const autoplay = metadataTarget?.autoplay ?? current.wasPlaying ?? false;
  try {
    if (
      !current.item?.file &&
      [3, 4].includes(code) &&
      !current.compatTried &&
      current.originalHref &&
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"')
    ) {
      current.compatTried = true;
      showLoading(true, "Проверяем совместимость видео…");
      const url = await prepareCompatible(current.originalHref, generation);
      if (generation !== mediaGeneration) return;
      if (url) {
        metadataTarget = { position, autoplay, exactPosition: true };
        current.handlingError = false;
        attachMedia(url, generation);
        return;
      }
    }
    const failure = current.compatToken
      ? await streamFailure(current.compatToken, video.src)
      : null;
    if (generation !== mediaGeneration) return;
    // One fresh URL / stream recovers interrupted or expired sessions, without a loop.
    if (
      !current.item?.file &&
      !current.recovery &&
      (code === 2 || current.compatToken) &&
      source?.identity === current.origin.identity
    ) {
      showLoading(true, "Восстанавливаем соединение с видео…");
      recordDiagnostic("stream-recovery", { mediaCode: code });
      await openVideo(current.item, autoplay, position, true);
      return;
    }
    const detail = {
      mediaCode: code,
      transport: failure?.code || null,
      httpStatus: failure?.status || null,
    };
    if (current.item?.file) {
      showVideoError(
        code === 2
          ? "Не удалось прочитать видео на устройстве. Выберите его ещё раз."
          : "Браузер не смог открыть этот файл. Для телефона лучше подходит MP4 с H.264.",
        detail,
      );
    } else if (failure || code === 2) {
      showVideoError(
        failure?.status === 429
          ? "Яндекс Диск ограничил запросы. Подождите немного и повторите попытку."
          : "Не удалось получить поток с Диска. Повторите попытку: ссылка обновится, позиция просмотра сохранится.",
        detail,
      );
    } else if (code === 3) {
      showVideoError(
        "Браузер получил видео, но не смог его декодировать. Попробуйте повторить; если ошибка сохраняется, для этого устройства понадобится MP4 с H.264.",
        detail,
      );
    } else {
      showVideoError(
        "Браузер не смог открыть видео. Причиной может быть доступ к потоку или неподдерживаемый кодек. Повторите попытку или проверьте видео на Диске.",
        detail,
      );
    }
  } catch (error) {
    if (generation === mediaGeneration && !mediaController.signal.aborted)
      showVideoError(
        "Не удалось подготовить совместимый поток. " +
          (error instanceof TypeError
            ? "Проверьте соединение с Диском и повторите попытку."
            : error.message),
        { reason: error.name, httpStatus: error.status || null },
      );
  } finally {
    if (generation === mediaGeneration) current.handlingError = false;
  }
});
function seekTo(seconds) {
  if (playerReady) {
    video.currentTime = Math.max(0, Math.min(video.duration, seconds));
    tick = 0;
  }
}
$("back").onclick = () => seekTo(video.currentTime - 10);
$("forward").onclick = () => seekTo(video.currentTime + 10);
$("seek").oninput = () => {
  dragging = true;
  const p = Number($("seek").value) / 1000;
  $("elapsed").textContent = timeLabel(p * video.duration);
  $("seek").style.setProperty("--progress", p * 100 + "%");
};
$("seek").onchange = () => {
  seekTo((Number($("seek").value) / 1000) * video.duration);
  dragging = false;
  playerChrome.show();
};
function updateVolume() {
  $("mute").innerHTML = svg(
    video.muted || video.volume === 0 ? "mute" : "volume",
  );
  $("mute").setAttribute(
    "aria-label",
    video.muted ? "Включить звук" : "Выключить звук",
  );
  $("mute").setAttribute("aria-pressed", String(video.muted));
  $("volume").value = video.muted ? 0 : video.volume;
  $("volume").style.setProperty(
    "--progress",
    (video.muted ? 0 : video.volume * 100) + "%",
  );
}
$("mute").onclick = () => {
  if (overview) {
    toast("В режиме обзора звук выключен. Выберите меньшую скорость.");
    return;
  }
  video.muted = !video.muted;
};
$("volume").oninput = () => {
  if (overview) {
    toast("В режиме обзора звук выключен.");
    updateVolume();
    return;
  }
  video.volume = Number($("volume").value);
  video.muted = video.volume === 0;
  updateVolume();
};
video.addEventListener("volumechange", updateVolume);
updateVolume();
function applySpeed() {
  const oldOverview = overview;
  supported = nativeRate(video, requested);
  actual = supported;
  limited = false;
  overview = supported < requested;
  if (overview && !oldOverview) {
    previousMuted = video.muted;
    video.muted = true;
  }
  if (!overview && oldOverview) video.muted = previousMuted;
  video.preservesPitch = true;
  tick = 0;
  $("speed").innerHTML = `${requested}× <span>⌄</span>`;
  $("speed").setAttribute("aria-label", `Скорость: ${requested}×. Изменить`);
  document
    .querySelectorAll("[data-rate]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.rate) === requested),
      ),
    );
  speedNote();
}
function speedNote() {
  const note = $("playback-note");
  if (limited)
    note.textContent = `Сеть не успевает · сейчас ${actual}× · выбрано ${requested}×`;
  else if (overview)
    note.textContent = `${requested}× · обзор с пропуском фрагментов · без звука`;
  else
    note.textContent =
      requested > 4
        ? `${requested}× · звук зависит от браузера · скорость зависит от сети`
        : "Скорость можно менять прямо здесь, рядом со звуком.";
  note.classList.toggle("warning", overview || limited);
  $("speed-explanation").textContent =
    requested >= 8
      ? "Если браузер не поддерживает скорость, включается обзор с пропуском фрагментов. При слабой сети скорость снижается автоматически."
      : "На высоких скоростях звук может отключаться браузером.";
}
function setSpeed(rate) {
  requested = rate;
  store.set("rate", rate);
  applySpeed();
}
function speedPanel(open) {
  $("speed-panel").hidden = !open;
  $("speed").setAttribute("aria-expanded", String(open));
  if (open) $("speed-options").querySelector("[aria-pressed=true]")?.focus();
  playerChrome.show();
}
for (const rate of RATES) {
  const button = document.createElement("button");
  button.textContent = rate + "×";
  button.dataset.rate = rate;
  button.setAttribute("aria-pressed", "false");
  button.onclick = () => {
    setSpeed(rate);
    speedPanel(false);
    $("speed").focus();
  };
  $("speed-options").append(button);
}
$("speed").onclick = () => speedPanel($("speed-panel").hidden);
$("speed-close").onclick = () => {
  speedPanel(false);
  $("speed").focus();
};
document.addEventListener("pointerdown", (event) => {
  if (
    !$("speed-panel").contains(event.target) &&
    !$("speed").contains(event.target)
  )
    speedPanel(false);
});
function adaptSpeed(waiting = false) {
  if (!playerReady || video.paused || video.seeking || requested < 8) return;
  const end = bufferedEnd(video),
    ahead = end - video.currentTime;
  let next = actual;
  if (end >= video.duration - 0.1) next = supported;
  else if (waiting || ahead < Math.max(1, actual * 0.7))
    next =
      [1, 2, 4, 8, 16, 32]
        .filter((n) => n <= supported && n <= Math.max(1, ahead / 2))
        .at(-1) || 1;
  else if (limited && performance.now() - lastAdapt > 2500)
    next =
      [1, 2, 4, 8, 16, 32]
        .filter((n) => n <= supported && ahead >= n * 3)
        .at(-1) || actual;
  if (next !== actual) {
    actual = nativeRate(video, next);
    limited = actual < supported;
    lastAdapt = performance.now();
    tick = 0;
    speedNote();
  }
}
setInterval(() => {
  adaptSpeed();
  if (
    !pageActive ||
    !overview ||
    limited ||
    video.paused ||
    video.ended ||
    video.seeking ||
    video.readyState < 3 ||
    !playerReady
  ) {
    tick = 0;
    return;
  }
  const now = performance.now();
  if (!tick) {
    tick = now;
    return;
  }
  const target = overviewTarget({
    position: video.currentTime,
    elapsed: (now - tick) / 1000,
    requested,
    actual,
    bufferEnd: bufferedEnd(video),
    duration: video.duration,
  });
  tick = now;
  if (target !== null) video.currentTime = target;
}, 250);
applySpeed();
function fitViewport() {
  const viewport = window.visualViewport;
  player.style.setProperty(
    "--viewport-height",
    `${viewport?.height || innerHeight}px`,
  );
  player.style.setProperty(
    "--viewport-width",
    `${viewport?.width || innerWidth}px`,
  );
  player.style.setProperty("--viewport-top", `${viewport?.offsetTop || 0}px`);
  player.style.setProperty("--viewport-left", `${viewport?.offsetLeft || 0}px`);
}
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
window.addEventListener("resize", fitViewport);
window.addEventListener("orientationchange", () => {
  fitViewport();
  setTimeout(fitViewport, 250);
});
fitViewport();
async function expand() {
  if (
    nativeFullscreen ||
    player.classList.contains("expanded") ||
    document.fullscreenElement === player
  ) {
    await collapse();
    return;
  }
  expandedBeforeFocus = document.activeElement;
  // iPhone Safari's native player is the available fullscreen API in a browser tab.
  // Home Screen mode keeps our speed controls and has no Safari address bar.
  if (
    appleMobile &&
    !standalone() &&
    video.webkitEnterFullscreen &&
    playerReady
  ) {
    try {
      video.webkitEnterFullscreen();
      return;
    } catch {
      /* Viewport fallback below. */
    }
  }
  player.classList.add("expanded");
  document.body.classList.add("player-expanded");
  $("close-expanded").hidden = false;
  $("expand").setAttribute("aria-label", "Свернуть плеер");
  playerChrome.show();
  fitViewport();
  try {
    if (player.requestFullscreen) await player.requestFullscreen();
  } catch {}
}
async function collapse() {
  if (nativeFullscreen) {
    try {
      video.webkitExitFullscreen();
    } catch {}
  }
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch {}
  }
  player.classList.remove("expanded");
  document.body.classList.remove("player-expanded");
  $("close-expanded").hidden = true;
  $("expand").setAttribute("aria-label", "Развернуть плеер");
  playerChrome.show();
  expandedBeforeFocus?.focus();
}
video.addEventListener("webkitbeginfullscreen", () => {
  nativeFullscreen = true;
});
video.addEventListener("webkitendfullscreen", () => {
  nativeFullscreen = false;
  fitViewport();
  applySpeed();
  expandedBeforeFocus?.focus();
});
$("expand").onclick = expand;
$("close-expanded").onclick = collapse;
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && player.classList.contains("expanded"))
    collapse();
});
const showInstall = () => $("install-guide").showModal();
$("install-open").hidden = !appleMobile || standalone();
$("install-player").hidden = !appleMobile || standalone();
$("install-open").onclick = $("install-player").onclick = showInstall;
$("install-close").onclick = $("install-done").onclick = () =>
  $("install-guide").close();
bindPlaybackSpace({ isActive: () => !!current, toggle: togglePlay });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!$("speed-panel").hidden) {
      speedPanel(false);
      $("speed").focus();
    } else collapse();
    return;
  }
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.target.closest("input,textarea,select,[contenteditable=true],dialog")
  )
    return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    if (event.shiftKey) seekTo(video.currentTime + step * 10);
    else
      setSpeed(
        RATES[
          Math.max(
            0,
            Math.min(RATES.length - 1, RATES.indexOf(requested) + step),
          )
        ],
      );
  }
  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    expand();
  }
});
// Read bounded MP4 headers sequentially while paused. No hidden video elements:
// allocating extra mobile decoders can compete with the visible player's memory.
let probeTimer = null,
  probed = new Set();
function stopProbe() {
  clearTimeout(probeTimer);
  const active = probe;
  probe = null;
  active?.cancel();
}
function scheduleProbe() {
  clearTimeout(probeTimer);
  if (pageActive && video.paused && playerReady)
    probeTimer = setTimeout(probeDuration, 1200);
}
async function probeDuration() {
  if (!source || source.local || !pageActive || !video.paused || !playerReady || probe) return;
  const item = items.find(
    (x) =>
      (/\.(mp4|mov|m4v)$/i.test(x.name) ||
        /^(video\/(mp4|quicktime|x-m4v))$/.test(x.mime_type || "")) &&
      !record(entryKey(x)).duration &&
      !probed.has(entryKey(x)) &&
      entryKey(x) !== current?.key,
  );
  if (!item) return;
  const origin = { ...source },
    key = entryKey(item),
    controller = new AbortController();
  const active = { key, cancel: () => controller.abort() };
  probe = active;
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const href = await hrefFor(origin, item, controller.signal);
    const info = await inspectRemoteMP4(href, item.size, controller.signal);
    if (!controller.signal.aborted && probe === active && info.duration) {
      updateRecord(key, { duration: info.duration });
      renderList();
    }
  } catch {
    /* Duration is optional; opening the video remains available. */
  } finally {
    clearTimeout(timer);
    if (probe === active) {
      probe = null;
      probed.add(key);
      scheduleProbe();
    }
  }
}

document.addEventListener("visibilitychange", () => {
  pageActive = !document.hidden;
  tick = 0;
  if (!pageActive) {
    savePosition(true);
    stopProbe();
  } else scheduleProbe();
});
window.addEventListener("pagehide", () => {
  savePosition(true);
  saveSession();
  stopProbe();
});
function rememberScroll() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 100);
}
window.addEventListener("scroll", rememberScroll, { passive: true });
$("playlist").addEventListener("scroll", rememberScroll, { passive: true });
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  const reset = store.get("reset", null);
  if (reset?.id && reset.id !== activeResetStamp) receiveReset(reset);
  fitViewport();
});
$("help-open").onclick = () => {
  $("session-diagnostics-text").textContent = JSON.stringify(
    window.diskPlayDiagnostics?.read() || {},
    null,
    2,
  );
  $("help").showModal();
};
$("copy-session-diagnostics").onclick = async () => {
  try {
    await navigator.clipboard.writeText(
      $("session-diagnostics-text").textContent,
    );
    toast("Диагностика скопирована");
  } catch {
    toast("Выделите и скопируйте текст диагностики.");
  }
};
$("copy-error").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("error-diagnostics").textContent);
    toast("Подробности скопированы. Ссылки на ваши видео в них нет.");
  } catch {
    toast("Выделите и скопируйте текст подробностей ошибки.");
  }
};
$("help-close").onclick = $("help-done").onclick = () => $("help").close();
let clearing = false;
const resetIds = new Set(activeResetStamp ? [activeResetStamp] : []);
function showClearDialog(forgetHistory = false) {
  $("clear-saved-history").checked = forgetHistory;
  $("clear-dialog").showModal();
}
$("clear-source").onclick = () => showClearDialog();
$("clear-history").onclick = () => showClearDialog(true);
$("clear-cancel").onclick = () => $("clear-dialog").close();
function receiveReset({ id, forgetHistory = false }) {
  if (resetIds.has(id)) return;
  resetIds.add(id);
  if (resetIds.size > 100) resetIds.delete(resetIds.values().next().value);
  resetSession();
  activeResetStamp = id;
  if (forgetHistory) {
    history = {};
    persist();
  }
  store.set("source", "");
  $("source").value = "";
  $("clear-dialog").close();
  notice("Плеер очищен. Вставьте новую ссылку на видео или папку.");
  collapse();
}
window.addEventListener("disk-play-cleared", (event) =>
  receiveReset(event.detail),
);
$("clear-confirm").onclick = async () => {
  if (clearing) return;
  clearing = true;
  const detail = {
    id: crypto.randomUUID(),
    forgetHistory: $("clear-saved-history").checked,
  };
  receiveReset(detail);
  $("open-source").disabled =
    $("clear-source").disabled =
    $("clear-history").disabled =
      true;
  notice("Останавливаем потоки и очищаем данные плеера…");
  try {
    await clearSources(detail);
    notice("Плеер очищен. Вставьте новую ссылку на видео или папку.");
    $("source").focus();
  } catch (error) {
    notice(
      "Видео остановлено, но очистка хранилища не завершена. " + error.message,
      true,
    );
  } finally {
    clearing = false;
    $("open-source").disabled =
      $("clear-source").disabled =
      $("clear-history").disabled =
        false;
  }
};
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });
const savedSession = readSession();
if (savedSession) {
  recordDiagnostic("session-restored");
  $("source").value = savedSession.source;
  loadSource(
    savedSession.origin,
    savedSession.path,
    savedSession.stack,
    savedSession,
  );
}
