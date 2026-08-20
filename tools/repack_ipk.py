#!/usr/bin/env python3
"""Inject postinst/prerm into an .ipk produced by palm-package.

palm-package writes a control.tar.gz containing only ./control, so maintainer
scripts have to be added afterwards. The usual recipe for this uses `ar`, which
is not present on a stock Windows box; ar is a simple enough format to handle
directly, and Python's tarfile covers the rest. That keeps the build working on
the machine the app is actually developed on.

Usage:  repack_ipk.py <package.ipk> <postinst> <prerm>
"""

import io
import os
import sys
import tarfile
import time

AR_MAGIC = b"!<arch>\n"
AR_HEADER_SIZE = 60


def read_ar(path):
    """Returns [(name, data)] for each member of an ar archive, in order."""
    with open(path, "rb") as handle:
        blob = handle.read()

    if not blob.startswith(AR_MAGIC):
        raise SystemExit("%s is not an ar archive (bad magic)" % path)

    members = []
    offset = len(AR_MAGIC)
    while offset + AR_HEADER_SIZE <= len(blob):
        header = blob[offset:offset + AR_HEADER_SIZE]
        offset += AR_HEADER_SIZE

        name = header[0:16].decode("ascii").strip()
        # GNU ar terminates short names with a slash.
        if name.endswith("/"):
            name = name[:-1]
        size = int(header[48:58].decode("ascii").strip())

        data = blob[offset:offset + size]
        offset += size
        # Members are padded to an even offset.
        if size % 2 == 1:
            offset += 1

        members.append((name, data))

    return members


def write_ar(path, members):
    """Writes members out as an ar archive."""
    mtime = int(time.time())
    with open(path, "wb") as handle:
        handle.write(AR_MAGIC)
        for name, data in members:
            header = (
                name.ljust(16)[:16]
                + str(mtime).ljust(12)[:12]
                + "0".ljust(6)[:6]
                + "0".ljust(6)[:6]
                + "100644".ljust(8)[:8]
                + str(len(data)).ljust(10)[:10]
                + "`\n"
            )
            handle.write(header.encode("ascii"))
            handle.write(data)
            if len(data) % 2 == 1:
                handle.write(b"\n")


def rebuild_control(control_gz, scripts):
    """Returns a new control.tar.gz with the given scripts added.

    Existing members are copied across so palm-package's ./control survives; the
    scripts go in mode 0755 because ipkg will not execute them otherwise.
    """
    entries = []

    with tarfile.open(fileobj=io.BytesIO(control_gz), mode="r:gz") as source:
        for member in source.getmembers():
            if member.name.lstrip("./") in scripts:
                continue  # replaced below
            payload = source.extractfile(member).read() if member.isfile() else None
            entries.append((member, payload))

    output = io.BytesIO()
    # mtime=0 keeps the output byte-identical across rebuilds of the same input.
    with tarfile.open(fileobj=output, mode="w:gz") as target:
        for member, payload in entries:
            if payload is None:
                target.addfile(member)
            else:
                target.addfile(member, io.BytesIO(payload))

        for name, path in sorted(scripts.items()):
            with open(path, "rb") as handle:
                data = handle.read()
            # ipkg runs these with /bin/sh; normalise CRLF so a checkout on
            # Windows does not produce a script the device cannot execute.
            data = data.replace(b"\r\n", b"\n")

            info = tarfile.TarInfo("./" + name)
            info.size = len(data)
            info.mode = 0o755
            info.uid = 0
            info.gid = 0
            info.mtime = 0
            info.type = tarfile.REGTYPE
            target.addfile(info, io.BytesIO(data))

    return output.getvalue()


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)

    ipk, postinst, prerm = sys.argv[1], sys.argv[2], sys.argv[3]

    for path in (ipk, postinst, prerm):
        if not os.path.isfile(path):
            raise SystemExit("Not found: %s" % path)

    members = read_ar(ipk)
    names = [name for name, _ in members]
    if "control.tar.gz" not in names:
        raise SystemExit("No control.tar.gz in %s (members: %s)" % (ipk, names))

    scripts = {"postinst": postinst, "prerm": prerm}

    rebuilt = []
    for name, data in members:
        if name == "control.tar.gz":
            data = rebuild_control(data, scripts)
        rebuilt.append((name, data))

    write_ar(ipk, rebuilt)

    # Read it back so a malformed write is caught here rather than on device.
    verify = dict(read_ar(ipk))
    with tarfile.open(fileobj=io.BytesIO(verify["control.tar.gz"]), mode="r:gz") as check:
        present = [m.name.lstrip("./") for m in check.getmembers()]

    for required in ("control", "postinst", "prerm"):
        if required not in present:
            raise SystemExit("Verification failed: %s missing from control.tar.gz" % required)

    print("  control.tar.gz now contains: %s" % ", ".join(sorted(present)))


if __name__ == "__main__":
    main()
