import { golden } from "./golden.mjs";
import { encodeSlip, SlipDecoder } from "../slip.mjs";
import { buildScanRequest, buildSetTemporaryKey, buildFollowRequest, buildPingRequest, parseResponsePacket } from "../packet.mjs";
import { AttWriteWatcher } from "../att.mjs";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "mismatch"}: got ${a}, want ${e}`);
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

// --- SLIP ---

test("encodeSlip matches Nordic's encodeToSLIP byte-for-byte", () => {
  assertEqual(toHex(encodeSlip(golden.slip_roundtrip.raw)), toHex(golden.slip_roundtrip.encoded));
});

test("SlipDecoder inverts encodeSlip", () => {
  const frames = [];
  const decoder = new SlipDecoder((f) => frames.push(f));
  decoder.pushBytes(encodeSlip(golden.slip_roundtrip.raw));
  assertEqual(frames.length, 1);
  assertEqual(frames[0], golden.slip_roundtrip.raw);
});

test("SlipDecoder handles bytes arriving one at a time", () => {
  const frames = [];
  const decoder = new SlipDecoder((f) => frames.push(f));
  for (const b of encodeSlip(golden.slip_roundtrip.raw)) decoder.pushByte(b);
  assertEqual(frames[0], golden.slip_roundtrip.raw);
});

test("SlipDecoder handles two frames split across an awkward chunk boundary", () => {
  const encoded = [...encodeSlip(golden.slip_roundtrip.raw), ...encodeSlip(golden.slip_roundtrip.raw)];
  const frames = [];
  const decoder = new SlipDecoder((f) => frames.push(f));
  decoder.pushBytes(encoded.slice(0, 5));
  decoder.pushBytes(encoded.slice(5));
  assertEqual(frames.length, 2);
  assertEqual(frames[0], golden.slip_roundtrip.raw);
  assertEqual(frames[1], golden.slip_roundtrip.raw);
});

// --- Request framing ---

test("request packets match sendScan/sendTK/sendFollow/sendPingReq exactly", () => {
  let c = 0;
  const built = [encodeSlip(buildScanRequest(c++)), encodeSlip(buildSetTemporaryKey(c++)), encodeSlip(buildFollowRequest(c++, [0x94, 0xa9, 0xa8, 0x35, 0xc4, 0xb1])), encodeSlip(buildPingRequest(c++))];
  built.forEach((frame, i) => assertEqual(toHex(frame), golden.request_sequence.packetsHex[i], `packet ${i}`));
});

// --- Response parsing (ADV + DATA PDU) ---

test("parseResponsePacket decodes a synthetic ADV_IND identically to Nordic's Packet class", () => {
  const packet = parseResponsePacket(fromHex(golden.response_adv_packet.packetListHex));
  const exp = golden.response_adv_packet.expected;
  assertEqual(packet.OK, exp.OK, "OK");
  assertEqual(packet.crcOK, exp.crcOK, "crcOK");
  assertEqual(packet.channel, exp.channel, "channel");
  assertEqual(packet.RSSI, exp.RSSI, "RSSI");
  assertEqual(packet.blePacket.advType, exp.advType, "advType");
  assertEqual(packet.blePacket.name, exp.name, "name");
  assertEqual(packet.blePacket.advAddress, exp.advAddress, "advAddress");
});

test("parseResponsePacket decodes a synthetic DATA PDU identically to Nordic's Packet class", () => {
  const packet = parseResponsePacket(fromHex(golden.response_data_packet.packetListHex));
  const exp = golden.response_data_packet.expected;
  assertEqual(packet.blePacket.llid, exp.llid, "llid");
  assertEqual(toHex(packet.blePacket.payload), exp.payloadHex, "payload");
});

test("AttWriteWatcher extracts a single-fragment Write Request from the DATA PDU golden vector", () => {
  const packet = parseResponsePacket(fromHex(golden.response_data_packet.packetListHex));
  let captured = null;
  const watcher = new AttWriteWatcher((w) => (captured = w));
  watcher.handleDataPacket(packet);
  assertEqual(captured.opcode, 0x12);
  assertEqual(captured.handle, 0x0016);
  assertEqual(captured.value, [0xaa, 0xbb, 0xcc]);
});

// --- ATT reassembly across multiple LL Data PDUs (no Python equivalent --
// self-consistency check: build the raw wire bytes for a 20-byte handshake
// write split across a START + CONTINUATION fragment exactly like
// SnifferAPI's own header layout, then confirm the full pipeline
// (parseResponsePacket -> AttWriteWatcher) reassembles it correctly). ---

function le(value, size) {
  const out = [];
  for (let i = 0; i < size; i++) out.push((value >> (8 * i)) & 0xff);
  return out;
}

function buildSyntheticDataPacketList(llid, llPayload, { direction = false, counter = 0 } = {}) {
  const flags = 0b0001 | (direction ? 0b0010 : 0); // crcOK=1, phy=1M
  const connHeaderByte = llid & 3;
  const bleBytes = [0xd6, 0xbe, 0x89, 0x8e, connHeaderByte, llPayload.length, 0x00, ...llPayload];
  const payload = [10, flags, 37, 40, ...le(counter, 2), ...le(5_000_000, 4), ...bleBytes];
  const header = [...le(payload.length, 2), 3, ...le(counter, 2), 0x06]; // EVENT_PACKET_DATA_PDU
  return [...header, ...payload];
}

test("AttWriteWatcher reassembles a 20-byte handshake write split across START + CONTINUATION fragments", () => {
  const value = Array.from({ length: 20 }, (_, i) => i);
  const attWrite = [0x12, ...le(0x0016, 2), ...value];
  const l2cap = [...le(attWrite.length, 2), ...le(0x0004, 2), ...attWrite]; // 4 + 23 = 27 bytes
  const frag1 = l2cap.slice(0, 15);
  const frag2 = l2cap.slice(15);

  const p1 = parseResponsePacket(buildSyntheticDataPacketList(2, frag1, { counter: 0 }));
  const p2 = parseResponsePacket(buildSyntheticDataPacketList(1, frag2, { counter: 1 }));

  let captured = null;
  const watcher = new AttWriteWatcher((w) => (captured = w));
  watcher.handleDataPacket(p1);
  if (captured) throw new Error("fired before the CONTINUATION fragment arrived");
  watcher.handleDataPacket(p2);

  assertEqual(captured.opcode, 0x12);
  assertEqual(captured.handle, 0x0016);
  assertEqual(captured.value, value);
});

test("AttWriteWatcher keeps master/slave fragment streams separate by direction", () => {
  const valueA = [0xaa, 0xaa];
  const valueB = [0xbb, 0xbb];
  const attA = [0x12, ...le(0x0010, 2), ...valueA];
  const attB = [0x12, ...le(0x0020, 2), ...valueB];
  const l2capA = [...le(attA.length, 2), ...le(0x0004, 2), ...attA];
  const l2capB = [...le(attB.length, 2), ...le(0x0004, 2), ...attB];

  const pA = parseResponsePacket(buildSyntheticDataPacketList(2, l2capA, { direction: false, counter: 0 }));
  const pB = parseResponsePacket(buildSyntheticDataPacketList(2, l2capB, { direction: true, counter: 1 }));

  const captured = [];
  const watcher = new AttWriteWatcher((w) => captured.push(w));
  watcher.handleDataPacket(pA);
  watcher.handleDataPacket(pB);

  assertEqual(captured.length, 2);
  assertEqual(captured[0].handle, 0x0010);
  assertEqual(captured[1].handle, 0x0020);
});

// --- Render ---

const out = document.getElementById("out");
const lines = results.map((r) => (r.pass ? `PASS  ${r.name}` : `FAIL  ${r.name}\n      ${r.error}`));
const passCount = results.filter((r) => r.pass).length;
lines.push("", `${passCount}/${results.length} passed`);
out.innerHTML = lines.map((l) => `<span class="${l.startsWith("FAIL") ? "fail" : l.startsWith("PASS") ? "pass" : ""}">${l}</span>`).join("\n");
console.log(lines.join("\n"));
