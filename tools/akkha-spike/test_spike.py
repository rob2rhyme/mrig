# Self-test for brahmi_spike.py: build an ASCII-slot stand-in font, re-encode it, shape it with
# HarfBuzz. Needs: python3 -m pip install fonttools uharfbuzz. Run: python3 test_spike.py
import csv
import subprocess
import sys
import tempfile
from pathlib import Path

import uharfbuzz as hb
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

script = Path(__file__).resolve().parent / "brahmi_spike.py"
here = Path(tempfile.mkdtemp(prefix="akkha-spike-"))  # all output goes here, never into the repo

# 1. A stand-in "ASCII-slot" font: k=KA, y=YA, A=AA sign, x=virama, plus a subjoined YA glyph.
names = [".notdef", "space", "ka", "ya", "aa_sign", "virama", "ya_sub"]
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0x20: "space", ord("k"): "ka", ord("y"): "ya", ord("A"): "aa_sign", ord("x"): "virama"})
def box():
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0)); pen.lineTo((50, 500)); pen.lineTo((450, 500)); pen.lineTo((450, 0)); pen.closePath()
    return pen.glyph()
fb.setupGlyf({n: box() for n in names})
fb.setupHorizontalMetrics({n: (500, 50) for n in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "Akkha Test", "styleName": "Regular"})
fb.setupOS2()
fb.setupPost()
addOpenTypeFeaturesFromString(fb.font, """
languagesystem DFLT dflt;
languagesystem latn dflt;
feature liga { sub virama ya by ya_sub; } liga;
""")
src = here / "AkkhaTest.ttf"
fb.save(str(src))

# 2. mapping.csv: the old ASCII slot -> the Devanagari letter.
mapping = here / "mapping.csv"
with open(mapping, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["old", "deva"])
    w.writerows([["k", "क"], ["y", "य"], ["A", "ा"], ["x", "्"]])

# 3. Run the script.
out = here / "AkkhaBrahmiTest.ttf"
run = subprocess.run([sys.executable, "-I", str(script), str(src), str(mapping), str(out)],
                     capture_output=True, text=True)
print(run.stdout.strip())
assert run.returncode == 0, run.stderr

# 4. Check the result.
font = TTFont(out)
cmap = font.getBestCmap()
assert cmap[0x11013] == "ka" and cmap[0x1102C] == "ya" and cmap[0x11038] == "aa_sign" and cmap[0x11046] == "virama"
assert cmap[ord("k")] == "ka", "the old characters still work"
assert any(t.format == 12 for t in font["cmap"].tables)
scripts = [r.ScriptTag for r in font["GSUB"].table.ScriptList.ScriptRecord]
assert "brah" in scripts, scripts
assert font["name"].getDebugName(1) == "Akkha Test Brahmi Test"

def shape(text: str, script: str) -> list[str]:
    blob = hb.Blob.from_file_path(str(out))
    face = hb.Face(blob)
    hbfont = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    buf.script = script
    hb.shape(hbfont, buf, {})
    order = font.getGlyphOrder()
    return [order[i.codepoint] for i in buf.glyph_infos]

brahmi = "\U00011013\U00011046\U0001102C\U00011038"  # KA, VIRAMA, YA, AA sign: क्या
shaped = shape(brahmi, "Brah")
print("Brahmi क्या shapes to:", shaped)
assert shaped == ["ka", "ya_sub", "aa_sign"], shaped
print("Old ASCII kxyA shapes to:", shape("kxyA", "Latn"))

# 5. Refusals: an unmapped character and a missing glyph are clear errors.
bad = here / "bad.csv"
bad.write_text("old,deva\nq,क\n", encoding="utf-8")
r = subprocess.run([sys.executable, "-I", str(script), str(src), str(bad), str(here / "x.ttf")], capture_output=True, text=True)
assert r.returncode != 0 and "has no glyph for 'q'" in r.stderr, r.stderr
bad.write_text("old,deva\nk,श\n", encoding="utf-8")
r = subprocess.run([sys.executable, "-I", str(script), str(src), str(bad), str(here / "x.ttf")], capture_output=True, text=True)
assert r.returncode != 0 and "is not a Devanagari character Akkha maps" in r.stderr, r.stderr
r = subprocess.run([sys.executable, "-I", str(script), str(src), str(mapping), str(src)], capture_output=True, text=True)
assert r.returncode != 0 and "never changed" in r.stderr
print("all checks passed")
