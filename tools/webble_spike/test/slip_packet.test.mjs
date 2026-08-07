// Cross-checks slip.mjs/packet.mjs against golden.json, generated straight
// from Nordic's own SnifferAPI (see gen_golden_vectors.py). Run with:
//   node --test test/slip_packet.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { encodeSlip, SlipDecoder } from "../slip.mjs";
import { buildScanRequest, buildSetTemporaryKey, buildFollowRequest, buildPingRequest } from "../packet.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.join(here, "golden.json"), "utf8"));

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("encodeSlip matches Nordic's encodeToSLIP byte-for-byte", () => {
  const { raw, encoded } = golden.slip_roundtrip;
  assert.equal(toHex(encodeSlip(raw)), toHex(encoded));
});

test("SlipDecoder inverts encodeSlip (round trip)", () => {
  const { raw } = golden.slip_roundtrip;
  const encoded = encodeSlip(raw);
  const frames = [];
  const decoder = new SlipDecoder((frame) => frames.push(frame));
  decoder.pushBytes(encoded);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], raw);
});

test("SlipDecoder handles bytes trickling in one at a time", () => {
  const { raw } = golden.slip_roundtrip;
  const encoded = encodeSlip(raw);
  const frames = [];
  const decoder = new SlipDecoder((frame) => frames.push(frame));
  for (const b of encoded) decoder.pushByte(b);
  assert.deepEqual(frames[0], raw);
});

test("SlipDecoder handles two frames split across arbitrary chunk boundaries", () => {
  const { raw } = golden.slip_roundtrip;
  const encoded = [...encodeSlip(raw), ...encodeSlip(raw)];
  const frames = [];
  const decoder = new SlipDecoder((frame) => frames.push(frame));
  // Split at a deliberately awkward point (mid-escape-sequence).
  const splitAt = 5;
  decoder.pushBytes(encoded.slice(0, splitAt));
  decoder.pushBytes(encoded.slice(splitAt));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], raw);
  assert.deepEqual(frames[1], raw);
});

test("request packets match Nordic's sendScan/sendTK/sendFollow/sendPingReq exactly", () => {
  let counter = 0;
  const built = [
    encodeSlip(buildScanRequest(counter++)),
    encodeSlip(buildSetTemporaryKey(counter++)),
    encodeSlip(buildFollowRequest(counter++, [0x94, 0xa9, 0xa8, 0x35, 0xc4, 0xb1])),
    encodeSlip(buildPingRequest(counter++)),
  ];
  const expected = golden.request_sequence.packetsHex;
  assert.equal(built.length, expected.length);
  built.forEach((frame, i) => {
    assert.equal(toHex(frame), expected[i], `packet ${i} mismatch`);
  });
});
