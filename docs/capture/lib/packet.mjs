// UART request/response packet framing, ported from SnifferAPI's Packet.py
// (PacketReader.sendPacket / Packet.__init__ / Packet.readPayload / BlePacket).
import * as T from "./types.mjs";

function toLittleEndian(value, size) {
  const out = new Array(size).fill(0);
  for (let i = 0; i < size; i++) out[i] = (value >> (i * 8)) & 0xff;
  return out;
}

function parseLittleEndian(bytes) {
  let total = 0;
  for (let i = 0; i < bytes.length; i++) total += bytes[i] << (8 * i);
  return total >>> 0;
}

// Builds an unframed request byte list (still needs encodeSlip() before
// writing to the serial port). Requests always use the fixed v1-style
// 6-byte header, regardless of what protocol version the sniffer replies
// with -- this matches PacketReader.sendPacket exactly.
export function buildRequestPacket(id, payload, packetCounter) {
  return [T.HEADER_LENGTH, payload.length, T.PROTOVER_V1, ...toLittleEndian(packetCounter, 2), id, ...payload];
}

export function buildScanRequest(packetCounter, { findScanRsp = false, findAux = false, scanCoded = false } = {}) {
  const flags0 = (findScanRsp ? 1 : 0) | (findAux ? 2 : 0) | (scanCoded ? 4 : 0);
  return buildRequestPacket(T.REQ_SCAN_CONT, [flags0], packetCounter);
}

export function buildFollowRequest(packetCounter, address, { followOnlyAdvertisements = false, followOnlyLegacy = false, followCoded = false } = {}) {
  const flags0 = (followOnlyAdvertisements ? 1 : 0) | (followOnlyLegacy ? 2 : 0) | (followCoded ? 4 : 0);
  return buildRequestPacket(T.REQ_FOLLOW, [...address, flags0], packetCounter);
}

export function buildPingRequest(packetCounter) {
  return buildRequestPacket(T.PING_REQ, [], packetCounter);
}

export function buildSetTemporaryKey(packetCounter, tk16 = new Array(16).fill(0)) {
  return buildRequestPacket(T.SET_TEMPORARY_KEY, tk16, packetCounter);
}

// Parses one decoded (post-SLIP) response frame into a structured object.
// Returns null for frames that don't validate (mirrors Packet.valid=False).
export function parseResponsePacket(bytes) {
  if (!bytes || bytes.length < T.HEADER_LENGTH) return null;

  const protover = bytes[T.PROTOVER_POS];
  if (protover > 3) return null;

  const packetCounter = parseLittleEndian(bytes.slice(T.PACKETCOUNTER_POS, T.PACKETCOUNTER_POS + 2));
  const id = bytes[T.ID_POS];
  const payloadLength = protover === T.PROTOVER_V1 ? bytes[T.PAYLOAD_LEN_POS_V1] : parseLittleEndian(bytes.slice(T.PAYLOAD_LEN_POS, T.PAYLOAD_LEN_POS + 2));

  if (payloadLength + T.HEADER_LENGTH !== bytes.length) return null;

  const packet = { protover, packetCounter, id, payloadLength, valid: true, OK: false };

  if (id === T.EVENT_PACKET_ADV_PDU || id === T.EVENT_PACKET_DATA_PDU) {
    readBlePacket(packet, bytes);
  } else if (id === T.RESP_VERSION) {
    packet.version = String.fromCharCode(...bytes.slice(T.PAYLOAD_POS, T.PAYLOAD_POS + payloadLength));
  }
  // PING_RESP / RESP_TIMESTAMP / SWITCH_BAUD_RATE_* fields aren't needed for
  // capture -- skipped, unlike the full Python port.

  return packet;
}

function readBlePacket(packet, bytes) {
  const bleHeaderLength = bytes[T.BLE_HEADER_LEN_POS];
  if (bleHeaderLength !== T.BLE_HEADER_LENGTH) return; // packet.OK stays false

  const flags = bytes[T.FLAGS_POS];
  packet.crcOK = !!(flags & 1);
  packet.direction = !!(flags & 2);
  packet.encrypted = !!(flags & 4);
  packet.micOK = !!(flags & 8);
  packet.phy = (flags >> 4) & 7;
  packet.OK = packet.crcOK && (packet.micOK || !packet.encrypted);

  packet.channel = bytes[T.CHANNEL_POS];
  packet.rawRSSI = bytes[T.RSSI_POS];
  packet.RSSI = -packet.rawRSSI;
  packet.eventCounter = parseLittleEndian(bytes.slice(T.EVENTCOUNTER_POS, T.EVENTCOUNTER_POS + 2));
  packet.timestamp = parseLittleEndian(bytes.slice(T.TIMESTAMP_POS, T.TIMESTAMP_POS + 4));

  if (!packet.OK) return;

  // The hardware adds one padding byte that isn't actually sent over the
  // air; splice it out before parsing the BLE packet itself. Its position
  // depends on PHY (LE Coded has an extra coding-indicator byte first).
  const paddingOffset = packet.phy === T.PHY_CODED ? 7 : 6;
  const rawBle = bytes.slice(T.BLEPACKET_POS);
  const bleBytes = [...rawBle.slice(0, paddingOffset), ...rawBle.slice(paddingOffset + 1)];

  const packetType = packet.id === T.EVENT_PACKET_ADV_PDU ? T.PACKET_TYPE_ADVERTISING : T.PACKET_TYPE_DATA;
  packet.blePacket = parseBlePacket(packetType, bleBytes, packet.phy);
}

