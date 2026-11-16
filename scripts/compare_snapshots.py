#!/usr/bin/env python3
# Compares two systems' snapshot measurements (from scripts/snapshots.mjs): the same parts, in the
# same places (within a tolerance in px, for fonts that rasterise differently), in the same colours.
#   python3 scripts/compare_snapshots.py <folder a> <os a> <folder b> <os b> [tolerance px] [views]
# views: a comma list (bar,main) to compare only those; setup differs between systems on purpose.
import json, sys, os
a_dir, a_os, b_dir, b_os = sys.argv[1:5]
tol = int(sys.argv[5]) if len(sys.argv) > 5 else 0
views = sys.argv[6].split(",") if len(sys.argv) > 6 else None
bad = 0
# "Fully round" is stored as a different huge number on each system; it looks the same.
full = lambda r: r.endswith("px") and "e+" in r
for name in sorted(os.listdir(a_dir)):
    if not name.startswith(a_os + "-") or not name.endswith(".json") or name.endswith(".script.json"): continue
    # "darwin-caption-markdown-dark.json" is the view "caption-markdown".
    if views and name[len(a_os) + 1:-len(".json")].rsplit("-", 1)[0] not in views: continue
    other = os.path.join(b_dir, b_os + name[len(a_os):])
    if not os.path.exists(other): print(f"{name}: no {b_os} version"); bad += 1; continue
    A, B = json.load(open(os.path.join(a_dir, name))), json.load(open(other))
    diffs = []
    if A["body"] != B["body"]: diffs.append(f"body {A['body']} vs {B['body']}")
    if "main" in name and B.get("controls"): print(f"   {b_os} window buttons overlay: {B['controls']}")
    key = lambda p: (p["sel"], p["i"])
    bm = {key(p): p for p in B["parts"]}
    for p in A["parts"]:
        q = bm.pop(key(p), None)
        if not q: diffs.append(f"{p['sel']}#{p['i']} '{p['text'][:20]}' only on {a_os}"); continue
        for f in ["x", "y", "w", "h"]:
            if abs(p[f] - q[f]) > tol: diffs.append(f"{p['sel']}#{p['i']} '{p['text'][:20]}' {f} {p[f]} vs {q[f]}")
        for f in ["bg", "color", "font", "size", "radius"]:
            if f == "radius" and full(p[f]) and full(q[f]): continue
            if p[f] != q[f]: diffs.append(f"{p['sel']}#{p['i']} '{p['text'][:20]}' {f} {p[f]} vs {q[f]}")
    for k, q in bm.items(): diffs.append(f"{k[0]}#{k[1]} '{q['text'][:20]}' only on {b_os}")
    print(f"{name[len(a_os)+1:-5]:22} {'same' if not diffs else str(len(diffs)) + ' differences'}")
    for d in diffs[:6]: print("   ", d)
    bad += bool(diffs)
sys.exit(1 if bad else 0)
