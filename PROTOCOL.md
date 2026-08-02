# Onewheel GT BLE protocol — confirmed findings (Phase 0)

Everything here was empirically confirmed against a real Onewheel GT
(`ow123456`) using `tools/ow_spike/unlock.py` and a real handshake captured
from FutureMotion's official Android app via `tools/ow_spike/btsnoop_parse.py`.
Anything not explicitly confirmed here should be treated as unverified.

## Service and characteristics

Primary service: `e659f300-ea98-11e3-ac10-0800200c9a66`.

The full characteristic map reverse-engineered pre-GT by
[onewheel-web-bluetooth](https://github.com/TomasHubelbauer/onewheel-web-bluetooth)
matched a live GT's service dump almost exactly (33/34 characteristics present;
`custom_name` at `e659f3fd` was not observed on this GT). No unrecognized
("UNKNOWN") characteristics turned up, meaning GT reuses this same UUID set
rather than adding new ones for its newer features (Digital Shaping 3.0, cruise
control, etc.) — those are presumably exposed through the *existing*
`riding_mode` / `custom_shaping` characteristics rather than new ones.

Key characteristics used so far:
- `e659f311` firmware_revision — read/write
- `e659f3fe` uart_serial_read — notify only, used during the handshake
- `e659f3ff` uart_serial_write — write only, used during the handshake
- `e659f303` battery_level
- `e659f30b` speed_rpm
- `e659f302` riding_mode
- `e659f317` safety_headroom
- `e659f310` motor_controller_temp
- `e659f30f` status
- `e659f31e` custom_shaping
- `e659f301` serial_number

## Firmware revision

This GT reports firmware revision bytes `18 49` (decimal 24, 73), which is not
in the pre-GT known list (`(22,56)`/`(16,38)` = XR, `(15,194)` = Onewheel+).
Confirms GT is running different firmware than what was previously
reverse-engineered, as expected.

## Unlock handshake

**Framing is unchanged from the pre-GT protocol**: a 20-byte value structured
as `3-byte prefix + 16-byte MD5-like digest + 1-byte XOR checksum`, written to
`uart_serial_write` (`e659f3ff`).

**What differs**: the pre-GT secret constant used to compute the 16-byte
digest (`d9 25 5f 0f 23 35 4e 19 ba 73 9c cd c4 a9 17 65`) does NOT produce the
value the real app sends — confirmed by capturing FutureMotion's actual
Android app traffic via Bluetooth HCI snoop log and comparing byte-for-byte.
GT uses a different secret (not yet recovered).

**What we captured and confirmed works, for this specific board**: writing
this exact 20-byte value to `uart_serial_write` unlocks live telemetry
immediately, confirmed across multiple separate BLE connections. The actual
captured bytes are board-specific (and possibly account-tied) and are
deliberately **not included in this public repo** -- kept locally in
`garmin-app/source/LocalConfig.mc` (gitignored). See README.md for how to
capture your own board's value the same way.

**Open question**: in the captured real session, the app never read/subscribed
to `uart_serial_read` before writing this value — it went straight from
reading firmware revision to writing the unlock value. Combined with our own
script observing an *identical* first-3-byte "challenge" prefix across
independent connection attempts, this value may not be a live
per-session nonce at all, but a fixed per-device code (derived once from
firmware revision + serial number, or similar, and simply reused/cached by the
app rather than recomputed live). Not fully confirmed — we don't know if this
exact 20 bytes is derivable formulaically from board identity, or whether it's
literally a static secret unique to this board.

**Practical implication**: for THIS board, we can hardcode these 20 bytes and
skip implementing the crypto (including the still-unconfirmed MD5 constant)
entirely for now. This does not generalize to other users' boards without
either (a) each user doing this same capture procedure once, or (b) recovering
FutureMotion's actual secret/derivation via APK decompilation.

## Re-lock timing

The unlock is NOT permanent. In a 90s test with re-unlock disabled, all live
characteristics (`riding_mode`, `battery_level`, `motor_controller_temp`,
`safety_headroom`) simultaneously dropped to `0` and went silent roughly
**20 seconds** after unlocking, and stayed silent for the remainder of the test
despite spinning the wheel again. This is in the same ballpark as the ~24s the
pre-GT JS reference project's author suspected. The unlock write must be
resent periodically (every ~10-15s to stay safely under the ~20s window) to
keep telemetry flowing — confirms Phase 3's keepalive timer is necessary, not
optional.

