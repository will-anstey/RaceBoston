#!/usr/bin/env bash
# Compiles src/RetroRace.java into RetroRace.class for Netscape Navigator 3's
# Java 1.0.2. JDK 11 is the newest javac that can still target Java 6, whose
# bytecode (for code that sticks to Java 1.0 APIs and avoids string "+")
# is the same as Java 1.0's; the class file is then stamped as version 45.3.
set -euo pipefail
cd "$(dirname "$0")/.."
JH=$(/usr/libexec/java_home -v 11 2>/dev/null) || { echo "JDK 11 is needed to compile the applet (RetroRace.class is prebuilt, so this is only for changes)."; exit 1; }
tmp=$(mktemp -d)
"$JH/bin/javac" --release 6 -nowarn -Xlint:-options -g:none -d "$tmp" src/RetroRace.java
python3 - "$tmp/RetroRace.class" RetroRace.class <<'PY'
import sys
b = bytearray(open(sys.argv[1], 'rb').read())
assert b[:4] == b'\xca\xfe\xba\xbe'
b[4:8] = bytes([0, 3, 0, 45])   # minor 3, major 45: JDK 1.0.2 / 1.1
open(sys.argv[2], 'wb').write(b)
PY
rm -rf "$tmp"
# Nothing newer than Java 1.0 may be referenced.
if "$JH/bin/javap" -v RetroRace.class | grep -E "StringBuilder|java/util/|invokedynamic|java/awt/event|javax/" ; then echo "RetroRace.class uses APIs newer than Java 1.0"; exit 1; fi
# Navigator 3's Java only looks for a method or field in the class a reference
# names (it doesn't search superclasses), so every reference to RetroRace
# must be to something RetroRace declares itself.
"$JH/bin/javap" -v -p RetroRace.class | python3 tools/check-class.py RetroRace
echo "RetroRace.class built (class file version 45.3)"
