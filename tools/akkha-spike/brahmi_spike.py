#!/usr/bin/env python3
"""
A1 font spike: make a test copy of the Akkha font that answers to Unicode Brahmi.

    python3 brahmi_spike.py Akkha.ttf mapping.csv AkkhaBrahmiTest.ttf

It changes a copy, never the original:
  1. cmap: each Akkha glyph also answers to its Brahmi code point (U+11000-1107F). The
     font's current characters keep working. Brahmi is above U+FFFF, so a format 12 cmap
     subtable is added.
  2. Script tag: the lookups the font registers today (under 'latn' or 'DFLT') are also
     registered under 'brah', so shapers apply them to Brahmi text.
  3. Name: the family becomes "<family> Brahmi Test", so it installs next to the original.

mapping.csv has a header and two columns: the character the font uses for a glyph today
(its "ASCII slot", e.g. k), or the glyph's name, and the Devanagari letter that glyph is:

    old,deva
    k,क
    A,ा

Use the column name "glyph" instead of "old" to give glyph names. The Brahmi code points come
from the same table as mrig's translit tool (src/lang/tables.ts), so the two always agree.
"""
import copy
import csv
import sys

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

# Devanagari -> Brahmi, exported from mrig's src/lang/tables.ts (AKKHA_BRAHMI).
DEVA_TO_BRAHMI = {
    "अ": 0x11005,
    "आ": 0x11006,
    "इ": 0x11007,
    "ई": 0x11008,
    "उ": 0x11009,
    "ऊ": 0x1100A,
    "ऋ": 0x1100B,
    "ए": 0x1100F,
    "ऐ": 0x11010,
    "ओ": 0x11011,
    "औ": 0x11012,
    "क": 0x11013,
    "ख": 0x11014,
    "ग": 0x11015,
    "घ": 0x11016,
    "ङ": 0x11017,
    "च": 0x11018,
    "छ": 0x11019,
    "ज": 0x1101A,
    "झ": 0x1101B,
    "ञ": 0x1101C,
    "ट": 0x1101D,
    "ठ": 0x1101E,
    "ड": 0x1101F,
    "ढ": 0x11020,
    "ण": 0x11021,
    "त": 0x11022,
    "थ": 0x11023,
    "द": 0x11024,
    "ध": 0x11025,
    "न": 0x11026,
    "प": 0x11027,
    "फ": 0x11028,
    "ब": 0x11029,
    "भ": 0x1102A,
    "म": 0x1102B,
    "य": 0x1102C,
    "र": 0x1102D,
    "ल": 0x1102E,
    "व": 0x1102F,
    "स": 0x11032,
    "ह": 0x11033,
    "ा": 0x11038,
    "ि": 0x1103A,
    "ी": 0x1103B,
    "ु": 0x1103C,
    "ू": 0x1103D,
    "ृ": 0x1103E,
    "े": 0x11042,
    "ै": 0x11043,
    "ो": 0x11044,
    "ौ": 0x11045,
    "ं": 0x11001,
    "्": 0x11046,
    "।": 0x11047,
    "॥": 0x11048,
    "०": 0x11066,
    "१": 0x11067,
    "२": 0x11068,
    "३": 0x11069,
    "४": 0x1106A,
    "५": 0x1106B,
    "६": 0x1106C,
    "७": 0x1106D,
    "८": 0x1106E,
    "९": 0x1106F,
}


def fail(message: str) -> None:
    sys.exit(f"error: {message}")


