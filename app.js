import {RATES, parseLink, mediaKey, isVideo, timeLabel, sizeLabel, safeMediaURL, nativeRate, bufferedEnd, overviewTarget} from './core.js';
import {compatibleSource, releaseSource} from './compatibility.js';
import {inspectRemoteMP4} from './mp4.js';
const $ = id => document.getElementById(id);
const video = $('video'), player = $('player'), API = 'https://cloud-api.yandex.net/v1/disk/';
const PREFIX = 'disk-play:v1:';
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(PREFIX + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Private mode or full storage: playback remains available. */ } }
};
let history = store.get('history', {}), current = null, source = null, items = [], folders = [], folderStack = [], folderPath = '', folderName = '';
if (!history || typeof history !== 'object' || Array.isArray(history)) history = {};
let requested = RATES.includes(store.get('rate', 1)) ? store.get('rate', 1) : 1;
let supported = 1, actual = 1, overview = false, limited = false, previousMuted = false, savingAt = 0, lastAdapt = 0, tick = 0;
let loadingController = null, mediaController = null, mediaGeneration = 0, metadataTarget = null, toastTimer, durationTimer, probe = null;
let dragging = false, playerReady = false, expandedBeforeFocus = null;
let pageActive = true;
const collator = new Intl.Collator('ru', {numeric:true, sensitivity:'base'});
const svg = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
$('back').innerHTML = `${svg('back')}<span>10</span>`;
$('forward').innerHTML = `${svg('forward')}<span>10</span>`;
const entryKey = item => mediaKey(source, item);
const record = key => history[key] && typeof history[key] === 'object' ? history[key] : {};
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function notice(message = '', error = false) { $('source-status').hidden = !message; $('source-status').textContent = message; $('source-status').classList.toggle('error', error); }
function persist() {
  const entries = Object.entries(history).sort((a,b) => (b[1].updated || 0) - (a[1].updated || 0));
  history = Object.fromEntries(entries.slice(0, 1000));
  store.set('history', history);
}
function updateRecord(key, change) { history[key] = {...record(key), ...change, updated:Date.now()}; persist(); }
function savePosition(force = false) {
  if (!current || !playerReady || (!force && Date.now() - savingAt < 2000)) return;
  savingAt = Date.now();
  updateRecord(current.key, {position:video.currentTime, duration:Number.isFinite(video.duration) ? video.duration : undefined});
}
async function api(endpoint, params, signal) {
  const timeout = new AbortController();
  const relay = () => timeout.abort();
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  signal?.addEventListener('abort', relay, {once:true});
  const timer = setTimeout(() => timeout.abort(), 25000);
  try {
    const response = await fetch(API + endpoint + '?' + new URLSearchParams(params), {signal:timeout.signal, credentials:'omit', referrerPolicy:'no-referrer'});
    if (!response.ok) {
      const messages = {400:'Не удалось прочитать ссылку. Скопируйте её заново из «Поделиться».',401:'Ссылка требует входа. Используйте публичную ссылку.',403:'Доступ запрещён. Проверьте, что владелец разрешил скачивание и не установил пароль.',404:'Видео или папка не найдены. Возможно, ссылка больше не действует.',429:'Диск ограничил частоту запросов. Подождите немного и повторите.'};
      throw new Error(messages[response.status] || 'Яндекс Диск временно недоступен. Попробуйте ещё раз.');
    }
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (error.name === 'AbortError') throw new Error('Диск отвечает слишком долго. Проверьте интернет и повторите.');
    if (error instanceof TypeError) throw new Error('Не удалось связаться с Диском. Проверьте интернет или блокировку запросов браузером.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
}
async function resource(origin, path, signal) {
  const params = {public_key:origin.key, limit:'100', offset:'0', sort:'name'};
  if (path) params.path = path;
  const data = await api('public/resources', params, signal);
  if (data.type !== 'dir') return data;
  let list = [...(data._embedded?.items || [])];
  const total = data._embedded?.total ?? list.length;
  while (list.length < total) {
    params.offset = String(list.length);
    const page = await api('public/resources', params, signal);
    const next = page._embedded?.items || [];
    if (!next.length) throw new Error('Диск вернул неполный список. Откройте папку ещё раз.');
    list.push(...next);
    notice(`Загружаем список: ${Math.min(list.length, total)} из ${total}…`);
    if (list.length > 20000) throw new Error('В папке слишком много файлов. Вставьте ссылку на одну из вложенных папок.');
  }
  return {...data, _embedded:{...data._embedded, items:list}};
}
function linkFor(origin, item) {
  const url = origin.key + ((item.path && item.path !== '/') ? '/' + item.path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/') : '');
  return url;
}
async function hrefFor(origin, item, signal) {
  const params = {public_key:origin.key};
  if (item.path && item.path !== '/') params.path = item.path;
  return safeMediaURL((await api('public/resources/download', params, signal)).href);
}
async function loadSource(origin, path = origin.path, stack = []) {
  loadingController?.abort(); stopProbe();
  const controller = new AbortController(); loadingController = controller;
  $('open-source').disabled = true; $('cancel-load').hidden = false; $('open-source').textContent = 'Открываем…';
  notice('Получаем список с Яндекс Диска…');
  try {
    const data = await resource(origin, path, controller.signal);
    if (controller.signal.aborted) return;
    const entries = data.type === 'dir' ? data._embedded.items : [data];
    const videos = entries.filter(isVideo).sort((a,b) => collator.compare(a.name,b.name));
    const dirs = entries.filter(x => x.type === 'dir').sort((a,b) => collator.compare(a.name,b.name));
    if (data.type !== 'dir' && !videos.length) throw new Error('По этой ссылке находится не видео. Выберите видеофайл или папку.');
    source = origin; items = videos; folders = dirs; folderPath = path; folderName = data.name; folderStack = stack;
    document.body.classList.add('has-source');
    store.set('source', $('source').value.trim());
    $('filter').value = ''; $('unwatched-only').checked = false;
    $('folder-name').textContent = folderName; $('folder-nav').hidden = data.type !== 'dir'; $('folder-back').disabled = !stack.length;
    $('video-count').textContent = items.length; $('list-tools').hidden = !items.length;
    notice(!items.length && !folders.length ? 'В этой папке нет видео. Откройте другую папку.' : '');
    renderList();
    if (items.length) await openVideo(items[0], false);
  } catch (error) { if (error.name !== 'AbortError') notice(error.message, true); }
  finally {
    if (loadingController === controller) { loadingController = null; $('open-source').disabled = false; $('open-source').innerHTML = `Открыть ${svg('arrow')}`; $('cancel-load').hidden = true; }
  }
}
$('source-form').addEventListener('submit', event => { event.preventDefault(); try { const origin = parseLink($('source').value); loadSource(origin); } catch(error) { notice(error.message, true); $('source').focus(); } });
$('cancel-load').onclick = () => { loadingController?.abort(); notice('Загрузка списка отменена.'); };
$('folder-back').onclick = () => { if (!folderStack.length) return; const next = folderStack.slice(0,-1); loadSource(source, folderStack.at(-1), next); };
function renderList() {
  const list = $('playlist'), scroll = list.scrollTop;
  const query = $('filter').value.toLocaleLowerCase().trim(), onlyNew = $('unwatched-only').checked;
  const fragment = document.createDocumentFragment(); let count = 0;
  for (const folder of folders) {
    if (query && !folder.name.toLocaleLowerCase().includes(query)) continue;
    const row = document.createElement('div'); row.className = 'playlist-item folder-row';
    const button = document.createElement('button'); button.className = 'item-open'; button.innerHTML = `<span class="item-number">${svg('folder')}</span><span class="item-details"><span class="item-name"></span><span class="item-meta">Открыть папку →</span></span>`;
    button.querySelector('.item-name').textContent = folder.name;
    button.onclick = () => loadSource(source, folder.path, [...folderStack, folderPath]);
    row.append(button); fragment.append(row); count++;
  }
  items.forEach((item, index) => {
    const key = entryKey(item), saved = record(key), selected = current?.key === key;
    if ((query && !item.name.toLocaleLowerCase().includes(query)) || (onlyNew && saved.watched)) return;
    const row = document.createElement('div'); row.className = 'playlist-item' + (selected ? ' current' : '') + (saved.watched ? ' watched' : ''); row.dataset.key = key;
    const open = document.createElement('button'); open.className = 'item-open'; open.setAttribute('aria-current', selected ? 'true' : 'false');
    open.innerHTML = `<span class="item-number">${selected ? svg('play') : index + 1}</span><span class="item-details"><span class="item-name"></span><span class="item-meta"><span class="item-duration"></span><span>· ${sizeLabel(item.size || 0)}</span><span class="item-status"></span></span></span>`;
    open.querySelector('.item-name').textContent = item.name;
    open.querySelector('.item-duration').textContent = timeLabel(saved.duration);
    open.querySelector('.item-duration').title = saved.duration ? 'Длительность видео' : 'Длительность появится после чтения видео';
    open.querySelector('.item-status').textContent = saved.watched ? '✓ Просмотрено' : saved.started ? '◐ Начат просмотр' : '';
    open.onclick = () => { if (current?.key === key && playerReady && $('video-error').hidden) togglePlay(); else openVideo(item, true); };
    const mark = document.createElement('button'); mark.className = 'item-mark'; mark.innerHTML = svg('check'); mark.setAttribute('aria-pressed', String(!!saved.watched)); mark.setAttribute('aria-label', (saved.watched ? 'Снять отметку просмотра: ' : 'Отметить просмотренным: ') + item.name); mark.onclick = () => toggleWatched(key);
    row.append(open, mark);
    if (saved.duration && saved.position) { const bar = document.createElement('span'); bar.className = 'item-progress'; bar.style.width = Math.min(100, saved.position / saved.duration * 100) + '%'; row.append(bar); }
    fragment.append(row); count++;
  });
  if (!count) { const empty = document.createElement('div'); empty.className = 'list-empty'; empty.textContent = items.length || folders.length ? 'Нет подходящих видео. Измените фильтр.' : 'В этой папке нет видео.'; fragment.append(empty); }
  list.replaceChildren(fragment); list.scrollTop = scroll;
  const watched = items.filter(item => record(entryKey(item)).watched).length;
  $('list-summary').textContent = items.length ? `Просмотрено ${watched} из ${items.length} · Отметки на этом устройстве` : 'Отметки и позиции сохраняются на этом устройстве.';
  updateCurrentActions();
}
function toggleWatched(key) { const next = !record(key).watched; updateRecord(key, {watched:next}); renderList(); toast(next ? 'Отмечено как просмотренное' : 'Отметка просмотра снята'); }
function currentIndex() { return current && source?.identity === current.origin.identity ? items.findIndex(x => entryKey(x) === current.key) : -1; }
function updateCurrentActions() {
  $('mark-watched').disabled = !current;
  $('mark-watched').querySelector('span').textContent = current && record(current.key).watched ? 'Просмотрено · снять отметку' : 'Отметить просмотренным';
  const index = currentIndex(); $('next-video').disabled = index < 0 || index >= items.length - 1;
}
$('filter').oninput = renderList; $('unwatched-only').onchange = renderList;
$('mark-watched').onclick = () => current && toggleWatched(current.key);
$('next-video').onclick = () => { const index = currentIndex(); if (index >= 0 && items[index + 1]) openVideo(items[index + 1], true); };
$('autonext').checked = store.get('autonext', true); $('autonext').onchange = () => store.set('autonext', $('autonext').checked);
$('source').value = store.get('source', '');
function controlsEnabled(enabled) { for (const id of ['play','back','forward','seek','mute','volume']) $(id).disabled = !enabled; }
function showLoading(visible, text = 'Открываем видео…') { $('loading-video').hidden = !visible; $('loading-text').textContent = text; }
function showVideoError(message) { showLoading(false); $('center-play').hidden = true; $('video-error-text').textContent = message; $('video-error').hidden = false; controlsEnabled(false); }
async function openVideo(item, autoplay = false, resumeOverride = null) {
  stopProbe(); savePosition(true); mediaController?.abort();
  releaseSource(current?.compatToken);
  const generation = ++mediaGeneration; const controller = new AbortController(); mediaController = controller;
  playerReady = false; video.pause(); video.removeAttribute('src'); video.load();
  current = {item, origin:{...source}, key:entryKey(item), index:items.indexOf(item) + 1, total:items.length};
  if (autoplay && window.innerWidth < 850 && !player.classList.contains('expanded')) player.scrollIntoView({block:'start', behavior:'smooth'});
  metadataTarget = {position:resumeOverride ?? record(current.key).position ?? 0, autoplay};
  $('video-name').textContent = item.name; $('video-name').title = item.name; $('video-index').textContent = `ВИДЕО ${current.index} ИЗ ${current.total}`;
  $('empty').hidden = true; $('center-play').hidden = true; $('video-error').hidden = true;
  $('disk-link').href = linkFor(current.origin, item); $('elapsed').textContent = '0:00'; $('duration').textContent = timeLabel(record(current.key).duration);
  $('seek').value = 0; $('seek').style.setProperty('--progress', '0%'); controlsEnabled(false); showLoading(true); renderList();
  try {
    const href = await hrefFor(current.origin, item, controller.signal);
    if (generation !== mediaGeneration) return;
    current.originalHref = href; video.src = href; video.load();
    clearTimeout(durationTimer);
    durationTimer = setTimeout(() => { if (generation === mediaGeneration && !playerReady) showVideoError('Не удалось открыть видео вовремя. Попробуйте ещё раз или проверьте файл на Диске.'); }, 35000);
  } catch (error) { if (error.name !== 'AbortError' && generation === mediaGeneration) showVideoError(error.message); }
}
async function play() {
  if (!current || !playerReady) return;
  try { await video.play(); } catch(error) { if (error.name !== 'AbortError') { $('center-play').hidden = false; showLoading(false); toast('Нажмите ▶ в плеере, чтобы начать просмотр.'); } }
}
function togglePlay() { if (!playerReady) return; if (video.paused) play(); else video.pause(); }
$('play').onclick = togglePlay; $('center-play').onclick = play;
$('screen').onclick = event => { if (event.target === video) togglePlay(); };
$('retry-video').onclick = () => {
  if (!current) return;
  const item = current.item, origin = current.origin, key = current.key;
  // Retrying uses the original source even if the playlist was changed meanwhile.
  if (source?.identity !== origin.identity) { $('source').value = origin.key; loadSource(origin, item.path); return; }
  openVideo(item, true, record(key).position || 0);
};
video.addEventListener('loadedmetadata', () => {
  if (!current || !video.getAttribute('src') || !Number.isFinite(video.duration) || video.duration <= 0) return;
  clearTimeout(durationTimer); playerReady = true; $('video-error').hidden = true; controlsEnabled(true);
  updateRecord(current.key, {duration:video.duration});
  $('duration').textContent = timeLabel(video.duration);
  const target = metadataTarget; metadataTarget = null;
  if (target?.position > 0 && target.position < video.duration - 2) video.currentTime = target.position;
  applySpeed(); renderList(); showLoading(false); $('center-play').hidden = false;
  if (target?.autoplay) play();
  scheduleProbe();
});
video.addEventListener('play', () => {
  stopProbe(); $('play').innerHTML = svg('pause'); $('play').setAttribute('aria-label','Пауза'); $('center-play').hidden = true;
  if (current && !record(current.key).started) { updateRecord(current.key, {started:true}); renderList(); }
  tick = 0;
});
video.addEventListener('playing', () => { showLoading(false); $('center-play').hidden = true; tick = 0; });
video.addEventListener('pause', () => { $('play').innerHTML = svg('play'); $('play').setAttribute('aria-label','Воспроизвести'); $('center-play').hidden = !playerReady || !$('video-error').hidden; showLoading(false); savePosition(true); tick = 0; scheduleProbe(); });
video.addEventListener('ended', () => {
  if (current) updateRecord(current.key, {watched:true, position:0});
  renderList();
  const index = currentIndex();
  if ($('autonext').checked && index >= 0 && items[index + 1]) openVideo(items[index + 1], true);
});
video.addEventListener('timeupdate', () => {
  if (!dragging) { $('elapsed').textContent = timeLabel(video.currentTime); const progress = Number.isFinite(video.duration) ? video.currentTime / video.duration : 0; $('seek').value = Math.round(progress * 1000); $('seek').style.setProperty('--progress', progress * 100 + '%'); $('seek').setAttribute('aria-valuetext', `${timeLabel(video.currentTime)} из ${timeLabel(video.duration)}`); }
  savePosition();
});
video.addEventListener('waiting', () => { tick = 0; if (!video.paused && playerReady) { showLoading(true,'Буферизация…'); adaptSpeed(true); } });
video.addEventListener('seeking', () => { tick = 0; });
video.addEventListener('seeked', () => { tick = 0; if (video.readyState >= 3 || video.paused) showLoading(false); });
video.addEventListener('error', async () => {
  if (!video.getAttribute('src') || !current) return;
  clearTimeout(durationTimer);
  // Some camera MP4s declare HEVC as hev1; Safari requires hvc1. Only the
  // verified sample-entry tag is changed, in a local streaming worker.
  if ([3,4].includes(video.error?.code) && !current.compatTried && current.originalHref && video.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"')) {
    current.compatTried = true; const generation = mediaGeneration;
    showLoading(true,'Подготавливаем совместимый поток…');
    const timeout = setTimeout(() => { if (generation === mediaGeneration) mediaController?.abort(); },25000);
    try {
      const result = await compatibleSource(current.originalHref, current.item.size, mediaController.signal);
      if (generation !== mediaGeneration) { releaseSource(result?.token); return; }
      if (result) { current.compatToken = result.token; video.src = result.url; video.load(); durationTimer = setTimeout(() => { if (generation === mediaGeneration && !playerReady) showVideoError('Совместимый поток не открылся. Попробуйте ещё раз.'); },25000); return; }
    } catch { if (generation !== mediaGeneration) return; }
    finally { clearTimeout(timeout); }
  }
  showVideoError(video.error?.code === 2 ? 'Соединение с видео прервалось. Повторная попытка обновит ссылку и сохранит позицию.' : 'Этот формат не воспроизводится браузером либо Диск ограничил доступ. Для телефона подходит MP4 с H.264. Попробуйте обновить ссылку или открыть файл на Диске.');
});
function seekTo(seconds) { if (playerReady) { video.currentTime = Math.max(0, Math.min(video.duration, seconds)); tick = 0; } }
$('back').onclick = () => seekTo(video.currentTime - 10); $('forward').onclick = () => seekTo(video.currentTime + 10);
$('seek').oninput = () => { dragging = true; const p = Number($('seek').value) / 1000; $('elapsed').textContent = timeLabel(p * video.duration); $('seek').style.setProperty('--progress', p * 100 + '%'); };
$('seek').onchange = () => { seekTo(Number($('seek').value) / 1000 * video.duration); dragging = false; };
function updateVolume() { $('mute').innerHTML = svg(video.muted || video.volume === 0 ? 'mute' : 'volume'); $('mute').setAttribute('aria-label', video.muted ? 'Включить звук' : 'Выключить звук'); $('mute').setAttribute('aria-pressed', String(video.muted)); $('volume').value = video.muted ? 0 : video.volume; $('volume').style.setProperty('--progress', (video.muted ? 0 : video.volume * 100) + '%'); }
$('mute').onclick = () => { if (overview) { toast('В режиме обзора звук выключен. Выберите меньшую скорость.'); return; } video.muted = !video.muted; };
$('volume').oninput = () => { if (overview) { toast('В режиме обзора звук выключен.'); updateVolume(); return; } video.volume = Number($('volume').value); video.muted = video.volume === 0; updateVolume(); };
video.addEventListener('volumechange', updateVolume); updateVolume();
function applySpeed() {
  const oldOverview = overview;
  supported = nativeRate(video, requested); actual = supported; limited = false; overview = supported < requested;
  if (overview && !oldOverview) { previousMuted = video.muted; video.muted = true; }
  if (!overview && oldOverview) video.muted = previousMuted;
  video.preservesPitch = true; tick = 0;
  $('speed').innerHTML = `${requested}× <span>⌄</span>`; $('speed').setAttribute('aria-label', `Скорость: ${requested}×. Изменить`);
  document.querySelectorAll('[data-rate]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.rate) === requested)));
  speedNote();
}
function speedNote() {
  const note = $('playback-note');
  if (limited) note.textContent = `Сеть не успевает · сейчас ${actual}× · выбрано ${requested}×`;
  else if (overview) note.textContent = `${requested}× · обзор с пропуском фрагментов · без звука`;
  else note.textContent = requested > 4 ? `${requested}× · звук зависит от браузера · скорость зависит от сети` : 'Скорость можно менять прямо здесь, рядом со звуком.';
  note.classList.toggle('warning', overview || limited);
  $('speed-explanation').textContent = requested >= 8 ? 'Если браузер не поддерживает скорость, включается обзор с пропуском фрагментов. При слабой сети скорость снижается автоматически.' : 'На высоких скоростях звук может отключаться браузером.';
}
function setSpeed(rate) { requested = rate; store.set('rate', rate); applySpeed(); }
function speedPanel(open) { $('speed-panel').hidden = !open; $('speed').setAttribute('aria-expanded', String(open)); if (open) $('speed-options').querySelector('[aria-pressed=true]')?.focus(); }
for (const rate of RATES) { const button = document.createElement('button'); button.textContent = rate + '×'; button.dataset.rate = rate; button.setAttribute('aria-pressed','false'); button.onclick = () => { setSpeed(rate); speedPanel(false); $('speed').focus(); }; $('speed-options').append(button); }
$('speed').onclick = () => speedPanel($('speed-panel').hidden); $('speed-close').onclick = () => { speedPanel(false); $('speed').focus(); };
document.addEventListener('pointerdown', event => { if (!$('speed-panel').contains(event.target) && !$('speed').contains(event.target)) speedPanel(false); });
function adaptSpeed(waiting = false) {
  if (!playerReady || video.paused || video.seeking || requested < 8) return;
  const end = bufferedEnd(video), ahead = end - video.currentTime;
  let next = actual;
  if (end >= video.duration - .1) next = supported;
  else if (waiting || ahead < Math.max(1, actual * .7)) next = [1,2,4,8,16,32].filter(n => n <= supported && n <= Math.max(1,ahead / 2)).at(-1) || 1;
  else if (limited && performance.now() - lastAdapt > 2500) next = [1,2,4,8,16,32].filter(n => n <= supported && ahead >= n * 3).at(-1) || actual;
  if (next !== actual) { actual = nativeRate(video, next); limited = actual < supported; lastAdapt = performance.now(); tick = 0; speedNote(); }
}
setInterval(() => {
  adaptSpeed();
  if (!pageActive || !overview || limited || video.paused || video.ended || video.seeking || video.readyState < 3 || !playerReady) { tick = 0; return; }
  const now = performance.now(); if (!tick) { tick = now; return; }
  const target = overviewTarget({position:video.currentTime, elapsed:(now - tick)/1000, requested, actual, bufferEnd:bufferedEnd(video), duration:video.duration});
  tick = now; if (target !== null) video.currentTime = target;
}, 250);
applySpeed();
async function expand() {
  if (player.classList.contains('expanded') || document.fullscreenElement === player) { await collapse(); return; }
  expandedBeforeFocus = document.activeElement;
  player.classList.add('expanded'); document.body.classList.add('player-expanded'); $('close-expanded').hidden = false; $('expand').setAttribute('aria-label','Свернуть плеер');
  try { if (player.requestFullscreen) await player.requestFullscreen(); } catch { /* iPhone fallback preserves custom controls in a viewport-sized player. */ }
}
async function collapse() {
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  player.classList.remove('expanded'); document.body.classList.remove('player-expanded'); $('close-expanded').hidden = true; $('expand').setAttribute('aria-label','Развернуть плеер'); expandedBeforeFocus?.focus();
}
$('expand').onclick = expand; $('close-expanded').onclick = collapse;
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && player.classList.contains('expanded')) collapse(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (!$('speed-panel').hidden) { speedPanel(false); $('speed').focus(); } else collapse(); return; }
  if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input,textarea,select,[contenteditable=true],dialog')) return;
  if (event.code === 'Space' && event.target.tagName !== 'BUTTON') { event.preventDefault(); togglePlay(); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const step = event.key === 'ArrowRight' ? 1 : -1; if (event.shiftKey) seekTo(video.currentTime + step * 10); else setSpeed(RATES[Math.max(0,Math.min(RATES.length - 1,RATES.indexOf(requested) + step))]); }
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); expand(); }
});
// Read one metadata stream at a time, only while the main player is paused.
// Cancelling removes src immediately; we never prefetch video files or use a proxy.
let probeTimer = null, probed = new Set();
function stopProbe() { clearTimeout(probeTimer); if (probe) { probe.cancel(); probe = null; } }
function scheduleProbe() { clearTimeout(probeTimer); if (pageActive && video.paused && playerReady) probeTimer = setTimeout(probeDuration, 1200); }
async function probeDuration() {
  if (!source || !pageActive || !video.paused || !playerReady || probe) return;
  const item = items.find(x => !record(entryKey(x)).duration && !probed.has(entryKey(x)) && entryKey(x) !== current?.key);
  if (!item) return;
  const origin = {...source}, key = entryKey(item), controller = new AbortController(), element = document.createElement('video');
  let finished = false, timer;
  const finish = (success = false) => {
    if (finished) return; finished = true; clearTimeout(timer); controller.abort(); element.removeAttribute('src'); element.load();
    if (probe?.key === key) probe = null;
    if (success) probed.add(key);
    scheduleProbe();
  };
  probe = {key, cancel:() => finish(false)};
  element.preload = 'metadata'; element.muted = true; element.playsInline = true;
  element.onloadedmetadata = () => { if (finished) return; if (Number.isFinite(element.duration) && element.duration > 0) { updateRecord(key, {duration:element.duration}); renderList(); } finish(true); };
  element.onerror = async () => { try { const info = await inspectRemoteMP4(element.src,item.size,controller.signal); if (!finished && info.duration) { updateRecord(key,{duration:info.duration}); renderList(); } } catch {} finally { finish(true); } };
  timer = setTimeout(() => finish(true), 10000);
  try { const href = await hrefFor(origin, item, controller.signal); if (!finished) { element.src = href; element.load(); } } catch { if (!finished) finish(true); }
}
document.addEventListener('visibilitychange', () => { pageActive = !document.hidden; tick = 0; if (!pageActive) { savePosition(true); stopProbe(); } else scheduleProbe(); });
window.addEventListener('pagehide', () => { savePosition(true); stopProbe(); });
$('help-open').onclick = () => $('help').showModal(); $('help-close').onclick = $('help-done').onclick = () => $('help').close();
$('clear-history').onclick = () => $('clear-dialog').showModal(); $('clear-cancel').onclick = () => $('clear-dialog').close();
$('clear-confirm').onclick = () => { history = {}; persist(); store.set('source',''); store.set('rate',1); store.set('autonext',true); $('source').value = ''; if (current) { updateRecord(current.key, {duration:video.duration}); } renderList(); $('clear-dialog').close(); toast('История устройства очищена'); };
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
