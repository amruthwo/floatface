// Minimal live-test harness for the JS port -- the JS equivalent of
// capture_handshake.py's role: prove the ported protocol works against real
// hardware before any polished UI gets built on top of it. Deliberately
// bare: a connect button, a device list, a log, and a result panel.
import { WebSerialSniffer } from "./sniffer.mjs";

const connectBtn = document.getElementById("connectBtn");
const scanBtn = document.getElementById("scanBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const devicesEl = document.getElementById("devices");
const logEl = document.getElementById("log");
const resultEl = document.getElementById("result");

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `${time}  ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function isOwDevice(name) {
  // name arrives as Nordic's quoted sentinel, e.g. '"ow123456"' or '""'.
  const bare = name.replace(/^"|"$/g, "");
  return bare.toLowerCase().startsWith("ow");
}

const seenDevices = new Set();

const sniffer = new WebSerialSniffer({
  onLog: log,
  onDevice: (device) => {
    if (!isOwDevice(device.name) || seenDevices.has(device.addressString)) return;
    seenDevices.add(device.addressString);
    log(`Found ${device.name} @ ${device.addressString} (RSSI ${device.rssi})`);
    addDeviceRow(device);
  },
  onConnect: () => log("Connection detected -- watching for the unlock write..."),
  onDisconnect: () => log("Connection ended."),
  onHandshake: ({ opcode, handle, value }) => {
    const opcodeName = opcode === 0x12 ? "Write Request" : "Write Command";
    log(`ATT ${opcodeName} at handle 0x${handle.toString(16).padStart(4, "0")}, ${value.length} bytes: ${toHex(value)}`);
    if (value.length === 20) showResult(value);
  },
});

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function addDeviceRow(device) {
  const row = document.createElement("div");
  row.className = "device";
  const label = document.createElement("span");
  label.textContent = `${device.name} — ${device.addressString}`;
  const followBtn = document.createElement("button");
  followBtn.textContent = "Follow";
  followBtn.onclick = async () => {
    followBtn.disabled = true;
    await sniffer.follow(device);
    log("Open the official Onewheel app on your phone now and let it connect.");
  };
  row.append(label, followBtn);
  devicesEl.appendChild(row);
}

function showResult(handshake) {
  const hexBytes = [...handshake].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ");
  resultEl.textContent = `Handshake: ${toHex(handshake)}\n\nmodule OnewheelProfile {\n    const UNLOCK_RESPONSE = [\n        ${hexBytes}\n    ]b;\n}`;
  resultEl.classList.add("visible");
}

connectBtn.onclick = async () => {
  connectBtn.disabled = true;
  try {
    await sniffer.connect();
    scanBtn.disabled = false;
    disconnectBtn.disabled = false;
  } catch (e) {
    log(`Connect failed: ${e.message}`);
    connectBtn.disabled = false;
  }
};

scanBtn.onclick = async () => {
  seenDevices.clear();
  devicesEl.innerHTML = "";
  await sniffer.scan();
};

disconnectBtn.onclick = async () => {
  await sniffer.disconnect();
  connectBtn.disabled = false;
  scanBtn.disabled = true;
  disconnectBtn.disabled = true;
  log("Disconnected from dongle.");
};
