#!/usr/bin/env python3
"""Generates golden SLIP/packet-framing vectors straight from Nordic's own
SnifferAPI (Packet.PacketReader), so the JS port in ../slip.mjs and
../packet.mjs can be checked byte-for-byte against the real algorithm
without needing sniffer hardware attached.

Bypasses PacketReader.__init__ (which opens a real serial port) via
__new__ + a fake Uart that just records what was written, since
encodeToSLIP/sendPacket don't actually touch the serial port itself.

Run with the venv already set up for tools/sniffer_capture:
    ../../sniffer_capture/.venv/bin/python gen_golden_vectors.py
"""
import json
from pathlib import Path

from SnifferAPI import Packet
from SnifferAPI.Types import SLIP_START, SLIP_END, SLIP_ESC


class FakeUart:
    def __init__(self):
        self.writes = []

    def writeList(self, array):
        self.writes.append(list(array))


def make_reader():
    reader = Packet.PacketReader.__new__(Packet.PacketReader)
    reader.uart = FakeUart()
    reader.packetCounter = 0
    return reader


vectors = {}

# 1. Raw SLIP encode/decode round trip, including every escape-worthy byte.
r = make_reader()
raw = [0x00, 0x01, SLIP_START, 0x02, SLIP_END, 0x03, SLIP_ESC, 0xFF, SLIP_START, SLIP_ESC, SLIP_END]
vectors["slip_roundtrip"] = {"raw": raw, "encoded": r.encodeToSLIP(raw)}

# 2. Real request packets, in order, sharing one packetCounter sequence --
# exactly what a live scan-then-follow session sends.
r = make_reader()
r.sendScan()
r.sendTK([0] * 16)
r.sendFollow([0x94, 0xA9, 0xA8, 0x35, 0xC4, 0xB1])
r.sendPingReq()
vectors["request_sequence"] = {
    "packetsHex": ["".join(f"{b:02x}" for b in w) for w in r.uart.writes],
}

# 3. A synthetic ADV_IND response packet (protocol v3), run through the real
# Packet class to cross-check readBlePacket/parseBlePacket in packet.mjs --
# not just that we don't crash, but that address/name/RSSI/etc. come out
# identical to Nordic's own parser.
def le(value, size):
    return [(value >> (8 * i)) & 0xFF for i in range(size)]


def build_response(payload_id, payload):
    payload_len = le(len(payload), 2)
    header = payload_len + [3] + le(0, 2) + [payload_id]
    return header + payload


on_air_addr = [0xB1, 0xC4, 0x35, 0xA8, 0xA9, 0x94]  # reversed 94:a9:a8:35:c4:b1
name = b"ow123456"
ad_struct = [1 + len(name), 0x09] + list(name)
adv_pdu_length = 6 + len(ad_struct)
ble_bytes = (
    [0xD6, 0xBE, 0x89, 0x8E]  # ADV_ACCESS_ADDRESS
    + [0x00]  # advType=ADV_IND, txAddrType=0
    + [adv_pdu_length]
    + [0x00]  # padding byte the radio HW inserts after the 2-byte PDU header (S1), stripped during parsing
    + on_air_addr
    + ad_struct
)
flags = 0b0001  # crcOK=1, direction=0, encrypted=0, phy=PHY_1M
adv_payload = [10, flags, 37, 40] + le(1234, 2) + le(5_000_000, 4) + ble_bytes
from SnifferAPI.Types import EVENT_PACKET_ADV_PDU  # noqa: E402

adv_packet_list = build_response(EVENT_PACKET_ADV_PDU, adv_payload)
# Packet.Packet mutates its packetList argument in place (strips the S1
# padding byte, rewrites the length field) -- parse a copy so the exported
# "raw wire bytes" vector below still has the padding byte a real capture
# would actually contain.
parsed = Packet.Packet(list(adv_packet_list))
assert parsed.valid and parsed.OK, "synthetic ADV packet failed to parse"
assert parsed.blePacket.name == '"ow123456"', parsed.blePacket.name
assert parsed.blePacket.advAddress[:6] == [0x94, 0xA9, 0xA8, 0x35, 0xC4, 0xB1]

vectors["response_adv_packet"] = {
    "packetListHex": "".join(f"{b:02x}" for b in adv_packet_list),
    "expected": {
        "advType": parsed.blePacket.advType,
        "name": parsed.blePacket.name,
        "advAddress": parsed.blePacket.advAddress,
        "RSSI": parsed.RSSI,
        "channel": parsed.channel,
        "crcOK": parsed.crcOK,
        "OK": parsed.OK,
    },
}

# 4. A synthetic DATA PDU carrying a single-fragment ATT Write Request (LLID
# start, no continuation needed) -- cross-checks the DATA-PDU half of
# readBlePacket/parseBlePacket (llid/payload), which att.mjs's L2CAP
# reassembler then consumes. att.mjs itself has no SnifferAPI equivalent
# (Nordic just writes pcap and lets Wireshark decode ATT), so this only
# validates the packet.mjs input it depends on, not the reassembly logic.
from SnifferAPI.Types import EVENT_PACKET_DATA_PDU  # noqa: E402

att_write = [0x12] + le(0x0016, 2) + [0xAA, 0xBB, 0xCC]  # opcode, handle, value
l2cap = le(len(att_write), 2) + le(0x0004, 2) + att_write  # length, CID=ATT
ll_payload = l2cap
conn_header_byte = 0x02  # llid=START(2), sn=0, nesn=0, md=0
data_ble_bytes = (
    [0xD6, 0xBE, 0x89, 0x8E]  # access address (arbitrary for a data PDU test)
    + [conn_header_byte]
    + [len(ll_payload)]
    + [0x00]  # S1 padding byte, same as ADV PDUs
    + ll_payload
)
data_payload = [10, flags, 37, 40] + le(1235, 2) + le(5_100_000, 4) + data_ble_bytes
data_packet_list = build_response(EVENT_PACKET_DATA_PDU, data_payload)
parsed_data = Packet.Packet(list(data_packet_list))  # copy -- see note above
assert parsed_data.valid and parsed_data.OK
assert parsed_data.blePacket.llid == 2
assert list(parsed_data.blePacket.payload) == ll_payload, parsed_data.blePacket.payload

vectors["response_data_packet"] = {
    "packetListHex": "".join(f"{b:02x}" for b in data_packet_list),
    "expected": {
        "llid": parsed_data.blePacket.llid,
        "payloadHex": "".join(f"{b:02x}" for b in parsed_data.blePacket.payload),
    },
}

out_path = Path(__file__).parent / "golden.json"
out_path.write_text(json.dumps(vectors, indent=2))
print(f"Wrote {out_path}")
for k, v in vectors.items():
    print(f"  {k}: {v if k != 'request_sequence' else len(v['packetsHex'])} packets")
