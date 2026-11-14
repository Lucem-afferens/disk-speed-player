import test from "node:test";
import assert from "node:assert/strict";
import { boxHeader, inspectMovie } from "../mp4.js";
function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length);
  out.write(type, 4);
  payload.copy(out, 8);
  return out;
}
function movie(types = [32, 33, 34]) {
  const header = Buffer.alloc(23);
  header[0] = 1;
  header[22] = types.length;
  const arrays = types.map((type) => Buffer.from([type, 0, 1, 0, 1, 42]));
  const entry = box("hev1", Buffer.alloc(78), box("hvcC", header, ...arrays));
  const stsd = box("stsd", Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), entry);
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(1200000, 16);
  return box(
    "moov",
    box("mvhd", mvhd),
    box("trak", box("mdia", box("minf", box("stbl", stsd)))),
  );
}
test("only the validated HEVC sample entry is patched, not media-like strings", () => {
  const input = movie();
  const result = inspectMovie(input, 500);
  assert.deepEqual(result.patches, [input.indexOf("hev1") + 500]);
  assert.equal(result.duration, 1200);
  assert.deepEqual(
    inspectMovie(box("mdat", Buffer.from("fake hev1 sample"))).patches,
    [],
  );
});
test("HEVC without all parameter sets is not relabelled", () => {
  assert.deepEqual(inspectMovie(movie([32, 33])).patches, []);
});
test("rejects truncated or malicious box lengths", () => {
  const input = movie();
  input.writeUInt32BE(input.length + 100);
  assert.throws(() => inspectMovie(input));
  const tiny = Buffer.alloc(8);
  tiny.writeUInt32BE(4);
  assert.throws(() => boxHeader(tiny, 0));
});
