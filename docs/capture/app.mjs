import { WebSerialSniffer } from "./lib/sniffer.mjs";
import { isFlashSupported, pickFirmwareFile, flashFirmware } from "./lib/flash.mjs";

// ---- Screen navigation ----

const screens = ["welcome", "flash", "capture", "export"];
const visited = new Set(["welcome"]);
let currentScreen = "welcome";

function showScreen(name) {
  currentScreen = name;
  visited.add(name);
  for (const s of screens) {
    document.getElementById(`screen-${s}`).classList.toggle("active", s === name);
  }
  for (const btn of document.querySelectorAll(".step")) {
    const target = btn.dataset.screen;
    btn.classList.toggle("active", target === name);
    btn.classList.toggle("done", target !== name && visited.has(target));
  }
}

document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => showScreen(el.dataset.goto));
});
document.querySelectorAll(".step").forEach((el) => {
  el.addEventListener("click", () => showScreen(el.dataset.screen));
});

// ---- Welcome: browser support check ----

const supportEl = document.getElementById("support-check");
const hasSerial = "serial" in navigator;
const hasFsAccess = "showDirectoryPicker" in window;
if (hasSerial && hasFsAccess) {
  supportEl.textContent = "Your browser supports everything this tool needs.";
  supportEl.className = "callout ok";
} else if (hasSerial && !hasFsAccess) {
  supportEl.textContent =
    "Capture will work, but Flash won't: your browser doesn't expose the File System Access API. This is common in Brave, which disables it by default for privacy -- Chromium and Chrome/Edge have it on. If your dongle's already flashed (from a previous manual setup), this doesn't matter at all -- just skip straight to Capture below.";
  supportEl.className = "callout warn";
} else {
  const missing = [];
  if (!hasSerial) missing.push("Web Serial (navigator.serial)");
  if (!hasFsAccess) missing.push("File System Access (for flashing)");
  supportEl.textContent = `Your browser is missing: ${missing.join(", ")}. Web Serial in particular is required for both Flash and Capture -- try Chrome, Edge, or Chromium instead (Brave's support varies).`;
  supportEl.className = "callout error";
}

// ---- Flash screen ----

let pickedFirmware = null;

const pickFirmwareBtn = document.getElementById("pick-firmware-btn");
const pickDriveBtn = document.getElementById("pick-drive-btn");
const firmwarePickedLabel = document.getElementById("firmware-picked");
const flashLogEl = document.getElementById("flash-log");

function flashLog(msg) {
  flashLogEl.hidden = false;
  flashLogEl.textContent += `${msg}\n`;
  flashLogEl.scrollTop = flashLogEl.scrollHeight;
}

if (!hasFsAccess) {
  pickFirmwareBtn.disabled = true;
  pickFirmwareBtn.title = "Your browser doesn't support the File System Access API.";
}

pickFirmwareBtn.addEventListener("click", async () => {
  try {
    const { file } = await pickFirmwareFile();
    pickedFirmware = file;
    firmwarePickedLabel.textContent = `Picked: ${file.name}`;
    pickDriveBtn.disabled = false;
  } catch (e) {
    if (e.name !== "AbortError") flashLog(`Couldn't read that file: ${e.message}`);
  }
});

pickDriveBtn.addEventListener("click", async () => {
  if (!pickedFirmware) return;
  pickDriveBtn.disabled = true;
  try {
    await flashFirmware(pickedFirmware, { onLog: flashLog });
  } catch (e) {
    if (e.name !== "AbortError") flashLog(`Flash failed: ${e.message}`);
  } finally {
    pickDriveBtn.disabled = false;
  }
});

// ---- Capture screen ----

const connectBtn = document.getElementById("connect-btn");
const scanBtn = document.getElementById("scan-btn");
const captureDisconnectBtn = document.getElementById("capture-disconnect-btn");
const deviceListEl = document.getElementById("device-list");
const captureLogEl = document.getElementById("capture-log");

function captureLog(msg) {
  const time = new Date().toLocaleTimeString();
  captureLogEl.textContent += `${time}  ${msg}\n`;
  captureLogEl.scrollTop = captureLogEl.scrollHeight;
}

function isOwDevice(name) {
  const bare = name.replace(/^"|"$/g, "");
  return bare.toLowerCase().startsWith("ow");
}

