import os
import time
import uuid


def uuid7() -> uuid.UUID:
    """UUID v7 (RFC 9562): 48-bit Unix ms timestamp, then random bits.

    Clients generate record ids; the server uses this only for rows it creates itself
    (projects, numbering groups, users, jobs).
    """
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ms & 0xFFFF_FFFF_FFFF) << 80
    value |= 0x7 << 76
    value |= ((rand >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return uuid.UUID(int=value)
