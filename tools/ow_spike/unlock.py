#!/usr/bin/env python3
"""Onewheel BLE protocol validation spike -- Phase 0 of the Floatface project.

Throwaway diagnostic script, not the final architecture. Its only job is to
confirm, against a real board, that the unlock handshake and characteristic
map reverse-engineered by other projects (mainly
https://github.com/TomasHubelbauer/onewheel-web-bluetooth, whose exact
protocol logic this file ports from JS) actually holds up -- and to find out
what a GT specifically exposes, since prior reverse-engineering predates GT.

Usage:
    ./.venv/bin/python unlock.py                       # scan + run for 180s
    ./.venv/bin/python unlock.py --address AA:BB:CC:.. # skip scanning
    ./.venv/bin/python unlock.py --duration 600
"""
import argparse
import asyncio
import hashlib
import time
from datetime import datetime

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "e659f300-ea98-11e3-ac10-0800200c9a66"
FIRMWARE_REVISION_CHAR = "e659f311-ea98-11e3-ac10-0800200c9a66"
UART_READ_CHAR = "e659f3fe-ea98-11e3-ac10-0800200c9a66"   # challenge arrives here
UART_WRITE_CHAR = "e659f3ff-ea98-11e3-ac10-0800200c9a66"  # response goes here

SIGNATURE = bytes([0x43, 0x52, 0x58])
UNLOCK_PASSWORD = bytes([
    0xD9, 0x25, 0x5F, 0x0F, 0x23, 0x35, 0x4E, 0x19,
    0xBA, 0x73, 0x9C, 0xCD, 0xC4, 0xA9, 0x17, 0x65,
])

# Full characteristic map as reverse-engineered pre-GT. Anything the board
# exposes that ISN'T in here will print as "UNKNOWN" in the service dump --
# that's the interesting part for a GT, which is newer than this map.
KNOWN_CHARACTERISTICS = {
    "e659f301-ea98-11e3-ac10-0800200c9a66": "serial_number",
    "e659f311-ea98-11e3-ac10-0800200c9a66": "firmware_revision",
    "e659f318-ea98-11e3-ac10-0800200c9a66": "hardware_revision",
    "e659f302-ea98-11e3-ac10-0800200c9a66": "riding_mode",
    "e659f3fd-ea98-11e3-ac10-0800200c9a66": "custom_name",
    "e659f30f-ea98-11e3-ac10-0800200c9a66": "status",
    "e659f317-ea98-11e3-ac10-0800200c9a66": "safety_headroom",
    "e659f31c-ea98-11e3-ac10-0800200c9a66": "last_errors",
    "e659f31e-ea98-11e3-ac10-0800200c9a66": "custom_shaping",
    "e659f31d-ea98-11e3-ac10-0800200c9a66": "data_29",
    "e659f31f-ea98-11e3-ac10-0800200c9a66": "data_31",
    "e659f320-ea98-11e3-ac10-0800200c9a66": "data_32",
    "e659f306-ea98-11e3-ac10-0800200c9a66": "battery_serial",
    "e659f303-ea98-11e3-ac10-0800200c9a66": "battery_level",
    "e659f304-ea98-11e3-ac10-0800200c9a66": "battery_low_5",
    "e659f305-ea98-11e3-ac10-0800200c9a66": "battery_low_20",
    "e659f315-ea98-11e3-ac10-0800200c9a66": "battery_low_temp",
    "e659f316-ea98-11e3-ac10-0800200c9a66": "battery_voltage",
    "e659f312-ea98-11e3-ac10-0800200c9a66": "battery_amperage",
    "e659f31b-ea98-11e3-ac10-0800200c9a66": "battery_cell_voltages",
    "e659f310-ea98-11e3-ac10-0800200c9a66": "motor_controller_temp",
    "e659f30c-ea98-11e3-ac10-0800200c9a66": "lighting_mode",
    "e659f30e-ea98-11e3-ac10-0800200c9a66": "lighting_back",
    "e659f30d-ea98-11e3-ac10-0800200c9a66": "lighting_front",
    "e659f30b-ea98-11e3-ac10-0800200c9a66": "speed_rpm",
    "e659f307-ea98-11e3-ac10-0800200c9a66": "pitch",
    "e659f308-ea98-11e3-ac10-0800200c9a66": "roll",
    "e659f309-ea98-11e3-ac10-0800200c9a66": "yaw",
    "e659f30a-ea98-11e3-ac10-0800200c9a66": "trip_odometer",
    "e659f314-ea98-11e3-ac10-0800200c9a66": "trip_regen_amp_hours",
    "e659f313-ea98-11e3-ac10-0800200c9a66": "trip_amp_hours",
    "e659f319-ea98-11e3-ac10-0800200c9a66": "life_odometer",
    "e659f31a-ea98-11e3-ac10-0800200c9a66": "life_amp_hours",
    UART_WRITE_CHAR: "uart_serial_write",
    UART_READ_CHAR: "uart_serial_read",
}

