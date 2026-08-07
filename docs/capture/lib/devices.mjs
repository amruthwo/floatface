// Minimal port of Devices.py's DeviceList.appendOrUpdate -- just enough to
// aggregate ADV_IND/SCAN_RSP sightings into a deduped, named device list.
import { addressToString } from "./packet.mjs";

export class DeviceList {
  constructor() {
    this._byAddress = new Map();
  }

  clear() {
    this._byAddress.clear();
  }

  asList() {
    return [...this._byAddress.values()];
  }

  // advAddress: [b0..b5, addrType] as produced by packet.mjs; name: string; rssi: number
  appendOrUpdate(advAddress, name, rssi) {
    const key = addressToString(advAddress);
    const existing = this._byAddress.get(key);
    if (!existing) {
      const device = { address: advAddress, addressString: key, name, rssi };
      this._byAddress.set(key, device);
      return device;
    }
    if (name && name !== '""' && (!existing.name || existing.name === '""')) {
      existing.name = name;
    }
    existing.rssi = rssi;
    return existing;
  }
}
