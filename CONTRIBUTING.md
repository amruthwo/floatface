# Contributing board support

Floatface is built and tested against one Onewheel (GT) and one Garmin watch
(Forerunner 955 Solar). The BLE characteristic map is already confirmed
shared across Onewheel generations, so the scan/connect/unlock/subscribe
code likely works unmodified against other models -- what's actually missing
is model-specific data: tire diameter, riding mode names/numbers, and
confirmation of which unlock scheme applies. See [docs/boards/](docs/boards/)
for what's known vs. unknown per model.

This document is the methodology for filling in those gaps, using the same
approach the GT data was built with: read the actual board, don't guess.
Everything here uses `tools/ow_spike/unlock.py`.

## Before you start

You'll need Python and the project's BLE tooling set up:
```bash
cd tools/ow_spike
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```
Turn off your phone's Bluetooth (or force-quit the official Onewheel app) --
these boards only support one BLE connection at a time, so your phone will
otherwise hold the only slot. See the main README's explanation of this.

## Confirming your board's generation and firmware

This is always safe to run, on any board, even with no unlock bytes at all
-- `firmware_revision` is readable before any unlock attempt:
```bash
./.venv/bin/python unlock.py --identify
```
This prints the raw firmware revision and an inferred generation number
(`firmware_revision / 1000`). Report back what it prints for your board --
that alone is a useful contribution, since our generation-number table in
`docs/boards/README.md` is currently mostly a guess with only GT confirmed.

## Confirming the unlock scheme

Two possibilities, and you don't know which applies until you try:

1. **Try the existing local scheme first, with no captured bytes at all:**
   ```bash
   ./.venv/bin/python unlock.py --duration 30
   ```
   This runs the pre-GT MD5-based challenge/response scheme already in
   `unlock.py`. If telemetry (`battery_level`, `speed_rpm`, etc.) starts
   flowing, your board doesn't need per-owner capture at all -- report this,
   it's a significant finding.
2. **If that doesn't work**, your board is likely on firmware ≥4141 like GT,
   meaning the unlock is server/account-gated. Follow the same capture
   procedure GT needed -- see the main README's "Capturing your board's
   unlock bytes" section. Easiest is Option A, the
   [in-browser capture tool](https://amruthwo.github.io/floatface/capture/)
   (no Python, no Wireshark, confirmed working against real hardware) if
   you have or can get the Makerdiary dongle it's built around; Options B
   (Android + adb) and C (manual BLE sniffer + Wireshark) work with
   whatever you already have.

Either way, report which path worked for your board's firmware revision --
that's the data point `docs/boards/<model>.md` needs.

## Confirming riding mode numbers

Once unlocked (via either path above), run with a longer duration and watch
the live `riding_mode` notifications while you cycle every mode in the
official Onewheel app:
```bash
./.venv/bin/python unlock.py --raw-unlock-response <your captured hex> --duration 180
```
Each time you switch modes in the app, note the raw `riding_mode` value
logged. This is exactly how GT's 3–8 mapping was established -- there's no
shortcut, it has to be watched live per mode, per model.

## Confirming tire diameter

This needs a real ride, the same way GT's 11.5" was validated:

1. Pick a starting diameter (check FutureMotion's current published spec
   sheet for your model -- we have no reliable source for these beyond GT).
2. Temporarily set `ONEWHEEL_WHEEL_DIAMETER_INCHES` in
   `garmin-app/source/OnewheelConnection.mc` to that value and build/deploy.
3. Record a real ride with Floatface's Start/Stop button, on a route you can
   also verify GPS distance for afterward in Garmin Connect.
4. Compare Floatface's `distanceMilesThisRide` (from the Stats page, or the
   activity's custom FIT field) against Garmin Connect's GPS distance for
   the same ride. Distance scales linearly with diameter, so:
   ```
   corrected_diameter = starting_diameter * (gps_distance / floatface_distance)
   ```
5. Report both distances and the corrected diameter -- one ride is a
   reasonable first data point (this is exactly what GT's 1.77mi vs 1.74mi
   check was), more rides make it solid.

## Migrating findings into the watch app

Right now, tire diameter (`ONEWHEEL_WHEEL_DIAMETER_INCHES` in
`OnewheelConnection.mc`) and mode names (`RIDING_MODE_NAMES` in
`OnewheelView.mc`) are flat, GT-only constants. Turning confirmed
per-model data into real multi-board support means:

1. Reading `firmware_revision` at connect time (already done, during
   `sendUnlock()`) and computing generation the same way `--identify` does.
2. Replacing the flat tire diameter constant with a lookup table keyed by
   generation.
3. Replacing `RIDING_MODE_NAMES` with a per-generation table, falling back
   to showing the raw number for any generation without a confirmed
   mapping (same "show raw over guessing" principle already used for
   `safety_headroom`).

**You don't have to do this part to contribute.** Landing confirmed data in
`docs/boards/<model>.md` (and PROTOCOL.md, if it's a protocol-level finding)
is a complete, useful contribution on its own -- the code refactor above is
a separate, larger step for whenever enough model data exists to justify it.

## What makes a good PR here

This project's approach throughout has been: verify before implementing,
and show raw/uncertain data honestly rather than a confident guess. Please
hold contributions to the same bar:

- State your test methodology, not just a conclusion ("cycled all 3 Pint
  modes in the official app while watching `riding_mode` over BLE" beats
  "Pint modes are 1, 2, 3").
- Include the raw data, not just your interpretation of it.
- Clearly separate "confirmed by testing" from "spec sheet" from "guess."
- If you can't test something against real hardware, say so rather than
  presenting it as confirmed.

## What's out of scope

- **Anything requiring firmware modification or jailbreaking a board.** This
  project has deliberately stayed read-only/telemetry-focused; see
  PROTOCOL.md's "Ride-mode switching investigated, NOT implemented" section
  for the reasoning. PRs that depend on patched/jailbroken firmware won't be
  accepted.
- **Riding-mode *switching* (writes), or any other safety-relevant BLE
  write**, without the same kind of rigorous, falsifiable testing this
  project has applied elsewhere -- a plausible-looking write that's actually
  wrong is worse than not having the feature.