# Known pre-GT firmware revisions. GT's bytes aren't in here -- this run
# will tell us what a GT actually reports.
KNOWN_FIRMWARE_REVISIONS = {
    (22, 56): "Onewheel+ XR",
    (16, 38): "Onewheel+ XR",
    (15, 194): "Onewheel+",
}

RIDING_MODE_NAMES = {
    1: "classic", 2: "extreme", 3: "elevated",
    4: "sequoia", 5: "cruz", 6: "mission",
}

# Characteristics worth subscribing to once unlocked, for the live telemetry
# section of the run. Extend this once the service dump shows what else the
# GT has beyond this pre-GT map.
TELEMETRY_CHARACTERISTICS = [
    "battery_level", "speed_rpm", "riding_mode",
    "safety_headroom", "motor_controller_temp", "status",
]


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%H:%M:%S.%f')[:-3]}  {msg}", flush=True)


def build_unlock_response(challenge: bytes) -> bytes:
    """Port of the unlock() challenge-response logic from onewheel-web-bluetooth's index.js.

    Deliberately does NOT hard-fail on a signature mismatch -- the caller logs a
    warning and this still builds a best-effort response so we can observe what
    the board does with it. Echoes challenge[:3] back like the original JS does
    (rather than a hardcoded constant), since that's what's actually specified.
    """
    if len(challenge) != 20:
        raise ValueError(f"expected 20-byte challenge, got {len(challenge)}: {challenge.hex()}")

    # JS: password = [...challenge.slice(3, -1), ...appendix]
    password = challenge[3:19] + UNLOCK_PASSWORD  # 16 + 16 = 32 bytes fed to MD5
    digest = hashlib.md5(password).digest()  # real MD5 is fine here -- the Monkey C port needs its own, later

    response = bytearray(challenge[:3] + digest)  # 3 + 16 = 19 bytes
    checksum = 0
    for b in response:
        checksum ^= b
    response.append(checksum)  # 20 bytes total
    return bytes(response)


