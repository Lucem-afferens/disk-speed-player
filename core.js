export const RATES = [0.5, 1, 1.5, 2, 3, 4, 8, 16, 32];
const HOSTS = new Set([
  "disk.yandex.ru",
  "disk.yandex.com",
  "disk.yandex.by",
  "disk.yandex.kz",
  "disk.360.yandex.ru",
  "yadi.sk",
]);
export function parseLink(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Вставьте ссылку Яндекс Диска на видео или папку.");
  }
  if (
    url.protocol !== "https:" ||
    !HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error("Нужна публичная HTTPS-ссылка Яндекс Диска.");
  const match = url.pathname.match(/^\/(d|i)\/([^/]+)(?:\/(.*))?$/);
  if (!match)
    throw new Error(
      "Откройте «Поделиться» на Диске и скопируйте ссылку на файл или папку.",
    );
  let path;
  try {
    path = match[3] ? "/" + decodeURIComponent(match[3]) : "";
  } catch {
    throw new Error("В ссылке повреждён путь. Скопируйте её заново.");
  }
  return {
    key: `${url.origin}/${match[1]}/${match[2]}`,
    identity: match[2],
    path,
  };
}
export function mediaKey(source, item) {
  return (
    source.identity +
    "|" +
    (item.path || source.path || "/") +
    "|" +
    (item.size || 0)
  );
}
export function isVideo(item) {
  return (
    item.type === "file" &&
    (/^video\//.test(item.mime_type || "") ||
      /\.(mp4|m4v|mov|webm|mkv|avi|wmv|ts|mts|m2ts|mpeg|mpg|3gp|ogv)$/i.test(
        item.name || "",
      ))
  );
}
export function timeLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const n = Math.floor(seconds),
    s = String(n % 60).padStart(2, "0"),
    m = Math.floor(n / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`
    : `${m}:${s}`;
}
export function sizeLabel(bytes) {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} ГБ`
    : `${Math.max(1, Math.round(bytes / 1e6))} МБ`;
}
export function safeMediaURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/(^|\.)(yandex\.(ru|net|com|com\.tr|by|kz)|yandexcloud\.net)$/.test(
      url.hostname,
    )
  )
    throw new Error("Диск вернул неподдерживаемый адрес видео.");
  return url.href;
}
export function nativeRate(video, requested) {
  for (const rate of [
    ...new Set([requested, ...RATES.filter((r) => r < requested).reverse()]),
  ]) {
    try {
      video.playbackRate = rate;
      if (Math.abs(video.playbackRate - rate) < 0.01) return rate;
    } catch {
      /* browser-specific limit */
    }
  }
  return 1;
}
export function bufferedEnd(video) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (
      video.buffered.start(i) <= video.currentTime + 0.1 &&
      video.buffered.end(i) >= video.currentTime
    )
      return video.buffered.end(i);
  }
  return video.currentTime;
}
export function overviewTarget({
  position,
  elapsed,
  requested,
  actual,
  bufferEnd,
  duration,
}) {
  if (!(elapsed > 0 && elapsed <= 0.8) || requested <= actual) return null;
  const jump = (requested - actual) * elapsed;
  const target = Math.min(position + jump, duration);
  return jump >= 0.2 && target < bufferEnd - 0.15 ? target : null;
}
