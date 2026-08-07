// Constants ported from Nordic's SnifferAPI (Types.py), the reference Python
// implementation of the nRF Sniffer for Bluetooth LE UART protocol. Kept as
// plain values -- no behavior here, see slip.mjs/packet.mjs/att.mjs for that.

export const SLIP_START = 0xAB;
export const SLIP_END = 0xBC;
export const SLIP_ESC = 0xCD;
export const SLIP_ESC_START = SLIP_START + 1;
export const SLIP_ESC_END = SLIP_END + 1;
export const SLIP_ESC_ESC = SLIP_ESC + 1;

export const PROTOVER_V1 = 1;

// UART protocol packet codes (see sniffer_uart_protocol.pdf)
export const REQ_FOLLOW = 0x00;
export const EVENT_FOLLOW = 0x01;
export const EVENT_PACKET_ADV_PDU = 0x02;
export const EVENT_CONNECT = 0x05;
export const EVENT_PACKET_DATA_PDU = 0x06;
export const REQ_SCAN_CONT = 0x07;
export const EVENT_DISCONNECT = 0x09;
export const SET_TEMPORARY_KEY = 0x0c;
export const PING_REQ = 0x0d;
export const PING_RESP = 0x0e;
export const REQ_VERSION = 0x1b;
export const RESP_VERSION = 0x1c;
export const GO_IDLE = 0xfe;

export const PACKET_TYPE_ADVERTISING = 0x01;
export const PACKET_TYPE_DATA = 0x02;

export const ADV_TYPE_ADV_IND = 0;
export const ADV_TYPE_ADV_DIRECT_IND = 1;
export const ADV_TYPE_ADV_NONCONN_IND = 2;
export const ADV_TYPE_SCAN_REQ = 3;
export const ADV_TYPE_SCAN_RSP = 4;
export const ADV_TYPE_CONNECT_REQ = 5;
export const ADV_TYPE_ADV_SCAN_IND = 6;
export const ADV_TYPE_ADV_EXT_IND = 7;

export const PHY_1M = 0;
export const PHY_2M = 1;
export const PHY_CODED = 2;

// Byte offsets within a decoded (post-SLIP) *response* packet, protocol
// version >= 2 (the only version this firmware -- v4.1.1 -- actually sends).
export const PAYLOAD_LEN_POS = 0; // 2 bytes, LE
export const PROTOVER_POS = 2;
export const PACKETCOUNTER_POS = 3; // 2 bytes, LE
export const ID_POS = 5;
export const PAYLOAD_POS = 6;
export const BLE_HEADER_LEN_POS = 6;
export const FLAGS_POS = 7;
export const CHANNEL_POS = 8;
export const RSSI_POS = 9;
export const EVENTCOUNTER_POS = 10; // 2 bytes, LE
export const TIMESTAMP_POS = 12; // 4 bytes, LE
export const BLEPACKET_POS = 16;

// Protocol version 1 uses a 1-byte payload length at this offset instead.
export const PAYLOAD_LEN_POS_V1 = 1;

export const HEADER_LENGTH = 6;
export const BLE_HEADER_LENGTH = 10;

// L2CAP/ATT, for pulling the unlock handshake out of followed connection
// data. Not part of the sniffer's own UART protocol -- these describe the
// BLE payload the sniffer hands us once we're following a connection.
export const L2CAP_CID_ATT = 0x0004;
export const ATT_OPCODE_WRITE_REQUEST = 0x12;
export const ATT_OPCODE_WRITE_COMMAND = 0x52;

// LL Data PDU LLID field (BlePacket.llid): which kind of data-channel PDU.
export const LLID_CONTINUATION = 0x01; // continuation fragment of an L2CAP SDU
export const LLID_START = 0x02; // start of a new L2CAP SDU (or a whole one)
export const LLID_CONTROL = 0x03; // LL Control PDU (LL_FEATURE_REQ etc, not L2CAP)
