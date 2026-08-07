// SLIP framing for the nRF Sniffer UART protocol, ported byte-for-byte from
// SnifferAPI's Packet.py (encodeToSLIP / decodeFromSLIP). This variant uses
// an explicit START byte (not just END, unlike classic RFC 1055 SLIP), plus
// START/END/ESC escaping via a 2-byte escape sequence.
import { SLIP_START, SLIP_END, SLIP_ESC, SLIP_ESC_START, SLIP_ESC_END, SLIP_ESC_ESC } from "./types.mjs";

// byteList: number[] (unframed request bytes) -> Uint8Array (framed for the wire)
export function encodeSlip(byteList) {
  const out = [SLIP_START];
  for (const b of byteList) {
    if (b === SLIP_START) {
      out.push(SLIP_ESC, SLIP_ESC_START);
    } else if (b === SLIP_END) {
      out.push(SLIP_ESC, SLIP_ESC_END);
    } else if (b === SLIP_ESC) {
      out.push(SLIP_ESC, SLIP_ESC_ESC);
    } else {
      out.push(b);
    }
  }
  out.push(SLIP_END);
  return new Uint8Array(out);
}

// Incremental decoder: feed it raw serial bytes one at a time (or via
// pushBytes for a chunk), get complete decoded frames out via onFrame.
// Mirrors decodeFromSLIP's state machine, just restructured to be fed
// push-style instead of pulling from a blocking queue -- Web Serial hands us
// arbitrary-sized chunks, not one byte at a time on demand.
export class SlipDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this._reset();
  }

  _reset() {
    this._inPacket = false;
    this._pendingEsc = false;
    this._buffer = [];
  }

  pushBytes(chunk) {
    for (const b of chunk) this.pushByte(b);
  }

  pushByte(b) {
    if (!this._inPacket) {
      if (b === SLIP_START) {
        this._inPacket = true;
        this._buffer = [];
        this._pendingEsc = false;
      }
      // Bytes seen before the first START are discarded, same as
      // decodeFromSLIP's initial "while not startOfPacket" loop.
      return;
    }

    if (this._pendingEsc) {
      this._pendingEsc = false;
      if (b === SLIP_ESC_START) this._buffer.push(SLIP_START);
      else if (b === SLIP_ESC_END) this._buffer.push(SLIP_END);
      else if (b === SLIP_ESC_ESC) this._buffer.push(SLIP_ESC);
      // Matches the Python fallback for an unrecognized escape byte.
      else this._buffer.push(SLIP_END);
      return;
    }

    if (b === SLIP_END) {
      const frame = this._buffer;
      this._reset();
      this.onFrame(frame);
    } else if (b === SLIP_ESC) {
      this._pendingEsc = true;
    } else {
      this._buffer.push(b);
    }
  }
}
