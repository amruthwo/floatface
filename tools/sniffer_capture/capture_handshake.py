#!/usr/bin/env python3
"""Phase 0 spike for the PWA sniffer-capture tool -- validates the intended
UX flow (scan, filter to "ow*" names, follow, extract the handshake) against
real hardware, using Nordic's own official Python SnifferAPI (redistributed
via https://github.com/embedded-community/nrf-sniffer-cli) rather than the
`nrfutil ble-sniffer` Rust CLI, whose --follow/--follow-by-name flags turned
out to have a race condition: the follow request is only attempted once,
immediately at startup, and never retried even if the target device is
discovered a moment later. SnifferAPI's scan() polls in a loop instead,
which is the correct behavior and what this script relies on.

This is still a shell-out to a Python library, not the raw serial protocol
the eventual browser PWA will need to reimplement in JS -- but SnifferAPI
IS Nordic's own reference implementation, so it's a solid source to port
that protocol logic from once we get there.

Troubleshooting notes from real-world testing:
- The single biggest reliability factor found so far: **turn off the
  laptop's own Bluetooth radio** while capturing. A run of ~5 consecutive
  failures (sniffer catching zero or only a partial connection before
  losing sync) turned into 2 clean successes in a row purely from doing
  this -- likely RF interference between the laptop's own BT radio and the
  USB dongle sitting right next to it.
- If the sniffer catches the CONNECT_IND and follows into GATT discovery
  but the run ends before a 20-byte write shows up, that's not a failure --
  the unlock response is computed server-side by FutureMotion (see
  PROTOCOL.md), so the phone has to round-trip to their servers before it
  can write anything. Just use a longer --follow-seconds.
- Don't periodically re-issue follow() to try to "re-arm" after a lost
  connection -- tested, made things worse (see git history / PROTOCOL.md).

Usage:
    ./.venv/bin/python capture_handshake.py --port /dev/ttyACM0
"""
import argparse
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from SnifferAPI import Sniffer


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S.%f')[:-3]}  {msg}", flush=True)


def address_string(device) -> str:
    return ":".join("%02x" % b for b in device.address[:6])


def scan_for_board(sniffer, timeout: float):
    log(f"Scanning for up to {timeout:.0f}s for an 'ow*' device...")
    sniffer.scan()
    for i in range(int(timeout)):
        time.sleep(1)
        devices = sniffer.getDevices().asList()
        matches = [d for d in devices if d.name and d.name.strip('"').lower().startswith("ow")]
        if matches:
            device = matches[0]
            log(f"[{i}s] Found {device.name!r} @ {address_string(device)} "
                f"(seen {len(devices)} devices total)")
            return device
        log(f"[{i}s] {len(devices)} devices seen so far, none matching ow*")
    return None


def follow_and_capture(sniffer, device, pcap_path: Path, seconds: float) -> bytes | None:
    log(f"Following {device.name!r} @ {address_string(device)} for up to {seconds:.0f}s -- "
        f"open the official Onewheel app on your phone now and let it connect, "
        f"and leave it connected (one clean connection, not repeated cycling)...")
    sniffer.follow(device)

    # Deliberately NOT re-issuing follow() periodically here -- an earlier
    # version of this script did that to re-arm after a lost connection, but
    # a same-night A/B (one run with periodic re-follow, one without) showed
    # the periodic version catching zero CONNECT_IND events across 3 real
    # connection attempts, versus the single-follow version catching one
    # cleanly. Best guess: re-issuing follow() resets internal scan state,
    # and a CONNECT_IND arriving mid-reset gets missed. Not proven, but the
    # single-follow version is the one with actual evidence behind it.
    deadline = time.monotonic() + seconds
    was_in_connection = False
    while time.monotonic() < deadline:
        time.sleep(1)
        if sniffer.inConnection and not was_in_connection:
            log("Connection detected -- watching for the unlock write...")
        elif was_in_connection and not sniffer.inConnection:
            log("Connection ended.")
        was_in_connection = sniffer.inConnection

    log("Follow window ended, checking capture for the handshake...")
    cmd = ["tshark", "-r", str(pcap_path), "-Y", "btatt.opcode==0x12",
           "-T", "fields", "-e", "btatt.handle", "-e", "btatt.value"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        handle, value = parts[0], parts[1]
        raw = bytes.fromhex(value) if value else b""
        if len(raw) == 20:
            log(f"Found a 20-byte write at handle {handle} -- this is the handshake.")
            return raw
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--scan-seconds", type=float, default=30.0)
    parser.add_argument("--follow-seconds", type=float, default=90.0)
    parser.add_argument(
        "--capture-file", type=Path,
        default=Path(f"capture_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pcap"),
    )
    args = parser.parse_args()

    sniffer = Sniffer.Sniffer(portnum=args.port, baudrate=1000000,
                               capture_file_path=str(args.capture_file))
    sniffer.setSupportedProtocolVersion(2)
    sniffer.start()

    try:
        device = scan_for_board(sniffer, args.scan_seconds)
        if device is None:
            sys.exit("No 'ow*' device found. Make sure the board is powered on and nearby.")

        handshake = follow_and_capture(sniffer, device, args.capture_file, args.follow_seconds)
    finally:
        sniffer.doExit()

    if handshake is None:
        sys.exit("No handshake captured within the follow window. Try again.")

    log(f"Handshake: {handshake.hex()}")
    hex_bytes = ", ".join(f"0x{b:02x}" for b in handshake)
    print(f"""
module OnewheelProfile {{
    const UNLOCK_RESPONSE = [
        {hex_bytes}
    ]b;
}}
""")


if __name__ == "__main__":
    main()