class OnewheelSpike:
    def __init__(
        self, address: str | None, duration: float, reunlock_interval: float,
        skip_unlock: bool = False, raw_unlock_response: bytes | None = None,
    ):
        self.address = address
        self.duration = duration
        self.reunlock_interval = reunlock_interval
        self.skip_unlock = skip_unlock
        self.raw_unlock_response = raw_unlock_response
        self.client: BleakClient | None = None
        self.challenge_buffer = bytearray()
        self.challenge_start_time = 0.0

    async def find_board(self) -> str:
        if self.address:
            return self.address
        log("Scanning for a board advertising the Onewheel service UUID or name prefix 'ow'...")

        def match(device, advertisement_data):
            name_match = (device.name or "").lower().startswith("ow")
            service_match = SERVICE_UUID in (advertisement_data.service_uuids or [])
            return name_match or service_match

        device = await BleakScanner.find_device_by_filter(match, timeout=20.0)
        if device is None:
            raise RuntimeError("No board found within 20s -- is it powered on and within range?")
        log(f"Found {device.name!r} @ {device.address}")
        return device.address

    async def dump_services(self) -> None:
        log("=== Service/characteristic dump ===")
        for service in self.client.services:
            if service.uuid.lower() != SERVICE_UUID:
                continue
            for char in service.characteristics:
                name = KNOWN_CHARACTERISTICS.get(char.uuid.lower(), "UNKNOWN")
                log(f"  {char.uuid}  {name:24s}  props={char.properties}")

    def _on_challenge_notify(self, _char, data: bytearray) -> None:
        elapsed = time.monotonic() - self.challenge_start_time
        log(f"    [uart_read packet] t+{elapsed:5.2f}s  {len(data):2d} bytes  {data.hex()}")
        self.challenge_buffer.extend(data)

    async def unlock(self) -> None:
        self.challenge_buffer.clear()
        await self.client.start_notify(UART_READ_CHAR, self._on_challenge_notify)
        self.challenge_start_time = time.monotonic()

        # Give the board a moment to push anything it sends unprompted on
        # subscribe, BEFORE we write anything -- if packets show up here,
        # the write-back isn't what triggers the challenge on this board.
        await asyncio.sleep(0.3)
        log(f"    ({len(self.challenge_buffer)} bytes received before the firmware-rev write-back)")

        firmware_rev = bytes(await self.client.read_gatt_char(FIRMWARE_REVISION_CHAR))
        model = KNOWN_FIRMWARE_REVISIONS.get(tuple(firmware_rev), f"UNKNOWN ({firmware_rev.hex()})")
        log(f"Firmware revision {firmware_rev.hex()} -> {model}")

        # Writing the firmware revision back to its own characteristic is what
        # triggers the board to start streaming the 20-byte challenge (on
        # pre-GT boards, at least -- worth confirming here).
        pre_write_len = len(self.challenge_buffer)
        await self.client.write_gatt_char(FIRMWARE_REVISION_CHAR, firmware_rev, response=True)

        deadline = time.monotonic() + 5.0
        while len(self.challenge_buffer) < 20 and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

        await self.client.stop_notify(UART_READ_CHAR)

        if len(self.challenge_buffer) < pre_write_len + 1:
            log("    Nothing new arrived after the write-back -- the write may not be the real trigger on this board.")

        if len(self.challenge_buffer) < 20:
            raise RuntimeError(f"only got {len(self.challenge_buffer)}/20 challenge bytes before timeout")

        challenge = bytes(self.challenge_buffer[:20])
        log(f"Challenge (concatenated): {challenge.hex()}")

        if challenge[:3] != SIGNATURE:
            log(
                f"    WARNING: signature {challenge[:3].hex()} != expected {SIGNATURE.hex()} -- "
                "GT may use a different challenge format, or packets got mis-framed above. "
                "Sending a response anyway, purely to observe what the board does."
            )

        try:
            response = build_unlock_response(challenge)
        except Exception as exc:
            log(f"    Could not even build a best-effort response: {exc!r}")
            return

        log(f"Response:  {response.hex()}")
        await self.client.write_gatt_char(UART_WRITE_CHAR, response, response=True)
        log("Unlock response sent.")

    async def subscribe_telemetry(self) -> None:
        uuid_by_name = {v: k for k, v in KNOWN_CHARACTERISTICS.items()}

        def make_handler(name):
            def handler(_char, data: bytearray):
                # Big-endian: confirmed empirically -- speed_rpm only trends
                # smoothly as the wheel spins down when read big-endian (matches
                # the old JS reference's DataView.getUint16() default).
                value = int.from_bytes(data, byteorder="big") if data else None
                extra = ""
                if name == "riding_mode" and value in RIDING_MODE_NAMES:
                    extra = f" ({RIDING_MODE_NAMES[value]})"
                log(f"  [{name}] raw={data.hex()} uint={value}{extra}")
            return handler

        for name in TELEMETRY_CHARACTERISTICS:
            uuid = uuid_by_name.get(name)
            if not uuid:
                continue
            try:
                await self.client.start_notify(uuid, make_handler(name))
                log(f"Subscribed to {name}")
            except Exception as exc:
                log(f"Could not subscribe to {name}: {exc!r}")

    async def send_raw_unlock(self) -> None:
        log(f"=== Writing captured real unlock response directly: {self.raw_unlock_response.hex()} ===")
        await self.client.write_gatt_char(UART_WRITE_CHAR, self.raw_unlock_response, response=True)
        log("Raw unlock response sent.")

    async def read_snapshot(self) -> None:
        uuid_by_name = {v: k for k, v in KNOWN_CHARACTERISTICS.items()}
        for name in ["battery_level", "riding_mode", "safety_headroom", "serial_number", "custom_shaping"]:
            uuid = uuid_by_name.get(name)
            try:
                data = bytes(await self.client.read_gatt_char(uuid))
                value = int.from_bytes(data, byteorder="big") if data else None
                log(f"  [read] {name}: raw={data.hex()} uint={value}")
            except Exception as exc:
                log(f"  [read] {name}: FAILED {exc!r}")

    async def run(self) -> None:
        address = await self.find_board()
        async with BleakClient(address) as client:
            self.client = client
            log(f"Connected to {address}")
            await self.dump_services()

            if self.raw_unlock_response is not None:
                await self.send_raw_unlock()
            elif self.skip_unlock:
                log("=== --skip-unlock set: subscribing to telemetry WITHOUT running the handshake ===")
            else:
                log("=== Initial unlock handshake ===")
                try:
                    await self.unlock()
                except Exception as exc:
                    log(f"Unlock attempt failed: {exc!r} -- continuing anyway to see if telemetry still flows")

            log("=== Reading a snapshot of key characteristics directly (not just notify) ===")
            await self.read_snapshot()

            log("=== Subscribing to telemetry characteristics ===")
            await self.subscribe_telemetry()

            last_unlock = time.monotonic()
            end_time = time.monotonic() + self.duration
            log(f"=== Logging for {self.duration:.0f}s ===")
            while time.monotonic() < end_time:
                await asyncio.sleep(1.0)
                if self.skip_unlock or time.monotonic() - last_unlock < self.reunlock_interval:
                    continue
                try:
                    if self.raw_unlock_response is not None:
                        await self.send_raw_unlock()
                    else:
                        log("=== Re-running unlock handshake ===")
                        await self.unlock()
                except Exception as exc:
                    log(f"Re-unlock failed: {exc!r}")
                last_unlock = time.monotonic()

            log("Done.")


