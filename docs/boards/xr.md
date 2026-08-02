# Onewheel+ XR

**Status: mostly unknown.** This is the board the *pre-GT* protocol
reference ([onewheel-web-bluetooth](https://github.com/TomasHubelbauer/onewheel-web-bluetooth))
was originally reverse-engineered against, so the BLE characteristic map is
almost certainly identical (GT's live service dump matched that pre-GT map
almost exactly). Everything model-specific below is still unconfirmed.

## Identity

- Firmware generation: likely `4` (see the reasoning and caveat on the
  [Pint page](pint.md#identity)). Not independently confirmed.
- Tire diameter: **unknown to us**. No constant found in the decompiled app;
  needs the GPS cross-check treatment -- see
  [CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-tire-diameter).

## Riding modes

We found no mode-name drawable resources for XR in `resources.arsc` under
the naming pattern that worked for GT/Pint/Pint X -- either a different
naming scheme was used, or they're just not present in the APK version we
decompiled. **Nothing known here at all.** See
[CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-riding-mode-numbers).

## Unlock scheme

Unknown. XR predates GT, so there's a reasonable chance an unmodified XR is
still on firmware below the `4141` server-gating threshold, in which case
the existing local MD5 scheme in `unlock.py` might work with no per-board
capture at all -- genuinely untested, worth being the first thing anyone
with an XR tries. See
[CONTRIBUTING.md](../../CONTRIBUTING.md#confirming-the-unlock-scheme).
