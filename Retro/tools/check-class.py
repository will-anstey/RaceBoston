# Checks a class file for Navigator 3's Java 1.0: its own references
# (Methodref / Fieldref naming this class) must be to members it declares,
# because that VM doesn't search superclasses for them. Reads `javap -v -p`.
#   javap -v -p RetroRace.class | python3 tools/check-class.py RetroRace
import re, sys
name = sys.argv[1]
text = sys.stdin.read()
refs = set(re.findall(r"= (?:Methodref|Fieldref)\s+#\d+\.#\d+\s+// ([\w<>]+):", text))
refs |= set(re.findall(r"= (?:Methodref|Fieldref)\s+#\d+\.#\d+\s+// " + name + r"\.([\w<>]+):", text))
# Declared members: method headers "  ... name(" and fields "  ... name;" at two-space indent.
own = set(re.findall(r"^  [^\n(;=]*?([\w$]+)\(", text, re.M)) | set(re.findall(r"^  [^\n(;=]*?([\w$]+);$", text, re.M)) | {"<init>"}
own.add(name)
bad = sorted(r for r in refs if r not in own)
if bad:
    print(name + ".class refers to inherited members through " + name + " (Navigator 3 cannot find them): " + ", ".join(bad))
    sys.exit(1)