const deviceCards = new Map(); // addressString -> { device, el }
let capturedHandshake = null;

let sniffer = null;
if (hasSerial) {
  sniffer = new WebSerialSniffer({
    onLog: captureLog,
    onDevice: (device) => {
      if (!isOwDevice(device.name) || deviceCards.has(device.addressString)) return;
      captureLog(`Found ${device.name.replace(/^"|"$/g, "")} @ ${device.addressString} (RSSI ${device.rssi})`);
      addDeviceCard(device);
    },
    onConnect: () => {
      captureLog("Connection detected -- watching for the unlock write...");
      for (const { el } of deviceCards.values()) el.classList.toggle("connected", el.classList.contains("following"));
    },
    onDisconnect: () => {
      captureLog("Connection ended.");
      for (const { el } of deviceCards.values()) el.classList.remove("connected");
    },
    onHandshake: ({ opcode, handle, value }) => {
      const opcodeName = opcode === 0x12 ? "Write Request" : "Write Command";
      captureLog(`ATT ${opcodeName} at handle 0x${handle.toString(16).padStart(4, "0")}, ${value.length} bytes: ${toHex(value)}`);
      if (value.length === 20) {
        capturedHandshake = value;
        showHandshake(value);
        showScreen("export");
      }
    },
  });
} else {
  connectBtn.disabled = true;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function addDeviceCard(device) {
  const card = document.createElement("div");
  card.className = "device-card";
  card.innerHTML = `
    <div>
      <div class="name">${device.name.replace(/^"|"$/g, "")}</div>
      <div class="meta">${device.addressString} -- RSSI ${device.rssi}</div>
    </div>
    <button class="primary follow-btn">Follow</button>
  `;
  card.querySelector(".follow-btn").addEventListener("click", async () => {
    for (const { el } of deviceCards.values()) el.classList.remove("following");
    card.classList.add("following");
    await sniffer.follow(device);
    captureLog("Open the official Onewheel app on your phone now and let it connect.");
  });
  deviceListEl.appendChild(card);
  deviceCards.set(device.addressString, { device, el: card });
}

connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  try {
    await sniffer.connect();
    scanBtn.disabled = false;
    captureDisconnectBtn.disabled = false;
  } catch (e) {
    if (e.name !== "NotFoundError") captureLog(`Connect failed: ${e.message}`);
    connectBtn.disabled = false;
  }
});

scanBtn.addEventListener("click", async () => {
  deviceCards.clear();
  deviceListEl.innerHTML = "";
  await sniffer.scan();
});

captureDisconnectBtn.addEventListener("click", async () => {
  await sniffer.disconnect();
  connectBtn.disabled = false;
  scanBtn.disabled = true;
  captureDisconnectBtn.disabled = true;
  captureLog("Disconnected from dongle.");
});

// ---- Export screen ----

const handshakeHexEl = document.getElementById("handshake-hex");
const copyHexBtn = document.getElementById("copy-hex-btn");
const downloadBtn = document.getElementById("download-btn");

function showHandshake(bytes) {
  handshakeHexEl.textContent = toHex(bytes);
}

copyHexBtn.addEventListener("click", async () => {
  if (!capturedHandshake) return;
  await navigator.clipboard.writeText(toHex(capturedHandshake));
  const original = copyHexBtn.textContent;
  copyHexBtn.textContent = "Copied!";
  setTimeout(() => (copyHexBtn.textContent = original), 1500);
});

downloadBtn.addEventListener("click", () => {
  if (!capturedHandshake) return;
  const lines = [];
  for (let i = 0; i < capturedHandshake.length; i += 10) {
    const chunk = [...capturedHandshake.slice(i, i + 10)].map((b) => `0x${b.toString(16).padStart(2, "0")}`);
    lines.push(`        ${chunk.join(", ")}`);
  }
  const content = `// Captured with the Floatface handshake capture tool -- this value is
// specific to YOUR board (and possibly the FutureMotion account it was
// captured from). See PROTOCOL.md for why it can't be derived or shared.
module OnewheelProfile {
    const UNLOCK_RESPONSE = [
${lines.join(",\n")}
    ]b;
}
`;
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "LocalConfig.mc";
  a.click();
  URL.revokeObjectURL(url);
});

if (!hasFsAccess) {
  // Flashing is unavailable, but capture (Web Serial only) still might work.
}

showScreen("welcome");