## Byte order

Telemetry values are **big-endian** `uint16`, not little-endian. Confirmed by
`speed_rpm` only trending smoothly and physically-plausibly (e.g. 1047 → 0 as
the wheel spun down by hand) when interpreted big-endian; little-endian
produced nonsensical jumps. Matches the old JS reference's
`DataView.getUint16()` default (big-endian unless told otherwise).

## Reads vs. notifications

After a successful unlock, `battery_level`, `riding_mode`, `safety_headroom`,
`serial_number`, and `custom_shaping` are all directly readable via a plain
GATT read — they don't require waiting for a notification. Some
characteristics (`speed_rpm`, `motor_controller_temp`, `status`) appear to push
notifications continuously/periodically regardless of whether the value
changed; others (`battery_level`, `riding_mode`) seem to only notify on
change, so a real app should read them directly on connect rather than relying
solely on notify.

## Values observed (uncalibrated, for reference only)

- `battery_level`: `64` (raw `00 40`)
- `riding_mode`: `6` — old pre-GT naming maps 6 to "mission", but GT's actual
  modes are named Bay/Roam/Flow/Highline/Elevated/Apex/Custom per FutureMotion's
  support docs, so this numeric mapping needs its own empirical confirmation
  (change modes in the official app while connected and watch the raw value)
  before it's trustworthy. Not attempted yet.
- `safety_headroom`: `0`
- `serial_number`: a 2-byte value (board-specific, redacted here) — suspiciously
  short for a "serial number"; may not be the full board serial, not
  investigated further.
- `custom_shaping`: `2048` (raw `08 00`)

## Root cause found: unlock is server-gated for firmware >= 4141 (includes GT)

Decompiled `com.rideonewheel.onewheel` (jadx, base APK pulled via `adb`) and
found the real branch point in `OnewheelService.java`'s `onCharacteristicChanged`
handler for `uart_serial_read`:

- **Firmware < 4141** (pre-GT boards): the old locally-computed MD5 scheme,
  confirmed in code — `signature(3 bytes) + MD5(challenge[3:19] + password) +
  XOR checksum`. BUT the password is NOT a hardcoded Java constant — it comes
  from `MainActivity.getChallengeResponsePassword(appSignatureHash)`, a
  native (JNI) method, keyed off the app's own signing certificate hash. The
  pre-GT reverse-engineered constant we started with was apparently extracted
  from this native method by someone else previously; we did not re-derive it
  ourselves and it does not apply to GT regardless.
- **Firmware >= 4141** (GT and other current boards — ours reports 6217):
  a completely different path. `BaseOnewheelService.e(long onewheelId, byte[]
  challengeBytes)` launches a coroutine that calls `c2.n4.D(...)`, which
  hex-encodes the challenge bytes, fetches a Firebase Cloud Messaging token,
  and calls into a Retrofit-style API class (`e2.a`) using the logged-in
  user's stored auth tokens. **The actual unlock response is computed
  server-side by FutureMotion, tied to the user's account, and returned over
  the network** -- it is not present anywhere in the APK to extract.

This fully explains everything observed empirically: the captured value never
changing (fetched/cached once, not recomputed locally), and why no hardcoded
secret could be found by static analysis -- there isn't one for GT-class
boards. This is not a "keep digging in the APK" problem; the secret lives on
FutureMotion's servers.

## Practical implication for generalizing beyond this one board

Since the real computation is server-side and account-gated, the only way to
obtain a working unlock value for a board is to capture it from a real,
successful connection made by the official app (with a logged-in account).
Options for that capture step, in order of accessibility:

1. **External BLE sniffer dongle** (e.g. Nordic nRF52840 USB dongle + free
   "nRF Sniffer for Bluetooth LE" firmware + Wireshark) passively capturing
   the over-the-air exchange between phone and board. Works regardless of
   phone OS (Android or iOS) since it doesn't touch the phone at all --
   plausible because our own connection to the board never triggered BLE
   link-layer pairing/encryption, suggesting this board doesn't use it and a
   passive sniffer would see the same plaintext ATT traffic we got from the
   HCI snoop log. Not yet tested with real hardware.
2. **Android HCI snoop log + `adb bugreport`** (what we did): requires
   Developer Options + USB debugging, Android only.
3. No practical iOS-native equivalent -- Apple's PacketLogger needs a Mac,
   Xcode, and a paid Developer account; not realistic for an end user.