function parseBlePacket(type, bytes, phy) {
  const ble = { type };
  let offset = 0;

  ble.accessAddress = bytes.slice(offset, offset + 4);
  offset += 4;

  if (phy === T.PHY_CODED) {
    ble.codingIndicator = bytes[offset] & 3;
    offset += 1;
  }

  if (type === T.PACKET_TYPE_ADVERTISING) {
    const h = bytes[offset];
    ble.advType = h & 15;
    ble.txAddrType = (h >> 6) & 1;
    if ([1, 3, 5].includes(ble.advType)) {
      // Ported as-is from BlePacket.extractAdvHeader -- this looks like it
      // should be a right-shift, but this is Nordic's actual reference
      // implementation, so it's kept faithful rather than "fixed".
      ble.rxAddrType = (h << 7) & 1;
    }
    offset += 1;
  } else {
    const h = bytes[offset];
    ble.llid = h & 3;
    ble.sn = (h >> 2) & 1;
    ble.nesn = (h >> 3) & 1;
    ble.md = (h >> 4) & 1;
    offset += 1;
  }

  ble.length = bytes[offset];
  offset += 1;

  ble.payload = bytes.slice(offset);

  if (type === T.PACKET_TYPE_ADVERTISING) {
    offset = extractAddresses(ble, bytes, offset);
    extractName(ble, bytes, offset);
  }

  return ble;
}

function reverseBytes(arr) {
  return arr.slice().reverse();
}

function extractAddresses(ble, bytes, offset) {
  let addr = null;
  let scanAddr = null;

  if ([0, 1, 2, 4, 6].includes(ble.advType)) {
    addr = [...reverseBytes(bytes.slice(offset, offset + 6)), ble.txAddrType];
    offset += 6;
  }

  if ([3, 5].includes(ble.advType)) {
    scanAddr = [...reverseBytes(bytes.slice(offset, offset + 6)), ble.txAddrType];
    offset += 6;
    addr = [...reverseBytes(bytes.slice(offset, offset + 6)), ble.rxAddrType];
    offset += 6;
  }

  if (ble.advType === 1) {
    scanAddr = [...reverseBytes(bytes.slice(offset, offset + 6)), ble.rxAddrType];
    offset += 6;
  }

  if (ble.advType === 7) {
    const extHeaderLen = bytes[offset] & 0x3f;
    offset += 1;
    let extOffset = offset;
    const flags = bytes[extOffset];
    extOffset += 1;
    if (flags & 0x01) {
      addr = [...reverseBytes(bytes.slice(extOffset, extOffset + 6)), ble.txAddrType];
      extOffset += 6;
    }
    if (flags & 0x02) {
      scanAddr = [...reverseBytes(bytes.slice(extOffset, extOffset + 6)), ble.rxAddrType];
      extOffset += 6;
    }
    offset += extHeaderLen;
  }

  ble.advAddress = addr;
  ble.scanAddress = scanAddr;
  return offset;
}

function extractName(ble, bytes, offset) {
  let name = "";
  if ([0, 2, 4, 6, 7].includes(ble.advType)) {
    let i = offset;
    while (i < bytes.length) {
      const length = bytes[i];
      if (i + length + 1 > bytes.length || length === 0) break;
      const adType = bytes[i + 1];
      if (adType === 8 || adType === 9) {
        name = String.fromCharCode(...bytes.slice(i + 2, i + length + 1));
      }
      i += length + 1;
    }
    // Nordic wraps the name in literal quote characters, including for an
    // empty name (`""`, a 2-char sentinel string, not an empty string) --
    // Devices.py relies on that exact sentinel to detect "no name yet".
    name = `"${name}"`;
  } else if (ble.advType === 1) {
    name = "[ADV_DIRECT_IND]";
  }
  ble.name = name;
}

export function addressToString(address) {
  // address is [b0..b5, addrType] in on-air (already-reversed-to-natural) order.
  return address
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}
