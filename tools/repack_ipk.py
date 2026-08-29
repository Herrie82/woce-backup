#!/usr/bin/env python3
"""Inject postinst/prerm into an .ipk produced by palm-package, and give it a
control file a package feed can actually use.

palm-package writes a control.tar.gz containing only ./control, so maintainer
scripts have to be added afterwards. The usual recipe for this uses `ar`, which
is not present on a stock Windows box; ar is a simple enough format to handle
directly, and Python's tarfile covers the rest. That keeps the build working on
the machine the app is actually developed on.

The control it writes is also the SDK's placeholder — Section: misc, Maintainer:
N/A <nobody@example.com>, Description: "This is a webOS application." — which
Preware renders as an untitled package in "Unsorted". Passing a metadata JSON
file rewrites those fields and adds the one-line `Source` JSON blob Preware
parses for the title, category, description, licence and post-install flags.

It also strips development files out of data.tar.gz. palm-package excludes
hidden files, VCS and Eclipse metadata and .ipk files, but nothing else, so a
note left in a package directory is copied straight to /usr/palm/applications
— which is how CLAUDE.md shipped in 3.1.1. The patterns live in
packaging/package-exclude.txt. This is done here rather than by passing
--exclude-from to palm-package because an SDK build that does not recognise the
option aborts the whole packaging step, and the older Windows SDK is one of the
paths build.sh looks for.

Usage:  repack_ipk.py <package.ipk> <postinst> <prerm> [metadata.json]
                      [--exclude-from=PATFILE]
"""

import fnmatch
import io
import json
import os
import posixpath
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


# Fields palm-package derives from the package itself. Metadata may not
# override these: the version in appinfo.json stays the single source of truth,
# and a hand-set Installed-Size is just a lie waiting to happen.
DERIVED_FIELDS = ("Package", "Version", "Architecture", "Installed-Size",
                  "webOS-Package-Format-Version", "webOS-Packager-Version")


def apply_metadata(control_text, meta):
    """Returns control_text with metadata fields applied.

    Keys starting with "_" are comments and are ignored, at both levels. The
    `Source` object is serialised to ONE line — a control field cannot span
    lines without continuation markers, and Preware just looks for a "{".
    """
    fields = []          # [(name, value)], original order preserved
    for line in control_text.splitlines():
        if not line.strip() or ":" not in line:
            continue
        name, _, value = line.partition(":")
        fields.append([name.strip(), value.strip()])

    for key, value in meta.items():
        if key.startswith("_"):
            continue
        if key in DERIVED_FIELDS:
            raise SystemExit(
                "metadata may not set %s: it comes from palm-package" % key)
        if key == "Source":
            source = {k: v for k, v in value.items() if not k.startswith("_")}
            # Stamped here rather than carried in the file, so it reflects the
            # build and never goes stale in a checkout.
            source["LastUpdated"] = str(int(time.time()))
            value = json.dumps(source, separators=(",", ":"), sort_keys=True)
            if "\n" in value:
                raise SystemExit("Source JSON must be a single line")
        for field in fields:
            if field[0] == key:
                field[1] = value
                break
        else:
            fields.append([key, value])

    return "".join("%s: %s\n" % (name, value) for name, value in fields)


def load_patterns(path):
    """Returns the exclude patterns in path; blank lines and # comments out."""
    patterns = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line)
    return patterns


def is_excluded(name, patterns):
    """True if the tar member name matches any pattern.

    Names arrive as "./usr/palm/applications/<id>/CLAUDE.md". A pattern with a
    slash is matched against the whole path from the package root; one without
    is matched against every component, so naming a directory takes everything
    under it as well.
    """
    relative = posixpath.normpath(name.lstrip("./"))
    if relative in (".", ""):
        return False

    for pattern in patterns:
        if "/" in pattern:
            if fnmatch.fnmatch(relative, pattern.strip("/")):
                return True
        elif any(fnmatch.fnmatch(part, pattern)
                 for part in relative.split("/")):
            return True
    return False


