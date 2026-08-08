// Firmware flashing via the File System Access API. The dongle's UF2
// bootloader (Adafruit's, not Nordic's DFU -- see project notes) mounts as
// an ordinary USB drive labeled UF2BOOT; copying a .uf2 file onto it is all
// flashing requires; the bootloader does the rest and reboots into the new
// firmware on its own.
//
// Nordic's official nRF Sniffer for Bluetooth LE firmware (v4.1.1),
// pre-converted to .uf2 for the Makerdiary nRF52840-MDK dongle, is bundled
// alongside this tool -- see ./firmware/NOTICE.md for license terms and
// provenance. Advanced users with a different nRF52840 dongle can still
// pick their own .uf2 file instead (pickFirmwareFile below).
export const BUNDLED_FIRMWARE_URL = "./firmware/nrf-sniffer-ble_v4.1.1_makerdiary-nrf52840-mdk.uf2";
export const BUNDLED_FIRMWARE_NAME = "nrf-sniffer-ble_v4.1.1_makerdiary-nrf52840-mdk.uf2";

export async function isFlashSupported() {
  return "showDirectoryPicker" in window;
}

export async function fetchBundledFirmware() {
  const response = await fetch(BUNDLED_FIRMWARE_URL);
  if (!response.ok) throw new Error(`Couldn't load the bundled firmware (HTTP ${response.status}).`);
  const blob = await response.blob();
  return new File([blob], BUNDLED_FIRMWARE_NAME, { type: "application/octet-stream" });
}

// Returns { name } of the picked firmware file's info, or throws if the
// user cancels the picker (AbortError) or picks something invalid.
export async function pickFirmwareFile() {
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: "UF2 firmware", accept: { "application/octet-stream": [".uf2"] } }],
    excludeAcceptAllOption: false,
  });
  const file = await handle.getFile();
  return { handle, file };
}

// Lets the user pick the dongle's mounted UF2BOOT drive and writes the
// given firmware file onto it. Throws if the picked directory doesn't look
// like a UF2 bootloader drive (missing INFO_UF2.TXT) -- a real UF2BOOT
// drive always has one, so this catches "wrong drive picked" early instead
// of silently writing a .uf2 file into some unrelated folder.
export async function flashFirmware(firmwareFile, { onLog = () => {} } = {}) {
  const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });

  let looksLikeUf2Drive = false;
  for await (const name of dirHandle.keys()) {
    if (name.toUpperCase() === "INFO_UF2.TXT") {
      looksLikeUf2Drive = true;
      break;
    }
  }
  if (!looksLikeUf2Drive) {
    throw new Error(`"${dirHandle.name}" doesn't look like a UF2 bootloader drive (no INFO_UF2.TXT) -- did you pick the dongle's UF2BOOT drive?`);
  }

  onLog(`Writing ${firmwareFile.name} (${firmwareFile.size} bytes) to ${dirHandle.name}...`);
  const fileHandle = await dirHandle.getFileHandle(firmwareFile.name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(firmwareFile);
  await writable.close();
  onLog("Firmware copied. The dongle should reboot into the new firmware on its own.");
}
