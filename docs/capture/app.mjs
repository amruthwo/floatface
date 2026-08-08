import { WebSerialSniffer } from "./lib/sniffer.mjs";
import { isFlashSupported, pickFirmwareFile, fetchBundledFirmware, flashFirmware } from "./lib/flash.mjs";

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

const flashBundledBtn = document.getElementById("flash-bundled-btn");
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
  flashBundledBtn.disabled = true;
  flashBundledBtn.title = "Your browser doesn't support the File System Access API.";
  pickFirmwareBtn.disabled = true;
  pickFirmwareBtn.title = "Your browser doesn't support the File System Access API.";
}

flashBundledBtn.addEventListener("click", async () => {
  flashBundledBtn.disabled = true;
  try {
    const firmware = await fetchBundledFirmware();
    await flashFirmware(firmware, { onLog: flashLog });
  } catch (e) {
    if (e.name !== "AbortError") flashLog(`Flash failed: ${e.message}`);
  } finally {
    flashBundledBtn.disabled = false;
  }
});

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
//
// Friendly guided flow: one Start button chains connect -> scan -> follow
// (the first ow* board found -- if you have more than one nearby, that's an
// edge case this simple flow doesn't handle; use the debug harness for
// that). The full technical event stream still gets logged, but tucked
// under a <details> instead of being the primary UI, per user feedback that
// normal users don't want to read console-style output -- they want a
// plain-language status and a way to export the technical log if they need
// to ask for help.

const startBtn = document.getElementById("start-btn");
const resetBtn = document.getElementById("capture-reset-btn");
const statusIconEl = document.getElementById("status-icon");
const statusHeadlineEl = document.getElementById("status-headline");
const statusSubtextEl = document.getElementById("status-subtext");
const tipsEl = document.getElementById("capture-tips");
const captureLogEl = document.getElementById("capture-log");
const downloadLogBtn = document.getElementById("download-log-btn");

let captureLogText = "";
function captureLog(msg) {
  const time = new Date().toLocaleTimeString();
  captureLogText += `${time}  ${msg}\n`;
  captureLogEl.textContent = captureLogText;
  captureLogEl.scrollTop = captureLogEl.scrollHeight;
}

function isOwDevice(name) {
  const bare = name.replace(/^"|"$/g, "");
  return bare.toLowerCase().startsWith("ow");
}

function setStatus(icon, headline, subtext) {
  statusIconEl.textContent = icon;
  statusHeadlineEl.textContent = headline;
  statusSubtextEl.textContent = subtext;
}

let stuckTimer = null;
function clearStuckTimer() {
  if (stuckTimer) {
    clearTimeout(stuckTimer);
    stuckTimer = null;
  }
}
function armStuckTimer(delayMs, icon, headline, subtext) {
  clearStuckTimer();
  stuckTimer = setTimeout(() => {
    setStatus(icon, headline, subtext);
    tipsEl.hidden = false;
  }, delayMs);
}

let capturedHandshake = null;
let followedDevice = null;
let captureActive = false;

let sniffer = null;
if (hasSerial) {
  sniffer = new WebSerialSniffer({
    onLog: captureLog,
    onDevice: (device) => {
      if (!isOwDevice(device.name)) return;
      captureLog(`Found ${device.name.replace(/^"|"$/g, "")} @ ${device.addressString} (RSSI ${device.rssi})`);
      if (followedDevice) return; // already following one -- see note above
      followedDevice = device;
      const bareName = device.name.replace(/^"|"$/g, "");
      setStatus("\u{1F4F6}", `Found ${bareName}!`, "Open the official Onewheel app on your phone now and let it connect.");
      armStuckTimer(20000, "\u{1F914}", "Still watching...", "Haven't seen a connection attempt yet. Make sure the Onewheel app is open and trying to connect.");
      sniffer.follow(device);
    },
    onConnect: () => {
      captureLog("Connection detected -- watching for the unlock write...");
      setStatus("\u{1F517}", "Connected! Watching for the unlock signal...", "Keep the Onewheel app open on your phone.");
      armStuckTimer(15000, "\u{1F914}", "Connected, but no unlock signal yet...", "This is usually quick. See the tips below if it doesn't show up soon.");
    },
    onDisconnect: () => {
      captureLog("Connection ended.");
      if (!captureActive) return;
      setStatus("\u{1F501}", "Connection dropped -- that's normal for BLE.", "Still watching in case your board reconnects. Try reconnecting the Onewheel app if this keeps happening.");
      armStuckTimer(20000, "\u{1F914}", "Still watching...", "See the tips below for things that help.");
    },
    onHandshake: ({ opcode, handle, value }) => {
      const opcodeName = opcode === 0x12 ? "Write Request" : "Write Command";
      captureLog(`ATT ${opcodeName} at handle 0x${handle.toString(16).padStart(4, "0")}, ${value.length} bytes: ${toHex(value)}`);
      if (value.length === 20) {
        clearStuckTimer();
        captureActive = false;
        capturedHandshake = value;
        setStatus("✅", "Got it!", "Taking you to your handshake now...");
        showHandshake(value);
        setTimeout(() => showScreen("export"), 600);
      }
    },
  });
} else {
  startBtn.disabled = true;
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

async function startCapture() {
  captureActive = true;
  followedDevice = null;
  startBtn.disabled = true;
  resetBtn.hidden = false;
  tipsEl.hidden = true;
  setStatus("\u{1F50C}", "Connecting to your dongle...", "Pick it from the browser's port list if you're prompted.");
  try {
    await sniffer.connect();
    setStatus("\u{1F50D}", "Looking for your board...", "Make sure it's powered on and nearby.");
    await sniffer.scan();
    armStuckTimer(15000, "\u{1F914}", "Still looking...", "Make sure your board is powered on and the dongle is within a few feet of it.");
  } catch (e) {
    if (e.name !== "NotFoundError") {
      setStatus("⚠️", "Couldn't connect to the dongle.", e.message);
    }
    endCapture();
  }
}

function endCapture() {
  captureActive = false;
  clearStuckTimer();
  startBtn.disabled = false;
}

startBtn.addEventListener("click", startCapture);

resetBtn.addEventListener("click", async () => {
  endCapture();
  resetBtn.hidden = true;
  tipsEl.hidden = true;
  await sniffer.disconnect();
  captureLog("Disconnected from dongle.");
  setStatus("\u{1F6F9}", "Ready when you are.", "Check the boxes above, then tap \"Start capture.\"");
});

downloadLogBtn.addEventListener("click", () => {
  const blob = new Blob([captureLogText || "(empty -- nothing captured yet)\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `floatface-capture-debug-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
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
