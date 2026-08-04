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
   confirmed plausible because our own connection to the board never
   triggered BLE link-layer pairing/encryption, so a passive sniffer sees
   the same plaintext ATT traffic as the HCI snoop log.

   **Confirmed working against real hardware** (a Makerdiary nRF52840 MDK
   USB dongle running Nordic's sniffer firmware v4.1.1). The key trick: the
   sniffer's Wireshark toolbar defaults to "All advertising devices" (pure
   promiscuous mode), which only ever captures the `CONNECT_IND` and then
   goes back to scanning everyone else -- you have to explicitly select the
   target device in the toolbar's Device dropdown so the sniffer locks onto
   and channel-hops with that one connection. Once locked on, the captured
   20-byte value written to `uart_serial_write` matched the already-known
   unlock bytes (captured earlier via the `adb bugreport` method)
   **byte-for-byte**, and the write's target handle was independently
   cross-checked against a live GATT discovery read (same UUID,
   `e659f3ff-...`). Two independently-captured methods agreeing exactly is
   about as strong a confirmation as this project can produce without a
   second board to test against.
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

A third full real ride (~7.2mi, 33:37) reinforces this: `safety_headroom`
read `1` in every single screenshot taken throughout, start to finish.
Three real rides now, never once `0` during normal riding.

## Motor temp trend sanity-checked on a real ride

Across one real ride, both motor temp readings rose monotonically as the
ride progressed (84°/82°F -> 84°/81°F -> 90°/81°F -> 102°/90°F), consistent
with motors heating up under actual load. Good independent confirmation the
signed-byte-Celsius decoding is correct, beyond just "plausible range."

A third real ride (~7.2mi) reinforces this further, and extends it to
`battery_low_temp` for the first time under real load (previously only
checked once at rest): motor 84°/79°F -> 100°/93°F -> 118°/131°F ->
127°/142°F -> 124°/145°F, battery 82°/82°F -> 82°/86°F -> 90°/97°F ->
93°/100°F -> 93°/104°F. Both climb monotonically under sustained riding,
same physically-plausible pattern as the first ride.

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

Two more real rides since then, both still in the same small-error
ballpark, no correction applied: **3.34 mi** estimated vs. **3.24 mi** GPS
(~3% off), and **7.42 mi** estimated vs. **7.23 mi** GPS (~2.6% off, on a
33:37 ride). Consistently a slight overestimate across all three rides
rather than random noise in both directions, which is worth keeping in mind
if a future correction ever gets applied -- but three data points isn't
enough yet to say whether that's a real small bias or just GPS/tire-pressure
variance that happens to have landed the same direction three times.

## `life_odometer` on GT: confirmed plain whole-mile counter, no scaling factor

Read `life_odometer` directly from a live GT: raw value `20`. The board's
owner first estimated its actual lifetime mileage (all rides combined) at
"probably around 20 miles total," and then confirmed it precisely by
reconnecting the official Onewheel app, which also reports the lifetime
odometer as 20mi. That's a real confirmation against the official app's own
displayed value, not just a rough personal estimate -- GT's `life_odometer`
is exposed over BLE as a plain integer mile count, with no large per-mile
scaling factor.

Stronger confirmation from a later real ride: `life_odometer` climbed from
`20` to `27` (watched live across the ride, not just a single before/after
check) while Garmin's GPS measured that same ride at 7.23mi -- a 7-mile
increase against a 7.23mi GPS-measured ride, both from live in-ride
tracking rather than one static comparison.

This matters because pre-GT boards are documented (in unrelated third-party
firmware-patching research, not something Floatface uses or depends on) to
store their persisted lifetime mileage in flash scaled by a factor of 1810
per mile -- explicitly only for pre-GT generations, with newer (GT) firmware
noted as using "a different settings layout." A raw `20` on this GT is
consistent with that -- if the same ~1810 scaling applied here, `life_odometer`
would have to read in the tens of thousands, not `20`. Good independent
signal that whatever GT's internal encoding is, it isn't that pre-GT scheme.

