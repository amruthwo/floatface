// Browser-side orchestrator tying together slip.mjs/packet.mjs/att.mjs/
// devices.mjs over the Web Serial API. This is the JS equivalent of
// SnifferAPI's Sniffer + SnifferCollector + UART.Uart combined -- ported for
// a single specific use case (find an "ow*" board, follow it, catch the
// unlock handshake write) rather than as a general-purpose library.
//
// Requires a Chromium browser (Web Serial: navigator.serial) and a secure
// context (https, or http://localhost).
import * as T from "./types.mjs";
import { encodeSlip, SlipDecoder } from "./slip.mjs";
import { buildScanRequest, buildFollowRequest, buildSetTemporaryKey, parseResponsePacket, addressToString } from "./packet.mjs";
import { DeviceList } from "./devices.mjs";
import { AttWriteWatcher } from "./att.mjs";

const BAUD_RATE = 1000000;

// Nordic's own USB vendor/product ID for the nRF Sniffer for Bluetooth LE
// firmware (confirmed via `lsusb`: "1915:522a Nordic Semiconductor ASA nRF
// Sniffer for Bluetooth LE") -- passed to requestPort() so the browser's
// port picker only lists the dongle, not every other paired serial/
// Bluetooth device on the system.
const NORDIC_SNIFFER_USB_FILTER = { usbVendorId: 0x1915, usbProductId: 0x522a };

export const STATE_IDLE = "idle";
export const STATE_SCANNING = "scanning";
export const STATE_FOLLOWING = "following";

export class WebSerialSniffer {
  constructor({ onLog = () => {}, onDevice = () => {}, onConnect = () => {}, onDisconnect = () => {}, onHandshake = () => {} } = {}) {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial isn't available -- use Chrome, Edge, or another Chromium browser.");
    }
    this.onLog = onLog;
    this.onDevice = onDevice;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.onHandshake = onHandshake;

    this.state = STATE_IDLE;
    this.inConnection = false;
    this.devices = new DeviceList();
    this._followedDevice = null;

    this._port = null;
    this._reader = null;
    this._writer = null;
    this._readLoopPromise = null;
    this._packetCounter = 0;
    this._decoder = new SlipDecoder((frame) => this._handleFrame(frame));
    this._attWatcher = new AttWriteWatcher((write) => this._handleAttWrite(write));
    this._throttleState = new Map(); // key -> { count, lastLogged }
  }

  // Logs the first occurrence of `key` immediately, then at most once/2s
  // after that (with a running count) -- keeps noisy repeated packet types
  // (e.g. continued advertising, bad-CRC data PDUs) visible without
  // flooding the log.
  _throttledLog(key, message) {
    const now = performance.now();
    const state = this._throttleState.get(key);
    if (!state) {
      this._throttleState.set(key, { count: 1, lastLogged: now });
      this.onLog(message);
      return;
    }
    state.count += 1;
    if (now - state.lastLogged > 2000) {
      state.lastLogged = now;
      this.onLog(`${message} (x${state.count} so far)`);
    }
  }

  async connect() {
    this._port = await navigator.serial.requestPort({ filters: [NORDIC_SNIFFER_USB_FILTER] });
    await this._port.open({ baudRate: BAUD_RATE, flowControl: "hardware" });
    this._writer = this._port.writable.getWriter();
    this._readLoopPromise = this._readLoop();
    this.onLog(`Connected at ${BAUD_RATE} baud.`);
  }

  async disconnect() {
    if (this._reader) {
      await this._reader.cancel().catch(() => {});
    }
    if (this._readLoopPromise) await this._readLoopPromise.catch(() => {});
    if (this._writer) {
      this._writer.releaseLock();
      this._writer = null;
    }
    if (this._port) {
      await this._port.close().catch(() => {});
      this._port = null;
    }
    this.state = STATE_IDLE;
  }

  async _readLoop() {
    this._reader = this._port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value) this._decoder.pushBytes(value);
      }
    } catch (e) {
      this.onLog(`Serial read error: ${e.message}`);
    } finally {
      this._reader.releaseLock();
      this._reader = null;
    }
  }

  async _send(byteList) {
    const framed = encodeSlip(byteList);
    await this._writer.write(framed);
    this._packetCounter = (this._packetCounter + 1) % 65536;
  }

  async scan() {
    this.devices.clear();
    this._followedDevice = null;
    this.state = STATE_SCANNING;
    await this._send(buildScanRequest(this._packetCounter));
    // Matches SnifferCollector._startScanning, which also resets the TK --
    // irrelevant for this unencrypted board, kept for protocol parity.
    await this._send(buildSetTemporaryKey(this._packetCounter));
    this.onLog("Scanning...");
  }

  async follow(device) {
    this.state = STATE_FOLLOWING;
    this._followedDevice = device;
    this._attWatcher.reset();
    this._throttleState.clear();
    await this._send(buildFollowRequest(this._packetCounter, device.address));
    this.onLog(`Following ${device.name} @ ${device.addressString}...`);
  }

  _handleFrame(frame) {
    const packet = parseResponsePacket(frame);
    if (!packet) {
      this._throttledLog("unparseable", `Unparseable frame (${frame.length} bytes): ${frame.slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
      return;
    }

    if (packet.id === T.EVENT_PACKET_ADV_PDU) {
      this._handleAdvPacket(packet);
      // The dongle keeps relaying ADV_PDU sightings for *any* nearby BLE
      // device while following, not just the target -- without this check,
      // a followed board that's gone quiet (e.g. because it's already
      // connected to your phone, which is exactly what following is
      // waiting to see) gets misreported as "still advertising" using
      // someone else's headphones or smart device as evidence.
      const isFollowedDevice = this.state === STATE_FOLLOWING && packet.OK && packet.blePacket?.advAddress && this._followedDevice && addressToString(packet.blePacket.advAddress) === this._followedDevice.addressString;
      if (isFollowedDevice) {
        if (packet.blePacket.advType === 5) this.onLog("Saw a CONNECT_REQ for this device -- it should be connecting now.");
        else this._throttledLog("still-advertising", "Still seeing this board advertise (not connected yet)...");
      }
    } else if (packet.id === T.EVENT_PACKET_DATA_PDU) {
      if (packet.OK) this._attWatcher.handleDataPacket(packet);
      else this._throttledLog("bad-data-pdu", "Data PDU(s) with a bad CRC/MIC arrived -- connection sync may be shaky.");
    } else if (packet.id === T.EVENT_FOLLOW) {
      this.onLog("Follow request acknowledged by the dongle.");
    } else if (packet.id === T.EVENT_CONNECT) {
      this.inConnection = true;
      this._attWatcher.reset();
      this.onConnect();
    } else if (packet.id === T.EVENT_DISCONNECT) {
      this.inConnection = false;
      this.onDisconnect();
    } else {
      this._throttledLog(`id-${packet.id}`, `Unhandled packet id 0x${packet.id.toString(16)}.`);
    }
  }

  _handleAdvPacket(packet) {
    if (this.state !== STATE_SCANNING) return;
    if (!packet.OK || !packet.blePacket) return;
    const ble = packet.blePacket;
    if (![0, 1, 2, 4, 6, 7].includes(ble.advType)) return;
    if (!ble.advAddress) return;
    if (packet.direction) return; // matches SnifferCollector: `not packet.direction`

    const device = this.devices.appendOrUpdate(ble.advAddress, ble.name, packet.RSSI);
    this.onDevice(device);
  }

  _handleAttWrite({ opcode, handle, value }) {
    this.onHandshake({ opcode, handle, value });
  }
}

export { addressToString };
