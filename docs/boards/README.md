# Board-specific notes

Floatface is built and tested against one board (Onewheel GT) and one watch
(Garmin Forerunner 955 Solar). The BLE characteristic/UUID map is confirmed
shared across Onewheel generations (GT's live service dump matched the
pre-GT reverse-engineered map almost exactly), so the scan/connect/unlock/
subscribe code likely already works unmodified against other models. What
varies per model -- and what's actually missing for anyone else to use this
app -- is the *interpretation* layer: tire diameter (for speed/distance) and
riding mode names/numbers.

This folder tracks what's known vs. unknown per model, so contributions have
somewhere specific to land. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for
how to establish any of the missing pieces yourself, and what a useful PR
looks like.

## Generation number

Boards identify their firmware via the `firmware_revision` characteristic;
dividing by 1000 gives a generation number (GT's `6217` → generation `6`,
the one data point we've actually confirmed). The full table below follows
Onewheel's public release order and is otherwise a guess -- only the GT row
is independently confirmed.

| Gen | Model | Status |
|-----|-------|--------|
| 1 | [Onewheel (V1)](v1.md) | Unknown |
| 2–3 | [Onewheel+](plus.md) | Unknown |
| 4 | [Onewheel+ XR](xr.md) | Unknown |
| 5 | [Onewheel Pint](pint.md) | Mode names known, numbers unknown |
| 6 | [Onewheel GT](gt.md) | **Fully confirmed** |
| 7 | [Onewheel Pint X](pint-x.md) | Mode names known, numbers unknown |

## What's confirmed only for GT (don't assume it generalizes)

- Numeric `riding_mode` value → mode name mapping.
- Tire diameter (11.5", GPS-cross-checked).
- `battery_low_temp` decoding, and which other battery characteristics read
  back empty.
- `life_odometer` looking like a plain mile count.

## What's already confirmed to be model-independent

- The full BLE characteristic/UUID map.
- The unlock handshake framing (3-byte signature + 16-byte digest + 1-byte
  XOR checksum).
- The server-gating threshold being tied to firmware revision (≥4141), not
  to a specific model -- so it's plausible some older, unmodified pre-GT
  boards would work with the existing local MD5 scheme already in
  `unlock.py`, needing no per-board capture at all. This is untested for
  every model except GT (where it's confirmed the local scheme does *not*
  apply).