## Connect IQ platform quirk: scan results never carry the service UUID

Confirmed on a real FR955 Solar: `BluetoothLowEnergy.ScanResult.getServiceUuids()`
returned an empty iterator (0 UUIDs) for every advertisement from this board,
across many scans, even though the board's name (`ow123456`) came through
fine and bleak (on a laptop) had no trouble reading the service UUID from the
same advertisements. Matching on device name prefix ("ow") instead of service
UUID containment is what got the watch connecting. Not root-caused further
(may be this board only putting the 128-bit UUID in a scan-response packet
Connect IQ doesn't request/parse, or a broader SDK limitation), but the
practical fix is: always match Onewheel scan results by name prefix, don't
rely on service UUID containment on this platform.

## End-to-end confirmation (Phase 2 complete)

Full flow verified working on real FR955 Solar hardware against the real GT:
scan (name-match) -> pairDevice -> onConnectedStateChanged -> discover
characteristics -> enable CCCDs -> write hardcoded unlock bytes -> live
telemetry notifications (battery_level, riding_mode, safety_headroom,
motor_controller_temp all populated with plausible values).

Keepalive confirmed solid over several minutes of real on-wrist testing:
resending the unlock bytes every 15s keeps the board unlocked indefinitely,
no drop observed. `speed_rpm`, `status`, and `motor_controller_temp` all
continued updating live while spinning the wheel by hand, minutes into the
session.

## `status` characteristic decoded (partially)

Empirically observed to be a bitmask reflecting which footpads are currently
engaged/weighted: distinguishes left pad, right pad, and both front pads.
Exact bit-to-pad mapping not yet nailed down numerically (need to log raw
values while deliberately stepping on specific pads in sequence) but the
general shape (footpad sensor state, not just a vague "connection status") is
confirmed.

## `motor_controller_temp` decoded: two signed-byte Celsius readings, not one uint16

Confirmed via FutureMotion's own decompiled Android app (`b2.n.a(byte[])` in the
APK simply does `new n(bArr[0], bArr[1])` -- two independent Java `byte`
values, each fed to a *separate* setter). This is NOT a single big-endian
uint16 as we originally assumed. Each byte is a signed Celsius temperature.

Re-decoding every raw value we'd captured under the old (wrong) uint16
assumption confirms this: e.g. `82 19` hex -> bytes `32, 27` -> 32°C/27°C
(89.6°F/80.6°F) -- a plausible room-temperature-ish reading, vs. the
nonsensical "8219" we were displaying before. All historical readings fall
into a plausible 64-97°F range once split this way.

The two bytes are usually within 1-2°C of each other. What each one actually
corresponds to (two motor controllers, two sensor points, etc.) isn't labeled
anywhere in the decompiled code we've looked at -- shown as two values rather
than guessing which is "the" reading.

## `safety_headroom` decoded: boolean, not a percentage

FutureMotion's app treats this characteristic's raw value as `value == 1`
(a plain boolean) when it processes it -- not a graduated headroom amount.
Matches every raw value we've ever observed ourselves (always exactly `0` or
`1`, never anything else).

## `riding_mode` numeric mapping -- confirmed empirically

Pulled `resources.arsc` out of the APK directly (jadx's Java decompile skipped
resources for speed) and found GT's actual mode name set as drawable resource
names: `gt_bay`, `gt_roam`, `gt_flow`, `gt_highline`, `gt_elevated`,
`gt_apex` -- matches Bay/Roam/Flow/Highline/Elevated/Apex from Future Motion's
public docs. The numeric mapping was then confirmed by cycling modes in the
official app while watching the raw value on our own watch:

| Value | Mode |
|-------|------|
| 3 | Bay |
| 4 | Roam |
| 5 | Flow |
| 6 | Highline |
| 7 | Elevated |
| 8 | Apex |

"Custom Shaping" mode's number not yet observed/confirmed.

## Ride-mode switching investigated, NOT implemented (safety)

Considered adding a feature to switch riding modes (Bay/Roam/.../Apex) from
the watch. Before writing any Monkey C, ran three diagnostics against the
real board with `tools/ow_spike/unlock.py` to determine whether writing
`riding_mode` alone is actually sufficient to change the board's ride
dynamics, or whether the official app must separately push full shaping
parameters too (in which case writing `riding_mode` alone could silently
leave the *previous* mode's shaping active under the new mode's name/display
— a real safety concern, not a cosmetic one).