def strip_data(data_gz, patterns):
    """Returns (new data.tar.gz, [names removed]).

    The original is handed back untouched when nothing matches, so a clean
    build produces the archive palm-package wrote rather than a re-rolled one.
    """
    entries = []
    removed = []

    with tarfile.open(fileobj=io.BytesIO(data_gz), mode="r:gz") as source:
        for member in source.getmembers():
            if is_excluded(member.name, patterns):
                # Directories are dropped whole: their contents match too, by
                # the component rule above.
                if member.isfile() or member.isdir():
                    removed.append(member.name.lstrip("./"))
                continue
            payload = source.extractfile(member).read() if member.isfile() else None
            entries.append((member, payload))

    if not removed:
        return data_gz, []

    # GNU_FORMAT rather than Python's default PAX: a path over 100 characters
    # makes PAX emit an extended header, which busybox tar on device renders as
    # a stray PaxHeaders file next to the real one. Nothing here is close to
    # that today (the longest is 80), but the failure would be silent and would
    # land on the device, and GNU long names are understood there.
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz",
                      format=tarfile.GNU_FORMAT) as target:
        for member, payload in entries:
            if payload is None:
                target.addfile(member)
            else:
                target.addfile(member, io.BytesIO(payload))

    # Installed-Size is left as palm-package computed it. It is an estimate the
    # installer uses for a free-space check, and one that is a few KB high errs
    # in the safe direction; recomputing it would mean guessing at the SDK's
    # own formula.
    return output.getvalue(), removed


def rebuild_control(control_gz, scripts, meta=None):
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
            if meta and member.name.lstrip("./") == "control" and payload is not None:
                payload = apply_metadata(payload.decode("utf-8"), meta).encode("utf-8")
                member.size = len(payload)
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


# Beside the script's own repo, so the build finds it without being told and a
# run from any directory still strips the same things.
DEFAULT_EXCLUDE_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "packaging", "package-exclude.txt")


def main():
    args = list(sys.argv[1:])

    patfile = DEFAULT_EXCLUDE_FILE
    for arg in list(args):
        if arg.startswith("--exclude-from="):
            patfile = arg.split("=", 1)[1]
            args.remove(arg)

    if len(args) not in (3, 4):
        raise SystemExit(__doc__)

    ipk, postinst, prerm = args[0], args[1], args[2]
    metafile = args[3] if len(args) == 4 else None

    for path in [ipk, postinst, prerm, patfile] + ([metafile] if metafile else []):
        if not os.path.isfile(path):
            raise SystemExit("Not found: %s" % path)

    patterns = load_patterns(patfile)

    meta = None
    if metafile:
        with open(metafile, encoding="utf-8") as handle:
            meta = json.load(handle)

    members = read_ar(ipk)
    names = [name for name, _ in members]
    if "control.tar.gz" not in names:
        raise SystemExit("No control.tar.gz in %s (members: %s)" % (ipk, names))

    scripts = {"postinst": postinst, "prerm": prerm}

    rebuilt = []
    stripped = []
    for name, data in members:
        if name == "control.tar.gz":
            data = rebuild_control(data, scripts, meta)
        elif name == "data.tar.gz":
            data, stripped = strip_data(data, patterns)
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

    # Read data.tar.gz back too: this is the check that the package really is
    # free of them, not just that the strip pass thought it was.
    with tarfile.open(fileobj=io.BytesIO(verify["data.tar.gz"]), mode="r:gz") as check:
        survivors = [m.name.lstrip("./") for m in check.getmembers()
                     if is_excluded(m.name, patterns)]
    if survivors:
        raise SystemExit("Verification failed: %s still in data.tar.gz"
                         % ", ".join(sorted(survivors)))

    for name in sorted(stripped):
        print("  stripped from data.tar.gz: %s" % name)

    if meta:
        with tarfile.open(fileobj=io.BytesIO(verify["control.tar.gz"]),
                          mode="r:gz") as check:
            for member in check.getmembers():
                if member.name.lstrip("./") == "control":
                    text = check.extractfile(member).read().decode("utf-8")
        for line in text.splitlines():
            name = line.split(":", 1)[0]
            if name == "Source":
                json.loads(line.split(":", 1)[1].strip())   # must survive Preware
                print("  Source: <%d bytes of feed metadata, parses as JSON>"
                      % len(line))
            else:
                print("  %s" % line)


if __name__ == "__main__":
    main()
