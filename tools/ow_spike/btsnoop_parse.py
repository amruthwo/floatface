#!/usr/bin/env python3
"""Parse a raw Android btsnoop_hci.log (from Developer Options > Bluetooth HCI
snoop log) and print ATT-layer traffic (reads/writes/notifications), so we can
see the real Onewheel GT unlock handshake as performed by FutureMotion's own
app instead of guessing from an older reverse-engineered protocol.

Usage:
    ./.venv/bin/python btsnoop_parse.py btsnoop_hci.log
    ./.venv/bin/python btsnoop_parse.py btsnoop_hci.log --address AA:BB:CC:DD:EE:FF

If --address is given, only ATT traffic on connections to/from that BD_ADDR is
shown (recommended -- a phone's snoop log includes ALL Bluetooth traffic:
earbuds, other BLE devices, classic Bluetooth, etc). Without it, everything is
shown and you'll have to eyeball which connection handle is the board.
"""
import argparse
import struct
from datetime import datetime, timezone

BTSNOOP_EPOCH_OFFSET = 0x00E03AB44A676000  # microseconds between 0000-01-01 and 1970-01-01

ATT_OPCODE_NAMES = {
    0x01: "ERROR_RSP",
    0x0A: "READ_REQ",
    0x0B: "READ_RSP",
    0x12: "WRITE_REQ",
    0x13: "WRITE_RSP",
    0x1B: "HANDLE_VALUE_NOTIFICATION",
    0x1D: "HANDLE_VALUE_INDICATION",
    0x1E: "HANDLE_VALUE_CONFIRMATION",
    0x52: "WRITE_CMD",
    0x08: "READ_BY_TYPE_REQ",
    0x09: "READ_BY_TYPE_RSP",
}

ATT_CID = 0x0004


def format_addr(addr_bytes: bytes) -> str:
    return ":".join(f"{b:02X}" for b in reversed(addr_bytes))


class BtSnoopParser:
    def __init__(self, path: str, want_address: str | None):
        self.path = path
        self.want_address = want_address.upper() if want_address else None
        self.handle_to_addr: dict[int, str] = {}
        self.matching_handles: set[int] = set()

    def run(self) -> None:
        with open(self.path, "rb") as f:
            header = f.read(16)
            if not header.startswith(b"btsnoop\x00"):
                raise ValueError("Not a btsnoop file (missing 'btsnoop\\0' magic)")

            while True:
                record_header = f.read(24)
                if len(record_header) < 24:
                    break
                orig_len, incl_len, flags, _drops, ts_usec = struct.unpack(">IIIIq", record_header)
                packet = f.read(incl_len)
                if len(packet) < incl_len:
                    break
                direction_inbound = bool(flags & 0x01)  # 1 = controller->host (inbound to phone)
                unix_ts = (ts_usec - BTSNOOP_EPOCH_OFFSET) / 1_000_000
                self.handle_packet(packet, direction_inbound, unix_ts)

    def handle_packet(self, packet: bytes, inbound: bool, ts: float) -> None:
        if not packet:
            return
        h4_type = packet[0]
        body = packet[1:]

        if h4_type == 0x04:  # HCI Event
            self.handle_event(body)
        elif h4_type == 0x02:  # ACL Data
            self.handle_acl(body, inbound, ts)

    def handle_event(self, body: bytes) -> None:
        if len(body) < 2:
            return
        event_code, param_len = body[0], body[1]
        params = body[2:2 + param_len]

        if event_code == 0x3E and params:  # LE Meta Event
            subevent = params[0]
            # LE Connection Complete (0x01) and LE Enhanced Connection Complete (0x0A)
            # share a compatible prefix: status(1) handle(2) role(1) addr_type(1) addr(6)
            if subevent in (0x01, 0x0A) and len(params) >= 11:
                status = params[1]
                handle = struct.unpack("<H", params[2:4])[0]
                addr = params[6:12]
                if status == 0:
                    addr_str = format_addr(addr)
                    self.handle_to_addr[handle] = addr_str
                    if self.want_address and addr_str == self.want_address:
                        self.matching_handles.add(handle)
                        print(f"[connection] handle=0x{handle:04x} <-> {addr_str}  <-- MATCHES --address")
                    elif not self.want_address:
                        print(f"[connection] handle=0x{handle:04x} <-> {addr_str}")
        elif event_code == 0x05 and len(params) >= 3:  # Disconnection Complete
            handle = struct.unpack("<H", params[1:3])[0]
            self.handle_to_addr.pop(handle, None)
            self.matching_handles.discard(handle)

    def handle_acl(self, body: bytes, inbound: bool, ts: float) -> None:
        if len(body) < 4:
            return
        handle_and_flags = struct.unpack("<H", body[0:2])[0]
        conn_handle = handle_and_flags & 0x0FFF
        data_len = struct.unpack("<H", body[2:4])[0]
        l2cap_data = body[4:4 + data_len]
        if len(l2cap_data) < 4:
            return

        l2cap_len = struct.unpack("<H", l2cap_data[0:2])[0]
        cid = struct.unpack("<H", l2cap_data[2:4])[0]
        if cid != ATT_CID:
            return

        att_pdu = l2cap_data[4:4 + l2cap_len]
        if not att_pdu:
            return

        if self.want_address and conn_handle not in self.matching_handles:
            return

        self.print_att(att_pdu, conn_handle, inbound, ts)

    def print_att(self, pdu: bytes, conn_handle: int, inbound: bool, ts: float) -> None:
        opcode = pdu[0]
        name = ATT_OPCODE_NAMES.get(opcode, f"0x{opcode:02x}")
        addr = self.handle_to_addr.get(conn_handle, f"handle=0x{conn_handle:04x}")
        direction = "board->phone" if inbound else "phone->board"
        when = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3]

        if opcode in (0x12, 0x52, 0x1B, 0x1D) and len(pdu) >= 3:  # has a handle + value
            att_handle = struct.unpack("<H", pdu[1:3])[0]
            value = pdu[3:]
            print(f"{when}  [{addr}] {direction}  {name:28s} att_handle=0x{att_handle:04x}  value={value.hex()}")
        elif opcode in (0x0A, 0x0B) and len(pdu) >= 1:
            rest = pdu[1:]
            print(f"{when}  [{addr}] {direction}  {name:28s} data={rest.hex()}")
        else:
            print(f"{when}  [{addr}] {direction}  {name:28s} raw={pdu.hex()}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logfile", help="Path to the extracted btsnoop_hci.log")
    parser.add_argument("--address", help="Only show ATT traffic for this BD_ADDR, e.g. AA:BB:CC:DD:EE:FF")
    args = parser.parse_args()

    BtSnoopParser(args.logfile, args.address).run()


if __name__ == "__main__":
    main()