1. **Single-transition isolation test** (`--test-mode-isolation`): read
   `riding_mode` + `custom_shaping`, write ONLY `riding_mode` (Flow -> Bay,
   never touching `custom_shaping`), read both again.
   `custom_shaping` changed (`0300` -> `1300`), which on its own looked like
   support for the board reconfiguring shaping internally on a mode switch.

2. **Full sweep test** (`--test-mode-sweep`): walked `riding_mode` through
   every mode up (Bay -> Apex) then back down (Apex -> Bay), writing only
   `riding_mode` each time and reading `custom_shaping` after every
   transition, to check whether each mode reliably produces the *same*
   `custom_shaping` value regardless of path. It did not: every mode except
   the one visited only once showed multiple different `custom_shaping`
   values across separate visits (e.g. Bay: `0200`, `1300`, `1400`; Roam:
   `0600`, `0b00`). This contradicted test 1's implication of a stable
   per-mode preset index.

3. **Drift control test** (`--test-shaping-drift`): the deciding test. Held
   `riding_mode` constant at Bay and made **zero writes at all**, just
   reading `custom_shaping` repeatedly (~every 2s). It changed on nearly
   every single read anyway: `0000, 1000, 0700, 1400, 0a00, 0100, 0d00,
   0400, 1000, 0000` — with riding_mode never touched.

**Conclusion**: `custom_shaping` is not a function of `riding_mode` at all —
it's a live/rolling value (most likely tied to real-time balance/pitch
state, or an internal counter, not a per-mode shaping preset index). Test
1's apparent "confirmation" was very likely coincidental drift, not
causation, and test 2's "inconsistency" is fully explained by this rather
than being evidence against mode-only writes. Net result: **this
characteristic cannot be used as evidence either way** for whether writing
`riding_mode` alone actually changes the board's ride dynamics — we ended
the investigation with the original safety question (does the board
silently keep the old mode's shaping active under the new mode's name?)
neither confirmed nor ruled out.

The only test that could actually answer this is a physical one — ride the
board after a `riding_mode`-only write (with the official app fully
disconnected) and judge by feel whether the dynamics actually match the new
mode. That's subjective, easy to misjudge, and risky to evaluate solo at
speed. Given the stakes of getting this wrong (a board that behaves
differently than its displayed mode suggests, mid-ride), **ride-mode
switching is not implemented in the watch app**. If revisited later, it
would need that physical validation first, done deliberately and safely,
before any watch UI is built around it.

## `safety_headroom` puzzle: stayed `1` through an entire real ride too

Toggling the "Safestop" setting off/on in the official app produced no
change (stayed `1`). We then tested the "held in the air, not really ridden"
hypothesis directly: recorded an actual outdoor ride, board upright, ridden
normally the whole time. `safety_headroom` still read `1` for the entire
ride, never `0`. This is now real evidence against the "boolean warning
flag" theory, not just an untested gap -- a value that reads "WARN" during
completely uneventful normal riding either means something other than what
we assumed, or the polarity is inverted (`1` = nominal, `0` = rare/edge
case, e.g. only seen once, in an initial characteristic read moments after
connecting before the board's sensors were fully settled). Current app
shows the raw number rather than a WARN/OK label, since asserting either
would be a guess we now have direct evidence against.

## Motor temp trend sanity-checked on a real ride

Across one real ride, both motor temp readings rose monotonically as the
ride progressed (84°/82°F -> 84°/81°F -> 90°/81°F -> 102°/90°F), consistent
with motors heating up under actual load. Good independent confirmation the
signed-byte-Celsius decoding is correct, beyond just "plausible range."

## GPS was never being recorded -- root cause found and fixed

A full real ride recorded with zero GPS position/speed/distance data, while
a comparison bike-ride activity on the same watch had a full map/speed/
elevation, confirming the watch's GPS itself was not the issue. Root cause:
`Toybox.Position.enableLocationEvents()` was never being called, and the
manifest was missing the `Positioning` permission -- confirmed by checking
Garmin's own `RecordSample` (the same sample our start/stop recording
pattern is based on), which calls `Position.enableLocationEvents(LOCATION_CONTINUOUS, ...)`
in `onStart()` and disables it in `onStop()`. `ActivityRecording.createSession()`
records whatever position data the system is currently receiving -- it does
not turn the GPS receiver on by itself. Confirmed fixed: a real ride after
this change recorded full GPS distance/speed/map data in Garmin Connect.

