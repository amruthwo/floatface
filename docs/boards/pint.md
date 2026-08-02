# Onewheel Pint

**Status: partially known.** We don't have one of these to test against --
everything below is either read out of FutureMotion's own decompiled Android
app (a primary source, at least) or inferred, never confirmed live against
real hardware. Treat everything here as a starting point, not a fact.

## Identity

- Firmware generation: likely `5` (following the pattern of
  `firmware_revision / 1000` matching product release order -- V1, Plus, XR,
  Pint, GT, Pint X -- cross-checked against our own GT reporting `6217` for
  generation 6). Not independently confirmed for Pint specifically.
- Tire diameter: **unknown to us**. We found no tire diameter or wheel
  circumference constant anywhere in the decompiled app. Whatever number you
  start with (check FutureMotion's published spec sheet), it needs the same
  GPS cross-check treatment GT got -- see
  [CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-tire-diameter).

## Riding modes

Mode *names* found as drawable resource names in the decompiled app's
`resources.arsc`: **Redwood, Elevated, Skyline** (only 3 stock modes, unlike
GT's 6).

**We have zero numeric `riding_mode` BLE values for these.** GT's 3–8
mapping was only established by watching a live board while cycling modes
in the official app -- there is no equivalent data point for Pint. Do not
assume Pint's modes reuse GT's numbers. See
[CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-riding-mode-numbers) for
how to establish this yourself.

## Unlock scheme

Unknown whether this board's firmware is above or below the `4141`
server-gating threshold documented for GT -- that threshold is revision-based,
not model-based, so it depends on which firmware revision your specific
board is running, not just that it's a Pint. Worth checking both paths (see
[CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-the-unlock-scheme)):
older firmware may work with the existing local MD5 scheme already in
`unlock.py` with no per-board capture needed at all -- untested by us,
inherited from a third-party pre-GT reference project, unconfirmed either
way.
