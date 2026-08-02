# Onewheel Pint X

**Status: partially known.** Same caveat as the [Pint page](pint.md) --
nothing here is confirmed against real hardware.

## Identity

- Firmware generation: likely `7` (last in the release-order pattern -- see
  [Pint's identity section](pint.md#identity) for the reasoning and its
  caveat). Not independently confirmed.
- Tire diameter: **unknown to us**, same as Pint -- no constant found in the
  decompiled app. Needs the GPS cross-check treatment; see
  [CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-tire-diameter).

## Riding modes

Mode names found in `resources.arsc`: **Redwood, Elevated, Skyline, Custom**
-- each with `_s`/`_x` tuning-variant resource names and a `5200` variant
whose meaning we don't know (possibly tied to a specific firmware or battery
pack revision -- unconfirmed).

**No numeric `riding_mode` BLE values known for any of these**, same gap as
Pint. See [CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-riding-mode-numbers).

## Unlock scheme

Same situation as Pint: revision-dependent, not established either way for
this model. See [CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-the-unlock-scheme).