## Wheel diameter (11.5") confirmed close via GPS cross-check

Same ride that confirmed GPS recording: our RPM-integrated trip distance
(`distanceMilesThisRide`, built on the 11.5" GT tire diameter assumption)
came out to **1.77 mi**, vs. **1.74 mi** measured by the watch's own GPS for
the same ride -- under 2% off. Good enough that the 11.5" tire spec was the
right number to use; not applying a correction based on one data point
(within normal GPS/tire-pressure noise), but this is real validation rather
than just a plausible-sounding assumption now.

## `life_odometer` on GT: likely a plain whole-mile counter, no scaling factor

Read `life_odometer` directly from a live GT: raw value `20`. The board's
owner estimated its actual lifetime mileage (all rides combined) at "probably
around 20 miles total" -- a real cross-check, not a guess on our part, same
pattern as the earlier GPS-distance validation. That match suggests GT's
`life_odometer` is exposed over BLE as a plain integer mile count, with no
large per-mile scaling factor.

This matters because pre-GT boards are documented (in unrelated third-party
firmware-patching research, not something Floatface uses or depends on) to
store their persisted lifetime mileage in flash scaled by a factor of 1810
per mile -- explicitly only for pre-GT generations, with newer (GT) firmware
noted as using "a different settings layout." A raw `20` on this GT is
consistent with that -- if the same ~1810 scaling applied here, `life_odometer`
would have to read in the tens of thousands, not `20`. Good independent
signal that whatever GT's internal encoding is, it isn't that pre-GT scheme.

Not fully confirmed with a second data point yet -- one board, one rough
mileage estimate. `trip_odometer` read `0` in the same session (board had
just been power-cycled, consistent with trip resetting on power-up, not
re-tested against a known non-zero trip distance yet).

## `battery_cell_voltages` reads back empty on GT

`e659f31b` (`battery_cell_voltages`) is present in the live GT's service dump
with `read`/`write`/`notify` properties, but a direct read returns a flat
2-byte `0000` -- not an error, just empty. Matches the user's recollection
that the official app doesn't surface per-cell voltages for GT. Also
structurally implausible as real per-cell data regardless: an 18S GT pack
would need well over 2 bytes to represent all cells individually. Conclusion:
this characteristic exists in the shared cross-model BLE profile but isn't
populated with real data on GT -- not a deeper-unlock question, just not
wired up on this board.

## `battery_voltage`/`battery_amperage` also read back empty on GT

Same pattern as `battery_cell_voltages`: both characteristics are present
with `read`/`write`/`notify` properties, but read back a flat `0000` while
`battery_level` simultaneously reported a real 86%. Amperage at 0 while the
board is idle is plausible on its own, but pack voltage reading exactly zero
on a board that's powered on and reporting a real battery percentage is not
-- a real pack voltage should never be zero. Conclusion: these two, like
`battery_cell_voltages`, exist in the BLE profile but aren't populated with
real data on this GT.

## `battery_low_temp` decoded: two signed-byte Celsius readings, same pattern as `motor_controller_temp`

Read directly from a live GT: raw `1d1c`. Splitting into two independent
signed bytes (same decoding already confirmed for `motor_controller_temp`,
see above) gives 29°C/28°C (84°F/82°F) -- a plausible battery temperature at
rest, and notably identical to `motor_controller_temp`'s raw value in the
same read, consistent with a board that had been sitting idle long enough
for motor and battery temperatures to converge toward ambient. Not yet
cross-checked against a real ride's battery temp trend the way
`motor_controller_temp` was.

## Still open / not investigated

- Whether the external BLE sniffer dongle approach actually works in practice
  (not yet tested).
- `safety_headroom`'s real meaning -- now have direct evidence against the
  "boolean warning flag" theory from two separate real rides (stayed `1`
  throughout both), true meaning still unknown.
- `custom_shaping`'s real meaning -- confirmed to be a live/rolling value
  unrelated to `riding_mode` (see "Ride-mode switching investigated" above),
  but what it actually tracks (balance state? a counter? something else?)
  is unknown.
- "Custom Shaping" mode's `riding_mode` number.
- Motor temps ran hotter on the second real ride (111°F/118°F vs. ~102°F max
  on the first) -- not yet enough data to know if that's normal variation
  or worth tracking as a trend.
  `enableLocationEvents`/`Positioning` permission.
- The old pre-GT MD5 password's native derivation (irrelevant to GT, not
  pursued).
