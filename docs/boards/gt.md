# Onewheel GT

**Status: fully confirmed.** This is the board Floatface is built and tested
against, and the reference for what "fully confirmed" looks like on the other
pages in this folder.

## Identity

- Firmware generation: `6` (firmware revision divided by 1000 -- this board
  reported `6217`).
- Tire diameter: **11.5"**, confirmed via GPS cross-check on a real ride
  (RPM-integrated distance came within 2% of GPS distance). See
  [PROTOCOL.md](../../PROTOCOL.md#wheel-diameter-115-confirmed-close-via-gps-cross-check).

## Riding modes

Numeric `riding_mode` BLE values confirmed by cycling modes in the official
app while watching the raw value on a live board:

| Value | Mode |
|-------|------|
| 3 | Bay |
| 4 | Roam |
| 5 | Flow |
| 6 | Highline |
| 7 | Elevated |
| 8 | Apex |

"Custom Shaping" mode's number not yet observed. See
[PROTOCOL.md](../../PROTOCOL.md#riding_mode-numeric-mapping----confirmed-empirically).

## Unlock scheme

Firmware ≥ 4141 (this board is 6217) means the unlock response is computed
**server-side by FutureMotion**, tied to the rider's account -- not a local
algorithm. Every owner needs to capture their own board's unlock bytes once.
See the main [README.md](../../README.md#capturing-your-boards-unlock-bytes)
for the capture procedure.

## Known-empty characteristics

`battery_cell_voltages`, `battery_voltage`, and `battery_amperage` all read
back as flat zero on a live GT -- present in the BLE profile but not
populated with real data on this board. `battery_low_temp` **is** populated
(two signed-byte Celsius readings, same shape as `motor_controller_temp`).
See PROTOCOL.md for details.

## `life_odometer`

Reads as a plausible plain whole-mile count (one data point: raw `20`
matched the board's real ~20mi lifetime total). Not yet confirmed with a
second board or a second reading.
