<p align="center">
  <img src="docs/hero.svg" alt="Floatface" width="220" />
</p>

<h1 align="center">Floatface</h1>
<p align="center"><b>Onewheel telemetry on a Garmin watch — no phone required.</b></p>

Floatface is a Connect IQ watch-app that talks directly to a Onewheel over
Bluetooth Low Energy. No companion phone app, no Onewheel app in the loop —
the watch connects to the board on its own, unlocks it, and shows live
speed, battery, riding mode, motor temps, and more, while recording a real
GPS-tracked activity with that telemetry embedded as custom FIT fields.

Built and tested against a **Garmin Forerunner 955 Solar** and a
**Onewheel GT**. It should be portable to other BLE-capable Garmin watches
and other Onewheel models with some adjustment — see [PROTOCOL.md](PROTOCOL.md)
for what's confirmed vs. assumed.

## Screenshots

<p align="center">
  <img src="docs/screenshots/ride-page.jpg" width="150" alt="Ride page: speed and battery" />
  <img src="docs/screenshots/stats-page.jpg" width="150" alt="Stats page: trip and range" />
  <img src="docs/screenshots/board-page.jpg" width="150" alt="Board page: mode, safety, temps" />
  <img src="docs/screenshots/activity-summary.jpg" width="150" alt="Recorded activity summary in Garmin Connect" />
</p>

<p align="center"><i>Ride · Stats · Board (paged with the watch's Up/Down buttons) · the recorded activity afterward</i></p>

## Features

- **Direct BLE connection** — the watch scans for, pairs with, and unlocks
  the board itself. No phone, no FutureMotion app needed while riding.
- **Live telemetry**: speed (estimated from wheel RPM), battery %, riding
  mode, motor temperatures, board status.
- **Real activity recording** — press the watch's Start/Stop button to
  record a normal GPS-tracked FIT activity, with board telemetry attached
  as custom fields alongside it.
- **Self-calibrating range estimate** — extrapolates remaining range from
  distance covered vs. battery consumed *this ride*, not a fixed formula.
- **Halfway-battery warning** — vibrates once when battery drops to half of
  wherever it started *this ride* (not a flat 50%), so you know when to
  turn back.
- **Three pages**, paged with the physical Up/Down buttons: Ride (speed/
  battery), Stats (trip/range), Board (mode/safety/temps).

## Status

Early and personal. This is a from-scratch reverse-engineering project, not
a polished product — expect rough edges. Speed/distance and the lifetime
odometer have checked out well against GPS and the official app across
several real rides; a couple of values (`safety_headroom`, exact trip
amp-hour units) are recorded but not yet fully understood. Riding-mode
*switching* from the watch was investigated and deliberately left out —
the evidence couldn't confirm it actually changes ride dynamics rather than
just a displayed name, and this isn't the kind of thing to guess at. See
[PROTOCOL.md](PROTOCOL.md) for the full evidence behind all of this.

## Why no phone is needed

Connect IQ has supported direct Bluetooth Low Energy access from the watch
since API level 3.1 — the watch can scan, pair, and talk to arbitrary BLE
peripherals on its own. The catch is on the Onewheel side: GT-generation
boards require an "unlock" write before they'll report live telemetry, and
that unlock value is computed **server-side by FutureMotion**, tied to your
account — not a fixed algorithm we can bake into the app. See
[PROTOCOL.md](PROTOCOL.md) for the full investigation behind that
conclusion.

Practically, that means **you need to capture your own board's unlock
bytes once** — a one-time setup step, not something the app can do for
you automatically.

## The watch and the official Onewheel app can't both be connected at once

This isn't a bug in Floatface — it's how the board's Bluetooth firmware
works. Onewheel boards only support **one BLE connection at a time**. We
confirmed this directly: with a phone connected via the official app, the
board stops advertising entirely, so nothing else (our watch, a laptop, a
different phone) can even see it, let alone connect. Whoever connects first
holds the only slot until they disconnect, and there's no way to work
around this from the outside — that limit is set by the board's own
firmware.

**In practice**: use one or the other. Turn off your phone's Bluetooth (or
background/force-quit the Onewheel app) before opening Floatface, and
vice versa when you need something only the official app currently
provides. If Floatface can't find your board within 30 seconds, it'll show
a hint suggesting this is probably why.

