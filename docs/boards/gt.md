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

Confirmed as a plain whole-mile count: raw `20` matched the official
Onewheel app's own displayed lifetime odometer (20mi) on the same board, and
a later real ride watched it climb from `20` to `27` live, matching that
ride's 7.23mi GPS-measured distance. Not yet confirmed on a second board.

## `trip_amp_hours`/`trip_regen_amp_hours`

Confirmed populated with real, live-updating data during a real ride (unlike
`battery_voltage`/`amperage`/`cell_voltages`, which stay flat zero).
Milliamp-hours ruled out (using GT's published 525Wh/63V pack spec); looks
roughly 5x finer-grained than mAh, exact scale still unconfirmed. See
[PROTOCOL.md](../../PROTOCOL.md#trip_amp_hourstrip_regen_amp_hours-confirmed-live-and-updating-on-a-real-ride).