async def scan_all(duration: float) -> None:
    """List every nearby BLE advertisement, unfiltered -- debugging aid for when
    find_board() can't locate the board (wrong name/UUID assumption, or the board
    already has a central connected and has stopped advertising, etc.)."""
    log(f"Listing every BLE advertisement seen over {duration:.0f}s (no filter)...")
    seen = await BleakScanner.discover(timeout=duration, return_adv=True)
    if not seen:
        log("Nothing seen at all -- check the adapter is up and the board is powered on.")
        return
    for address, (device, adv) in seen.items():
        log(
            f"  {address}  name={device.name!r}  rssi={adv.rssi}  "
            f"service_uuids={adv.service_uuids}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--address", help="Skip scanning and connect directly to this BLE address")
    parser.add_argument("--duration", type=float, default=180.0, help="Seconds to log telemetry for (default 180)")
    parser.add_argument(
        "--reunlock-interval", type=float, default=10.0,
        help="Seconds between full re-unlock handshakes (default 10 -- the JS reference project found "
             "the lightweight 'remind' write unreliable and just re-ran the full handshake instead)",
    )
    parser.add_argument(
        "--scan-all", action="store_true",
        help="Just list every nearby BLE advertisement for --duration seconds and exit (debugging aid, "
             "no filtering, no connection attempt)",
    )
    parser.add_argument(
        "--skip-unlock", action="store_true",
        help="Skip the unlock handshake entirely and just try subscribing to telemetry characteristics "
             "directly -- tests whether reads/notifications are gated at all, or only writes are",
    )
    parser.add_argument(
        "--raw-unlock-response", metavar="HEX",
        help="Skip computing a response and write this exact hex byte string to the UART write "
             "characteristic instead -- for testing a value captured from a real handshake "
             "(e.g. via btsnoop_parse.py) directly against the board",
    )
    args = parser.parse_args()

    if args.scan_all:
        asyncio.run(scan_all(args.duration if args.duration != 180.0 else 15.0))
        return

    raw_response = bytes.fromhex(args.raw_unlock_response) if args.raw_unlock_response else None
    spike = OnewheelSpike(args.address, args.duration, args.reunlock_interval, args.skip_unlock, raw_response)
    asyncio.run(spike.run())


if __name__ == "__main__":
    main()
