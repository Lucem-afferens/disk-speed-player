// Minimal ISO BMFF metadata reader. Never scans compressed video for byte patterns.
// Only a validated HEVC sample entry with VPS/SPS/PPS in hvcC may be relabelled.
export function boxHeader(bytes, offset, end = bytes.length) {
  if (offset + 8 > end) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = v.getUint32(offset),
    header = 8;
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = Number(v.getBigUint64(offset + 8));
    header = 16;
  }
  if (!Number.isSafeInteger(size) || (size !== 0 && size < header))
    throw new Error("Повреждён заголовок MP4.");
  return { size, header, type, start: offset };
}
function completeHevcConfig(bytes, start, end) {
  if (end - start < 23 || bytes[start] !== 1) return false;
  const types = new Set();
  let offset = start + 23;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes[start + 22]; i++) {
    if (offset + 3 > end) return false;
    const type = bytes[offset] & 63,
      count = view.getUint16(offset + 1);
    offset += 3;
    for (let j = 0; j < count; j++) {
      if (offset + 2 > end) return false;
      const length = view.getUint16(offset);
      offset += 2;
      if (!length || offset + length > end) return false;
      offset += length;
      types.add(type);
    }
  }
  return [32, 33, 34].every((type) => types.has(type));
}
export function inspectMovie(bytes, absoluteOffset = 0) {
  const patches = [];
  let duration = null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function walk(start, end, depth = 0) {
    if (depth > 12) throw new Error("Слишком сложный контейнер MP4.");
    for (let offset = start; offset + 8 <= end; ) {
      const box = boxHeader(bytes, offset, end);
      if (!box) break;
      const length = box.size || end - offset,
        limit = offset + length,
        payload = offset + box.header;
      if (limit > end || limit <= offset)
        throw new Error("Неполный заголовок MP4.");
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(box.type))
        walk(payload, limit, depth + 1);
      else if (box.type === "stsd" && payload + 8 <= limit)
        walk(payload + 8, limit, depth + 1);
      else if (box.type === "mvhd") {
        const version = bytes[payload],
          scaleOffset = payload + (version === 1 ? 20 : 12),
          ticksOffset = scaleOffset + 4;
        if (
          (version === 0 || version === 1) &&
          ticksOffset + (version === 1 ? 8 : 4) <= limit
        ) {
          const scale = view.getUint32(scaleOffset),
            ticks =
              version === 1
                ? Number(view.getBigUint64(ticksOffset))
                : view.getUint32(ticksOffset);
          if (scale > 0 && ticks > 0 && Number.isSafeInteger(ticks))
            duration = ticks / scale;
        }
      } else if (box.type === "hev1") {
        // VisualSampleEntry has a fixed 78-byte payload before child boxes.
        for (let child = payload + 78; child + 8 <= limit; ) {
          const config = boxHeader(bytes, child, limit);
          if (!config || !config.size || child + config.size > limit) break;
          if (
            config.type === "hvcC" &&
            completeHevcConfig(
              bytes,
              child + config.header,
              child + config.size,
            )
          )
            patches.push(absoluteOffset + offset + 4);
          child += config.size;
        }
      }
      offset = limit;
    }
  }
  walk(0, bytes.length);
  return { patches, duration };
}
export async function inspectRemoteMP4(href, size, signal) {
  if (!Number.isSafeInteger(size) || size < 16)
    throw new Error("Неизвестен размер видео.");
  async function read(start, end) {
    const response = await fetch(href, {
      headers: { Range: `bytes=${start}-${Math.min(end, size - 1)}` },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error("Диск не разрешил чтение части видео.");
    }
    const expected = Math.min(end, size - 1) - start + 1;
    const reader = response.body.getReader();
    const result = new Uint8Array(expected);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > expected)
          throw new Error("Некорректный диапазон видео.");
        result.set(value, offset);
        offset += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (offset !== expected)
      throw new Error("Не удалось полностью прочитать заголовок.");
    return result;
  }
  for (let offset = 0, count = 0; offset + 8 <= size && count < 128; count++) {
    const header = await read(offset, offset + 15),
      box = boxHeader(header, 0);
    if (!box || !box.size || offset + box.size > size) break;
    if (box.type === "moov") {
      if (box.size > 8 * 1024 * 1024)
        throw new Error(
          "Заголовок видео слишком большой для мобильной подготовки.",
        );
      return inspectMovie(await read(offset, offset + box.size - 1), offset);
    }
    offset += box.size;
  }
  return { patches: [], duration: null };
}
