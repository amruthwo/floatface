// L2CAP reassembly + ATT PDU extraction from a followed connection's data
// channel. This has no Python equivalent to port -- SnifferAPI just writes
// raw packets to a pcap file and leaves ATT decoding to Wireshark/tshark,
// which capture_handshake.py then shells out to. The browser has no tshark,
// so this does the equivalent parsing directly against the BlePacket stream
// packet.mjs already decodes.
import * as T from "./types.mjs";

function parseLittleEndian16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

// Reassembles LL Data PDUs (llid START then zero or more CONTINUATIONs) into
// complete L2CAP SDUs, one instance per link-layer direction so master- and
// slave-originated fragments never mix.
class L2capReassembler {
  constructor() {
    this._buffer = null; // number[] | null
    this._expectedLength = 0; // L2CAP "Length" field
    this._cid = null;
  }

  reset() {
    this._buffer = null;
    this._expectedLength = 0;
    this._cid = null;
  }

  // ble: a parsed BlePacket (type DATA) from packet.mjs. Returns a complete
  // { cid, sdu } once fully reassembled, else null.
  push(ble) {
    if (ble.llid === T.LLID_START) {
      if (ble.payload.length < 4) {
        this.reset();
        return null;
      }
      this._expectedLength = parseLittleEndian16(ble.payload, 0);
      this._cid = parseLittleEndian16(ble.payload, 2);
      this._buffer = ble.payload.slice(4);
    } else if (ble.llid === T.LLID_CONTINUATION) {
      if (this._buffer === null) return null; // continuation with no start seen yet
      this._buffer.push(...ble.payload);
    } else {
      // LL Control PDU -- not an L2CAP fragment, ignore.
      return null;
    }

    if (this._buffer !== null && this._buffer.length >= this._expectedLength) {
      const sdu = this._buffer.slice(0, this._expectedLength);
      const cid = this._cid;
      this.reset();
      return { cid, sdu };
    }
    return null;
  }
}

// Tracks ATT traffic across a single BLE connection (both directions) and
// reports every ATT Write Request/Command it sees. Reset on each new
// connection (EVENT_CONNECT), since fragment state from a prior connection
// is meaningless.
export class AttWriteWatcher {
  constructor(onWrite) {
    this.onWrite = onWrite;
    this._byDirection = new Map();
  }

  reset() {
    this._byDirection.clear();
  }

  // packet: a parsed response packet (from packet.mjs) with id ===
  // EVENT_PACKET_DATA_PDU and OK blePacket present.
  handleDataPacket(packet) {
    const ble = packet.blePacket;
    if (!ble || ble.type !== T.PACKET_TYPE_DATA) return;

    const key = packet.direction ? 1 : 0;
    let reassembler = this._byDirection.get(key);
    if (!reassembler) {
      reassembler = new L2capReassembler();
      this._byDirection.set(key, reassembler);
    }

    const complete = reassembler.push(ble);
    if (!complete || complete.cid !== T.L2CAP_CID_ATT) return;

    const att = complete.sdu;
    if (att.length < 1) return;
    const opcode = att[0];
    if (opcode !== T.ATT_OPCODE_WRITE_REQUEST && opcode !== T.ATT_OPCODE_WRITE_COMMAND) return;
    if (att.length < 3) return;

    const handle = att[1] | (att[2] << 8);
    const value = att.slice(3);
    this.onWrite({ opcode, handle, value });
  }
}
