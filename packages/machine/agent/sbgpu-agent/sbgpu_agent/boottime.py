"""The one clock every VM-mode deadline check reads (the launcher's design, H5 and H7): CLOCK_BOOTTIME.  It is monotonic,
wall-clock changes don't move it, and it counts the time a machine spends suspended, so a deadline measured on it still
holds across a suspend.  The launcher's children (vmboot.py) and the agent call boottime_ms() at the moment of each
check; tests replace this one function."""

import time


def boottime_ms():
    """Milliseconds of CLOCK_BOOTTIME."""
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000
