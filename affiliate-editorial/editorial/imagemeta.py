"""Image sniffing, dimensions and metadata stripping without third-party libs.

Public copies of the owner's images must not carry EXIF/XMP/IPTC (camera
serials, GPS, editing software paths ...).  Only JPEG, PNG and WebP are
accepted for publication.
"""

from __future__ import annotations

import struct
from typing import Optional, Tuple


class ImageFormatError(ValueError):
    pass


def sniff(data: bytes) -> Optional[str]:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


def dimensions(data: bytes) -> Tuple[Optional[int], Optional[int]]:
    mime = sniff(data)
    try:
        if mime == "image/png":
            w, h = struct.unpack(">II", data[16:24])
            return w, h
        if mime == "image/jpeg":
            return _jpeg_dimensions(data)
        if mime == "image/webp":
            return _webp_dimensions(data)
        if mime == "image/gif":
            w, h = struct.unpack("<HH", data[6:10])
            return w, h
    except (struct.error, IndexError):
        pass
    return None, None


def _jpeg_dimensions(data: bytes):
    i = 2
    n = len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        if marker == 0xDA:
            break
        i += 2 + length
    return None, None


def _webp_dimensions(data: bytes):
    chunk = data[12:16]
    if chunk == b"VP8X":
        w = 1 + int.from_bytes(data[24:27], "little")
        h = 1 + int.from_bytes(data[27:30], "little")
        return w, h
    if chunk == b"VP8L":
        b = data[21:25]
        bits = int.from_bytes(b, "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 ":
        w, h = struct.unpack("<HH", data[26:30])
        return w & 0x3FFF, h & 0x3FFF
    return None, None


def strip_metadata(data: bytes) -> bytes:
    mime = sniff(data)
    if mime == "image/jpeg":
        return _strip_jpeg(data)
    if mime == "image/png":
        return _strip_png(data)
    if mime == "image/webp":
        return _strip_webp(data)
    raise ImageFormatError("公開できる画像形式は JPEG / PNG / WebP のみです")


def _strip_jpeg(data: bytes) -> bytes:
    out = bytearray(b"\xff\xd8")
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            raise ImageFormatError("JPEGの構造が不正です")
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0xD9:
            out += data[i:i + 2]
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            out += data[i:i + 2]
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        segment = data[i:i + 2 + length]
        if marker == 0xDA:  # start of scan: copy the rest verbatim
            out += data[i:]
            break
        keep = True
        if marker == 0xE1 or marker == 0xFE or marker == 0xED:  # EXIF/XMP, comment, IPTC
            keep = False
        elif 0xE3 <= marker <= 0xEF:  # other APPn (maker data etc.)
            keep = False
        elif marker == 0xE2 and not segment[4:16].startswith(b"ICC_PROFILE"):
            keep = False
        if keep:
            out += segment
        i += 2 + length
    return bytes(out)


_PNG_DROP = {b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"tIME"}


def _strip_png(data: bytes) -> bytes:
    out = bytearray(data[:8])
    i = 8
    while i + 8 <= len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        ctype = data[i + 4:i + 8]
        end = i + 12 + length
        if end > len(data):
            raise ImageFormatError("PNGの構造が不正です")
        if ctype not in _PNG_DROP:
            out += data[i:end]
        i = end
        if ctype == b"IEND":
            break
    return bytes(out)


def _strip_webp(data: bytes) -> bytes:
    chunks = []
    i = 12
    while i + 8 <= len(data):
        ctype = data[i:i + 4]
        size = struct.unpack("<I", data[i + 4:i + 8])[0]
        padded = size + (size & 1)
        body = data[i + 8:i + 8 + size]
        if ctype not in (b"EXIF", b"XMP "):
            if ctype == b"VP8X":
                flags = body[0] & ~0x0C  # clear EXIF (0x08) and XMP (0x04) bits
                body = bytes([flags]) + body[1:]
            chunks.append(ctype + struct.pack("<I", size) + body + (b"\x00" if size & 1 else b""))
        i += 8 + padded
    payload = b"WEBP" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(payload)) + payload


def has_metadata(data: bytes) -> bool:
    """True when stripping would remove something (used by verification).

    Stripping is idempotent, so an already-cleaned file compares equal.
    """
    try:
        return strip_metadata(data) != data
    except ImageFormatError:
        return True