## Capturing your board's unlock bytes

You need this before the app will do anything beyond scan for your board.
It works by watching FutureMotion's own official Onewheel app unlock your
board over Bluetooth, and copying the bytes it sends.

### Option A: the in-browser capture tool (easiest, confirmed working)

**[The in-browser capture tool](https://amruthwo.github.io/floatface/capture/)**
walks you through flashing a **Makerdiary nRF52840-MDK USB Dongle** (~$15)
and capturing the handshake, entirely in Chrome/Edge/Chromium — no Python,
no Wireshark, nothing to install. Everything runs locally in your browser
via the Web Serial and File System Access APIs; nothing is uploaded
anywhere. This is the same underlying method as Option C below, just
guided and browser-based — confirmed against real hardware to capture the
exact same bytes.

Using a different nRF52840 dongle or a Flipper Zero? Use Option C instead;
the in-browser tool is built specifically around the Makerdiary dongle.

### Option B: Android phone + adb (confirmed working)

1. On your phone: **Settings → About phone**, tap "Build number" 7 times to
   enable Developer Options.
2. **Settings → System → Developer options**, enable both **USB debugging**
   and **Bluetooth HCI snoop log**.
3. Toggle Bluetooth off and back on (clean start to the log).
4. Plug the phone into your computer via USB and approve the "Allow USB
   debugging" prompt.
5. Open the official Onewheel app and let it connect normally to your
   board — this performs the real unlock. (Bonus: if you also change riding
   modes in the app while connected, you'll capture that too, useful for
   confirming the mode-name mapping on your own board.)
6. Pull the log via a full bug report (modern Android won't let you read it
   directly without root):
   ```bash
   adb devices
   adb bugreport bugreport.zip
   unzip -l bugreport.zip | grep btsnoop   # path varies by Android version
   unzip -p bugreport.zip 'FS/data/log/bt/btsnoop_hci.log' > btsnoop_hci.log
   ```
7. Set up the Python tooling and parse it:
   ```bash
   cd tools/ow_spike
   python3 -m venv .venv
   ./.venv/bin/pip install -r requirements.txt
   ./.venv/bin/python btsnoop_parse.py btsnoop_hci.log --address AA:BB:CC:DD:EE:FF
   ```
   (use your board's actual BLE address — `unlock.py --scan-all` will show
   it to you if you don't know it)
8. Look for a `WRITE_REQ` to the `uart_serial_write` characteristic
   (`e659f3ff-...`) with a 20-byte value shaped like
   `<3 bytes><16 bytes><1 byte>`. Those 20 bytes are your unlock value.
9. Copy `garmin-app/source/LocalConfig.mc.example` to
   `garmin-app/source/LocalConfig.mc` and paste your bytes in.

### Option C: external BLE sniffer dongle, manual Wireshark (confirmed working)

The same method Option A automates, done by hand — useful for a different
nRF52840 dongle, a Flipper Zero, or just wanting to see the raw capture
yourself. A BLE sniffer dongle passively captures the handshake over the
air, directly between your phone and the board, without touching the
phone's OS at all — so it works regardless of phone OS, including iOS.
**Confirmed against real hardware**: captured bytes matched an Option B
(`adb bugreport`) capture of the same board byte-for-byte.

1. Get an nRF52840-based USB sniffer dongle and flash it with Nordic's free
   "nRF Sniffer for Bluetooth LE" firmware. Flashing steps vary by
   bootloader — a genuine Nordic PCA10059 uses Nordic DFU, while cheaper
   third-party dongles (e.g. Makerdiary) often use Adafruit's UF2 bootloader
   instead (drag the firmware, converted to `.uf2`, onto the dongle's
   `UF2BOOT` USB drive). Check what your dongle actually is first.
2. Install [`nrfutil`](https://www.nordicsemi.com/Products/Development-tools/nrf-util)
   and its `ble-sniffer` bundle, then `nrfutil ble-sniffer bootstrap` to
   register it as a Wireshark extcap interface.
3. Open Wireshark, select the `nRF Sniffer for Bluetooth LE` interface.
4. **Easy to miss but important**: enable **View → Interface Toolbars →
   nRF Sniffer for Bluetooth LE**, then use its **Device** dropdown to
   select your board specifically (advertises as `ow` + digits). It
   defaults to "all advertising devices," which only ever catches the
   initial `CONNECT_IND` before going back to scanning everyone else.
5. Start the capture, then open the official Onewheel app on your phone and
   let it connect normally — this performs the real unlock.
6. Look for a `Write Request` to handle matching `uart_serial_write`
   (`e659f3ff-...`) carrying a 20-byte value.
7. Copy `garmin-app/source/LocalConfig.mc.example` to
   `garmin-app/source/LocalConfig.mc` and paste your bytes in.

## Building and installing

1. Install the [Connect IQ SDK](https://developer.garmin.com/connect-iq/sdk/)
   (the CLI-based [connect-iq-sdk-manager-cli](https://github.com/lindell/connect-iq-sdk-manager-cli)
   works well on Linux).
2. Generate a developer signing key:
   ```bash
   cd garmin-app
   openssl genrsa -out developer_key.pem 4096
   openssl pkcs8 -topk8 -inform PEM -outform DER -in developer_key.pem -out developer_key.der -nocrypt
   ```
3. Set up your unlock bytes (see above) in `garmin-app/source/LocalConfig.mc`.
4. Build:
   ```bash
   monkeyc -d fr955 -f monkey.jungle -o bin/floatface.prg -y developer_key.der
   ```
5. Connect your watch via USB (it'll appear as an MTP device on most
   systems, not a plain USB drive) and copy `bin/floatface.prg` into the
   `GARMIN/Apps/` folder on the watch. The file will disappear from view
   after the watch ingests it on next reconnect — that's expected.
6. Eject, disconnect, and open "Floatface" from the watch's app list.

## Project layout

```
garmin-app/            Connect IQ (Monkey C) watch-app source
tools/ow_spike/        Python BLE spike scripts used to reverse-engineer
                       and validate the protocol before writing Monkey C
docs/capture/          The in-browser unlock-handshake capture tool
                       (Option A above)
PROTOCOL.md            Everything confirmed (and still open) about the
                       Onewheel BLE protocol
docs/boards/           What's known/unknown per Onewheel model (only GT is
                       fully confirmed) -- see CONTRIBUTING.md to help fill
                       in another model
```

## Other Onewheel models

Floatface only has real hardware to test against a GT. The BLE protocol is
confirmed shared across generations, but tire diameter and riding mode
names/numbers are model-specific and mostly unconfirmed for anything else --
see [docs/boards/](docs/boards/) for what's known per model, and
[CONTRIBUTING.md](CONTRIBUTING.md) if you'd like to help establish the rest
for a Pint, XR, or other board using the same GPS-cross-check and live-testing
methodology this project has used throughout.

## Acknowledgments

- [kite247/Onewheel2Garmin](https://github.com/kite247/Onewheel2Garmin) — an
  earlier, differently-architected attempt (phone-app notification
  bridging rather than direct BLE) that was useful prior art.
- [TomasHubelbauer/onewheel-web-bluetooth](https://github.com/TomasHubelbauer/onewheel-web-bluetooth) —
  reverse-engineered the pre-GT Onewheel BLE protocol and characteristic
  map that this project's investigation started from.

## Disclaimer

Not affiliated with Future Motion, Inc. (Onewheel) or Garmin Ltd. Onewheel
is a trademark of Future Motion, Inc. This is a personal reverse-engineering
project, provided as-is with no warranty. A Onewheel is a self-balancing
personal transporter — use this app at your own risk, and don't let a watch
screen distract you from actually riding safely.