def read_mapping(font: TTFont, path: str) -> dict[int, str]:
    """Brahmi code point -> glyph name, from mapping.csv."""
    current = font.getBestCmap()
    glyphs = set(font.getGlyphOrder())
    result: dict[int, str] = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        fail(f"{path} has no rows")
    for n, row in enumerate(rows, start=2):
        deva = (row.get("deva") or "").strip()
        if deva not in DEVA_TO_BRAHMI:
            fail(f"{path} line {n}: {deva!r} is not a Devanagari character Akkha maps to Brahmi")
        if "glyph" in row and row["glyph"]:
            glyph = row["glyph"].strip()
            if glyph not in glyphs:
                fail(f"{path} line {n}: no glyph named {glyph!r} in the font")
        else:
            old = row.get("old") or ""
            if len(old) != 1:
                fail(f"{path} line {n}: 'old' must be one character, got {old!r}")
            glyph = current.get(ord(old))
            if glyph is None:
                fail(f"{path} line {n}: the font has no glyph for {old!r} (U+{ord(old):04X})")
        cp = DEVA_TO_BRAHMI[deva]
        if cp in result and result[cp] != glyph:
            fail(f"{path} line {n}: {deva} is already mapped to glyph {result[cp]!r}")
        result[cp] = glyph
    return result


def add_cmap(font: TTFont, extra: dict[int, str]) -> None:
    merged = dict(font.getBestCmap())
    merged.update(extra)
    cmap = font["cmap"]
    # Keep the BMP subtables as they are; add or replace the full-repertoire ones.
    cmap.tables = [t for t in cmap.tables if t.format != 12]
    for platform, encoding in ((3, 10), (0, 4)):
        t = CmapSubtable.newSubtable(12)
        t.platformID, t.platEncID, t.language = platform, encoding, 0
        t.cmap = dict(merged)
        cmap.tables.append(t)
    cmap.tables.sort(key=lambda t: (t.platformID, t.platEncID, t.format))


def add_brah(font: TTFont, from_tag: str | None) -> list[str]:
    """Register the existing lookups under the 'brah' script tag, in GSUB and GPOS."""
    notes = []
    for table_tag in ("GSUB", "GPOS"):
        if table_tag not in font:
            continue
        script_list = font[table_tag].table.ScriptList
        records = script_list.ScriptRecord
        tags = [r.ScriptTag for r in records]
        if "brah" in tags:
            notes.append(f"{table_tag}: already has 'brah'; left as is")
            continue
        if from_tag:
            source = next((r for r in records if r.ScriptTag == from_tag), None)
            if source is None:
                fail(f"{table_tag} has no script {from_tag!r}; it has {tags}")
        else:
            source = next((r for r in records if r.ScriptTag != "DFLT"), None) or records[0]
        rec = otTables.ScriptRecord()
        rec.ScriptTag = "brah"
        rec.Script = copy.deepcopy(source.Script)
        records.append(rec)
        records.sort(key=lambda r: r.ScriptTag)
        script_list.ScriptCount = len(records)
        notes.append(f"{table_tag}: 'brah' now uses the lookups of {source.ScriptTag!r} (scripts: {sorted(tags + ['brah'])})")
    return notes


def rename(font: TTFont) -> str:
    name = font["name"]
    family = name.getDebugName(16) or name.getDebugName(1) or "Akkha"
    new_family = f"{family} Brahmi Test"
    for rec in list(name.names):
        if rec.nameID in (1, 16):
            name.setName(new_family, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID in (3, 4):
            style = name.getDebugName(2) or "Regular"
            name.setName(f"{new_family} {style}", rec.nameID, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 6:
            name.setName(new_family.replace(" ", "") + "-Regular", rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    return new_family


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--from-script=")]
    from_tag = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--from-script=")), None)
    if len(args) != 3:
        sys.exit(__doc__)
    src, mapping_path, out = args
    if src == out:
        fail("the output must be a new file; the original font is never changed")
    font = TTFont(src)
    mapping = read_mapping(font, mapping_path)
    add_cmap(font, mapping)
    notes = add_brah(font, from_tag)
    family = rename(font)
    font.save(out)
    print(f"Saved {out} as family {family!r}")
    print(f"  {len(mapping)} glyphs now answer to Brahmi code points")
    for note in notes:
        print(f"  {note}")
    missing = sorted(set(DEVA_TO_BRAHMI.values()) - set(mapping))
    if missing:
        print(f"  {len(missing)} Akkha characters are not in mapping.csv yet: "
              + " ".join(f"U+{cp:04X}" for cp in missing[:12]) + (" …" if len(missing) > 12 else ""))


if __name__ == "__main__":
    main()