Still only one board. `trip_odometer` read `0` in the same session (board
had just been power-cycled, consistent with trip resetting on power-up, not
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
for motor and battery temperatures to converge toward ambient. Cross-checked
against a real ride's trend since -- see "Motor temp trend sanity-checked on
a real ride" above, which now covers battery temp too.

## `trip_amp_hours`/`trip_regen_amp_hours` confirmed live and updating on a real ride

Unlike `battery_voltage`/`battery_amperage`/`battery_cell_voltages` (all
confirmed empty), `trip_amp_hours` and `trip_regen_amp_hours` climbed
steadily and monotonically throughout an entire real ride:

| Time | trip_amp_hours | trip_regen_amp_hours |
|------|----------------|----------------------|
| 12:10 | 21 | -- |
| 12:11 | 359 | 24 |
| 12:15 | 1,647 | 266 |
| 12:29 | 7,902 | 1,404 |
| 12:40 | 11,694 | 2,139 |
| 12:43 | 13,301 | 2,364 |

Both are genuinely populated with real, live-updating data -- a real
positive result, distinct from the flat-zero characteristics above. Regen
climbing too is physically sensible (real regenerative braking during the
ride; the recorded activity's ascent/descent were both 174ft, consistent
with a mixed-terrain route that included real coasting/braking).

**Not literal amp-hours** -- 13,301 Ah in one ~34-minute ride is impossible
for a personal transporter (would require sustained multi-thousand-amp
draw). Checked whether milliamp-hours fits, using GT's actual published
pack spec (18s2p 21700 NMC cells, **525Wh, 63V nominal, 75V max** --
publicly published, not independently verified by us, but a real spec
rather than a guess): that puts total pack capacity at **525/63 ≈ 8.33 Ah**.
If `13301` raw were literally milliamp-hours (13.301 Ah), that alone would
be **~1.6x the entire pack's total capacity** -- for a ride that only used
roughly a quarter of the battery (see below). **This rules out literal
milliamp-hours.**

Cross-checked against the observed battery-percentage drop instead: from
~85.6% to 59% (~26.6 points) implies roughly 139.65Wh actually consumed
(26.6% of 525Wh) -- **2,217 mAh** at nominal voltage. The raw counter
increased by ~11,976 over that same window, which works out to **~5.4 raw
units per real mAh** -- i.e. `trip_amp_hours` looks like it's counting
something roughly **5x finer-grained than milliamp-hours**, not milliamp-
hours itself. Not confirmed as an exact conversion factor, just the
ballpark this specific ride's numbers land on.

**Bonus finding while computing this**: broke the ride into its three
inter-reading segments and computed raw-counter-increase-per-battery-
percent-point for each:

| Segment | %Δ | raw Δ | raw/% |
|---------|-----|-------|-------|
| 12:14→12:29 | -12 | +6,577 | 548.1 |
| 12:29→12:40 | -7 | +3,792 | 541.7 |
| 12:40→12:43 | -4 | +1,607 | 401.8 |

The first two segments are close (548, 542), but the last one drops off
notably (402, ~26% lower) -- meaning less real energy was consumed per
displayed percentage point late in the ride than earlier. That's the
direction you'd expect if `battery_level`'s percentage is nonlinear with
real stored energy the way Li-ion gauges commonly are (compressed near the
low end, so each remaining percent represents less real range than the same
percent did near the top) -- and matches the rider's own experience with
RC battery packs. **This is suggestive, not proven**: it's one ride, three
segments, and riding style/pace wasn't controlled between them (e.g. slower
or more coasting near the end of a ride would produce the same signal with
a perfectly linear gauge). Worth checking across more rides before treating
it as confirmed -- the data needed already exists in every ride now that
`trip_amp_hours` is tracked live.

**Net: milliamp-hours is ruled out; the real scale is unconfirmed but looks
roughly 5x finer than mAh.** Still shown as "raw" in the app. The
low-battery nonlinearity signal is real but unconfirmed with one ride's
data -- see "Still open" and the halfway-warning discussion this raised.

## Still open / not investigated

- `safety_headroom`'s real meaning -- now have direct evidence against the
  "boolean warning flag" theory from three separate real rides (stayed `1`
  throughout all three), true meaning still unknown.
- `custom_shaping`'s real meaning -- confirmed to be a live/rolling value
  unrelated to `riding_mode` (see "Ride-mode switching investigated" above),
  but what it actually tracks (balance state? a counter? something else?)
  is unknown.
- "Custom Shaping" mode's `riding_mode` number.
- Max motor/battery temps have risen across each successive real ride so far
  (~102°F -> 111°/118°F -> 124°/145°F) -- not yet enough data to know if
  that's a real trend (ambient temp, ride intensity/duration, seasonal) or
  coincidence; worth tracking over more rides.
- `trip_amp_hours`/`trip_regen_amp_hours`'s exact scale/unit -- confirmed
  live and populated with real data, milliamp-hours ruled out, looks roughly
  5x finer-grained than mAh but not confirmed (see above).
- Whether `battery_level`'s percentage is actually nonlinear with real
  stored energy (compressed near the low end) -- one ride's `trip_amp_hours`
  data is suggestive (see above) but confounded by uncontrolled riding style
  across the ride, not confirmed. If real, the halfway-battery warning
  (currently a flat 50% of starting percentage) may be triggering later than
  intended, since a percentage-point near empty could represent less real
  remaining range than one near full. Worth checking across more rides
  before changing the warning threshold -- not changed yet.
- The old pre-GT MD5 password's native derivation (irrelevant to GT, not
  pursued).
- Which exact ATT handle the official app writes to switch `riding_mode`.
  One sniffer capture showed a plausible-looking write (values matching the
  Bay-Apex enum, timed with a mode cycle) one handle off from `riding_mode`'s
  live-confirmed value handle; a second capture of an explicit mode cycle
  showed no matching write anywhere at all. Contradictory, not resolved --
  most likely explained by the sniffer dropping frames (a known limitation
  we already hit once this session with a lost connection follow), but
  possibly a less direct mode-switch mechanism than a plain characteristic
  write. Doesn't affect anything -- Floatface doesn't write `riding_mode`
  regardless of the answer -- so not worth more sniffer time unless it comes
  up naturally.
