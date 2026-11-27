"""Vectrail DJI Wireless Import Windows Sidecar.

Implements the BLE GATT pairing/wake/Wi-Fi credential flow, Windows netsh
Wi-Fi association, and DUML-over-UDP media list query based on the MIT-licensed
OsmoOffload / KonradIT/osmosis protocol documentation.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import socket
import struct
import subprocess
import tempfile
import time
from xml.sax.saxutils import escape as xml_escape
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000
SOF = 0x55
OVERHEAD = 13
FLAGS_REQUEST = 0x40
FLAGS_RESPONSE = 0xC0

DJI_COMPANY_IDS = {0x08AA, 0xAA08}
XTRA_COMPANY_IDS = {0xAAF7, 0xF7AA}
NAME_PREFIXES = (
    "OsmoPocket4P",
    "OsmoPocket4",
    "OsmoPocket3",
    "OsmoAction",
    "OsmoNano",
    "Osmo360",
    "XtraEdgePro",
    "Osmo",
)
MODEL_NAMES = {
    0x0006: "Osmo Action",
    0x0010: "Osmo Action 2",
    0x0012: "Osmo Action 3",
    0x0014: "Osmo Action 4",
    0x0015: "Osmo Action 5 Pro",
    0x0017: "Osmo 360",
    0x0018: "Osmo Action 6",
    0x0019: "Osmo Nano",
    0x0020: "Osmo Pocket 3",
    0x0021: "Osmo Pocket 4",
    0x0022: "Osmo Pocket 4 Pro",
}

REF_HANDSHAKE = bytes.fromhex(
    "000064006400c005140000640000019001c005140000640014006400c00514000064000101040102"
)
LIST_BASE = bytes.fromhex(
    "4a002a10010000000000010000002d000d0100ffffffffffffffff000100000000000000000000000000"
)
LIST_TRIGGER = bytes.fromhex("4a040e1001000000000001000000")
APP_PRESENCE = bytes.fromhex("170046237c415050000000000002")


def crc8(data: bytes) -> int:
    c = 0x77
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0x8C if (c & 1) else (c >> 1)
    return c


def crc16(data: bytes) -> int:
    c = 0x3692
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0x8408 if (c & 1) else (c >> 1)
    return c


def encode_duml(sender: int, receiver: int, msg_id: int, flags: int, cmd_set: int, cmd_id: int, payload: bytes = b"") -> bytes:
    total = OVERHEAD + len(payload)
    head = bytes([SOF, total & 0xFF, 0x04 | ((total >> 8) & 0x03)])
    head += bytes([crc8(head)])
    body = bytes([sender, receiver, msg_id & 0xFF, (msg_id >> 8) & 0xFF, flags, cmd_set, cmd_id]) + payload
    frame = head + body
    c16 = crc16(frame)
    return frame + bytes([c16 & 0xFF, (c16 >> 8) & 0xFF])


def iter_duml_frames(raw: bytes):
    i = 0
    n = len(raw)
    while i + OVERHEAD <= n:
        if raw[i] != SOF:
            i += 1
            continue
        total = (raw[i + 1] | (raw[i + 2] << 8)) & 0x3FF
        ver = raw[i + 2] >> 2
        if ver != 1 or total < OVERHEAD or i + total > n or crc8(raw[i : i + 3]) != raw[i + 3]:
            i += 1
            continue
        want = raw[i + total - 2] | (raw[i + total - 1] << 8)
        if crc16(raw[i : i + total - 2]) != want:
            i += 1
            continue
        yield (
            raw[i + 4],
            raw[i + 5],
            raw[i + 6] | (raw[i + 7] << 8),
            raw[i + 8],
            raw[i + 9],
            raw[i + 10],
            raw[i + 11 : i + total - 2],
        )
        i += total


def pack_str(s: str) -> bytes:
    raw = s.encode("utf-8")
    return bytes([len(raw)]) + raw


def parse_packed_reply(payload: bytes) -> str:
    if len(payload) < 2:
        return ""
    n = payload[1]
    return payload[2 : 2 + n].decode("utf-8", errors="replace")


def resolve_model(mfr_data: dict[int, bytes], name: str) -> tuple[int | None, str]:
    for cid, payload in mfr_data.items():
        if cid not in (DJI_COMPANY_IDS | XTRA_COMPANY_IDS):
            continue
        if len(payload) >= 12 and (payload[10] | (payload[11] << 8)) == 218:
            return 0x0022, "Osmo Pocket 4 Pro"
        if payload and payload[0] in MODEL_NAMES:
            return payload[0], MODEL_NAMES[payload[0]]
    for prefix, mid, disp in (
        ("OsmoPocket4P", 0x0022, "Osmo Pocket 4 Pro"),
        ("OsmoPocket4", 0x0021, "Osmo Pocket 4"),
        ("OsmoPocket3", 0x0020, "Osmo Pocket 3"),
        ("OsmoNano", 0x0019, "Osmo Nano"),
        ("Osmo360", 0x0017, "Osmo 360"),
        ("XtraEdgePro", 0x0015, "Xtra Edge Pro"),
        ("OsmoAction6", 0x0018, "Osmo Action 6"),
        ("OsmoAction5", 0x0015, "Osmo Action 5 Pro"),
        ("OsmoAction4", 0x0014, "Osmo Action 4"),
    ):
        if name.startswith(prefix):
            return mid, disp
    return None, name or "Unknown DJI Camera"


async def cmd_scan(timeout: float) -> dict:
    from bleak import BleakScanner

    results = await BleakScanner.discover(timeout=timeout, return_adv=True)
    cameras = []
    for address, (device, adv) in results.items():
        name = adv.local_name or device.name or ""
        is_dji = bool(set(adv.manufacturer_data) & (DJI_COMPANY_IDS | XTRA_COMPANY_IDS))
        is_name = name.startswith(NAME_PREFIXES)
        has_fff0 = any("fff0" in (u or "").lower() for u in adv.service_uuids)
        if not (is_dji or is_name or has_fff0):
            continue
        mid, mname = resolve_model(adv.manufacturer_data, name)
        cameras.append({"address": address, "name": name, "rssi": adv.rssi, "model_id": mid, "model_name": mname})
    cameras.sort(key=lambda c: -c["rssi"])
    return {"ok": True, "cameras": cameras}


def run_netsh(*args: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["netsh", *args],
        capture_output=True,
        text=False,
        creationflags=CREATE_NO_WINDOW,
        timeout=12,
    )
    return proc.returncode or 0, proc.stdout.decode("mbcs", errors="replace")


def current_wifi_profile() -> str | None:
    _, txt = run_netsh("wlan", "show", "interfaces")
    m = re.search(r"^\s*(?:Profile|配置文件)\s*:\s*(.+)$", txt, re.M | re.I)
    return m.group(1).strip() if m else None


def join_wifi_wpa2(ssid: str, password: str, timeout: float = 25.0) -> str:
    if current_wifi_profile() == ssid:
        ip_out = subprocess.run(["ipconfig"], capture_output=True, creationflags=CREATE_NO_WINDOW).stdout.decode("mbcs", errors="replace")
        m = re.search(r"IPv4[^:]*:\s*(192\.168\.2\.\d+)", ip_out)
        if m:
            return m.group(1)
    safe_ssid = xml_escape(ssid)
    safe_password = xml_escape(password)
    xml = f"""<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>{safe_ssid}</name>
  <SSIDConfig><SSID><name>{safe_ssid}</name></SSID><nonBroadcast>false</nonBroadcast></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{safe_password}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>"""
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False, encoding="utf-8") as f:
        f.write(xml)
        xml_path = Path(f.name)
    try:
        rc, out = run_netsh("wlan", "add", "profile", f"filename={xml_path}", "user=current")
        if rc != 0:
            raise RuntimeError(f"netsh add profile failed: {out.strip()}")
    finally:
        xml_path.unlink(missing_ok=True)
    rc, out = run_netsh("wlan", "connect", f"name={ssid}")
    if rc != 0 and "location" not in out.lower():
        raise RuntimeError(f"netsh connect failed: {out.strip()}")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ip_out = subprocess.run(["ipconfig"], capture_output=True, creationflags=CREATE_NO_WINDOW).stdout.decode("mbcs", errors="replace")
        m = re.search(r"IPv4[^:]*:\s*(192\.168\.2\.\d+)", ip_out)
        if m:
            return m.group(1)
        time.sleep(0.8)
    raise TimeoutError(f"Timed out waiting for camera AP DHCP address for SSID {ssid}")


def decode_manifest_records(buf: bytes, storage: int) -> list[dict]:
    medias = []
    i = 0
    while i < len(buf):
        if i + 6 <= len(buf) and buf[i] == 0x1A and buf[i + 2 : i + 5] == b"\x00\x00\x00" and buf[i + 5] == 1:
            slen = buf[i + 1] - 6
            val = buf[i + 6 : i + 6 + slen]
            if slen >= 5 and len(val) == slen and val.startswith(b"DCIM/"):
                medias.append((i, i + 6 + slen, val.decode("ascii", "replace")))
                i += 6 + slen
                continue
        i += 1
    out = []
    for k, (pos, end, mpath) in enumerate(medias):
        lo = medias[k - 1][1] if k else 0
        hi = medias[k + 1][0] if k + 1 < len(medias) else len(buf)
        parts = mpath.split("/")
        folder = parts[1] if len(parts) > 1 else ""
        base = mpath.rsplit("/", 1)[-1]
        ext = ""
        needle = (base + ".").encode()
        j = lo
        while j < hi - 2 - len(needle):
            if buf[j] == 0x0D and buf[j + 2 : j + 2 + len(needle)] == needle:
                ext = buf[j + 2 + len(needle) : j + 2 + buf[j + 1]].decode("ascii", "replace").upper()
                break
            j += 1
        handle = size = 0
        star = False
        p = lo
        while p < pos - 1:
            if buf[p] == 0x19 and buf[p + 1] == 0x06 and p >= 1 and buf[p - 1] in (0xFE, 0xFF):
                if p - 10 >= 0:
                    handle = struct.unpack_from("<I", buf, p - 10)[0]
                if p - 14 >= 0:
                    size = struct.unpack_from("<I", buf, p - 14)[0]
                if p + 8 < len(buf) and buf[p + 7] != 0x1A and buf[p + 8] in (0, 1):
                    star = buf[p + 8] == 1
                break
            p += 1
        name = f"{base}.{ext}" if ext else base
        out.append({"folder": folder, "name": name, "media_path": mpath, "ext": ext, "handle": handle, "size": size, "storage": storage, "star": star})
    return out


async def cmd_connect_and_list(address: str, port: int, poke: bool) -> dict:
    from bleak import BleakClient, normalize_uuid_16

    char_fff4 = normalize_uuid_16(0xFFF4)
    char_fff5 = normalize_uuid_16(0xFFF5)
    prev_wifi = current_wifi_profile()
    rx_frames: list[tuple] = []
    waiters = []
    msg_seq = 0x2100

    def next_id() -> int:
        nonlocal msg_seq
        msg_seq += 1
        return msg_seq

    def on_notify(_char, data: bytearray):
        for f in iter_duml_frames(bytes(data)):
            rx_frames.append(f)
            for pred, fut in list(waiters):
                if not fut.done() and pred(f):
                    fut.get_loop().call_soon_threadsafe(fut.set_result, f)
                    waiters.remove((pred, fut))

    async with BleakClient(address, timeout=20.0) as client:
        await client.start_notify(char_fff4, on_notify)
        try:
            await client.start_notify(char_fff5, on_notify)
        except Exception:
            pass
        try:
            await client.write_gatt_char(char_fff4, b"\x01\x00", response=True)
        except Exception:
            pass
        await asyncio.sleep(0.25)

        await client.write_gatt_char(char_fff5, encode_duml(0x02, 0xF0, next_id(), FLAGS_REQUEST, 0x00, 0x2B, b"\x04\x00"), response=False)
        await asyncio.sleep(0.2)

        loop = asyncio.get_running_loop()
        approval_fut = loop.create_future()
        waiters.append((lambda f: f[4] == 0x07 and f[5] == 0x46 and (f[3] & 0xE0) == FLAGS_REQUEST, approval_fut))

        pin_payload = pack_str("vectrail-win") + pack_str("osmo")
        pin_fut = loop.create_future()
        waiters.append((lambda f: f[4] == 0x07 and f[5] == 0x45 and (f[3] & 0xE0) != FLAGS_REQUEST, pin_fut))
        await client.write_gatt_char(char_fff5, encode_duml(0x02, 0x07, next_id(), FLAGS_REQUEST, 0x07, 0x45, pin_payload), response=False)
        pin_reply = await asyncio.wait_for(pin_fut, timeout=5.0)
        already = len(pin_reply[6]) >= 2 and pin_reply[6][1] == 0x01
        if not already:
            req = await asyncio.wait_for(approval_fut, timeout=90.0)
            await client.write_gatt_char(char_fff5, encode_duml(0x02, 0x07, req[2], FLAGS_RESPONSE, 0x07, 0x46, b"\x00"), response=False)

        await client.write_gatt_char(char_fff5, encode_duml(0x02, 0x1C, next_id(), FLAGS_REQUEST, 0x53, 0x10, bytes(4)), response=False)
        await asyncio.sleep(0.5)

        ssid_fut = loop.create_future()
        waiters.append((lambda f: f[4] == 0x07 and f[5] == 0x07 and (f[3] & 0xE0) != FLAGS_REQUEST, ssid_fut))
        await client.write_gatt_char(char_fff5, encode_duml(0x02, 0x07, next_id(), FLAGS_REQUEST, 0x07, 0x07), response=False)
        ssid = parse_packed_reply((await asyncio.wait_for(ssid_fut, timeout=4.0))[6])

        await asyncio.sleep(0.4)
        pass_fut = loop.create_future()
        waiters.append((lambda f: f[4] == 0x07 and f[5] == 0x0E and (f[3] & 0xE0) != FLAGS_REQUEST, pass_fut))
        await client.write_gatt_char(char_fff5, encode_duml(0x02, 0x07, next_id(), FLAGS_REQUEST, 0x07, 0x0E), response=False)
        password = parse_packed_reply((await asyncio.wait_for(pass_fut, timeout=4.0))[6])

    join_wifi_wpa2(ssid, password, timeout=25.0)

    cam_ip = "192.168.2.1"
    if poke:
        try:
            with socket.create_connection((cam_ip, 7001), timeout=1.5) as s:
                s.sendall(encode_duml(0x02, 0x07, 0x8092, FLAGS_REQUEST, 0x07, 0x45, pack_str("vectrail-win") + pack_str("osmo")))
            time.sleep(0.4)
        except OSError:
            pass

    def udp_hdr(pkt_type: int, plen: int, sid: int, seq: int) -> bytes:
        w0 = (1 << 15) | ((8 + plen) & 0x3FFF)
        b = bytes([w0 & 0xFF, w0 >> 8, sid & 0xFF, sid >> 8, seq & 0xFF, seq >> 8, pkt_type])
        x = 0
        for v in b:
            x ^= v
        return b + bytes([x])

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(0.25)
    try:
        sid = random.randint(0x1000, 0xFFFE)
        base_seq = random.randint(0x1000, 0xF000) & 0xFFF8
        syn = bytes([base_seq & 0xFF, base_seq >> 8]) + REF_HANDSHAKE[2:]
        sock.sendto(udp_hdr(0x00, len(syn), sid, 0) + syn, (cam_ip, port))
        time.sleep(0.5)
        udp_seq = (base_seq + 8) & 0xFFFF
        duml_seq = 0xA000
        cmd_ctr = 0

        def send_dl(cs: int, ci: int, pl: bytes, rx: int = 0x01):
            nonlocal udp_seq, duml_seq, cmd_ctr
            cmd_ctr += 1
            ack = (udp_seq - 8) & 0xFFFF
            rt = bytes([ack & 0xFF, ack >> 8, udp_seq & 0xFF, udp_seq >> 8, 0, 0, 0, 0, cmd_ctr & 0xFF, 0x01, 0, 0])
            fr = encode_duml(0x02, rx, duml_seq, FLAGS_REQUEST, cs, ci, pl)
            duml_seq = (duml_seq + 1) & 0xFFFF
            sock.sendto(udp_hdr(0x05, len(rt) + len(fr), sid, udp_seq) + rt + fr, (cam_ip, port))
            udp_seq = (udp_seq + 8) & 0xFFFF

        send_dl(0x00, 0x88, APP_PRESENCE, rx=0x28)
        send_dl(0x00, 0x26, LIST_BASE, rx=0x01)
        time.sleep(0.3)
        send_dl(0x00, 0x26, LIST_TRIGGER, rx=0x01)
        blob = bytearray()
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            try:
                blob += sock.recv(65536)
            except socket.timeout:
                pass
        chunks = bytearray()
        for _s, _r, _mid, _fl, cs, ci, pl in iter_duml_frames(bytes(blob)):
            if cs == 0x00 and ci == 0x27 and len(pl) > 10 and pl[0] == 0x4A and pl[1] == 0x01:
                chunks += pl[10:]
        media = decode_manifest_records(bytes(chunks), 0)
        return {"ok": True, "ssid": ssid, "base_url": f"http://{cam_ip}", "previous_wifi": prev_wifi, "media": media}
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    s_scan = sub.add_parser("scan")
    s_scan.add_argument("--timeout", type=float, default=6.0)
    s_conn = sub.add_parser("connect-and-list")
    s_conn.add_argument("--address", required=True)
    s_conn.add_argument("--port", type=int, default=9004)
    s_conn.add_argument("--poke", type=int, default=1)
    s_rest = sub.add_parser("restore-wifi")
    s_rest.add_argument("--profile", required=True)
    args = parser.parse_args()
    try:
        if args.cmd == "scan":
            res = asyncio.run(cmd_scan(args.timeout))
        elif args.cmd == "connect-and-list":
            res = asyncio.run(cmd_connect_and_list(args.address, args.port, bool(args.poke)))
        elif args.cmd == "restore-wifi":
            run_netsh("wlan", "connect", f"name={args.profile}")
            res = {"ok": True}
        else:
            res = {"ok": False, "error": f"Unknown command: {args.cmd}"}
    except Exception as exc:
        res = {"ok": False, "error": str(exc)}
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
