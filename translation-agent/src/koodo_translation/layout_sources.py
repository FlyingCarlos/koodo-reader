"""Source-only geometry for formula groups and validated visual layout overrides."""

import hashlib
import json
import re
from pathlib import Path

import pymupdf

from .storage import write_private_json
from .structure import compact, contains, monospace

VERSION = 1
MATH = re.compile(r"[≤≥∈∑∏∫√∞ℤ∀∃]|(?:\b(?:max|min|s\.t\.)\b)|[=<>]")


def source_lines(page, blocks):
    blocks = [b for b in blocks if any(a["page"] == page.number + 1 for a in b["anchors"])]
    normalized = {b["id"]: compact(b["text"]) for b in blocks}
    lines = sorted(
        [
            line
            for b in page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~4)["blocks"]
            if b["type"] == 0
            for line in b["lines"]
            if any(s["text"].strip() for s in line["spans"])
        ],
        key=lambda line: (round(line["bbox"][1], 2), line["bbox"][0]),
    )
    result = []
    for index, line in enumerate(lines):
        text = "".join(s["text"] for s in line["spans"])
        owners = [
            b
            for b in blocks
            if b["kind"] != "image"
            and compact(text) in normalized[b["id"]]
            and any(
                a["page"] == page.number + 1 and contains(a["bbox"], line) for a in b["anchors"]
            )
        ]
        owner = min(
            owners,
            key=lambda b: min(
                pymupdf.Rect(a["bbox"]).get_area()
                for a in b["anchors"]
                if a["page"] == page.number + 1
            ),
            default=None,
        )
        spans = [
            {k: s[k] for k in ["text", "font", "size", "flags", "bbox"]} for s in line["spans"]
        ]
        count = max(1, len(text.strip()))
        math_chars = sum(
            len(s["text"].strip())
            for s in spans
            if re.search(r"type3|symbol|math", s["font"], re.I)
        )
        result.append(
            {
                "id": f"p{page.number + 1:04d}-line{index:04d}",
                "page": page.number + 1,
                "bbox": list(line["bbox"]),
                "text": text,
                "block_id": owner["id"] if owner else None,
                "inline_source": any(
                    b["id"] != (owner["id"] if owner else None)
                    and b["kind"] == "paragraph"
                    and len(b["text"]) > len(text) * 2
                    and any(
                        a["page"] == page.number + 1 and contains(a["bbox"], line)
                        for a in b["anchors"]
                    )
                    for b in blocks
                ),
                "math_font": math_chars / count >= 0.5,
                "spans": spans,
            }
        )
    return result


def group(kind, lines):
    digest = hashlib.sha256(json.dumps([kind, [i["id"] for i in lines]]).encode()).hexdigest()[:16]
    return {
        "id": f"layout-{digest}",
        "kind": kind,
        "lines": lines,
        "start_page": min(i["page"] for i in lines),
        "end_page": max(i["page"] for i in lines),
    }


def audit_page(page, blocks, table_boxes=()):
    blocks = [b for b in blocks if any(a["page"] == page.number + 1 for a in b["anchors"])]
    lines = source_lines(page, blocks)
    candidates = [
        line
        for line in lines
        if not line["inline_source"]
        and (line["math_font"] or MATH.search(line["text"]))
        and (line["math_font"] or not all(monospace(s) for s in line["spans"]))
        and line["bbox"][2] - line["bbox"][0] < page.rect.width * 0.65
        and page.rect.height * 0.09 < line["bbox"][1] < page.rect.height * 0.94
    ]
    excluded = [
        a["bbox"]
        for b in blocks
        if b["kind"] == "image"
        for a in b["anchors"]
        if a["page"] == page.number + 1
    ] + list(table_boxes)
    candidates = [line for line in candidates if not any(contains(box, line) for box in excluded)]
    candidates = [
        line
        for line in candidates
        if not any(
            b["id"] != line["block_id"]
            and b["kind"] == "paragraph"
            and len(b["text"]) > len(line["text"]) * 2
            and any(a["page"] == line["page"] and contains(a["bbox"], line) for a in b["anchors"])
            for b in blocks
        )
    ]
    runs = []
    for line in candidates:
        if (
            runs
            and 0 <= line["bbox"][1] - runs[-1][-1]["bbox"][3] < 32
            and abs(line["bbox"][0] - runs[-1][-1]["bbox"][0]) < 80
        ):
            runs[-1].append(line)
        else:
            runs.append([line])
    formulas, uncertain = [], False
    for run in runs:
        if len(run) < 2 or not any(MATH.search(i["text"]) for i in run):
            continue
        # Do not steal a few lines out of a prose/code block. Formula blocks
        # must be complete and separate from surrounding text.
        ids = {i["id"] for i in run}
        owners = {i["block_id"] for i in run if i["block_id"]}
        complete = owners and all(i["id"] in ids for i in lines if i["block_id"] in owners)
        if complete and all(i["math_font"] for i in run):
            formulas.append(group("formula", run))
        elif any(i["math_font"] for i in run) or all(MATH.search(i["text"]) for i in run):
            uncertain = True
    # A mathematical line close to a physical boundary needs adjacent context.
    if any(
        i["math_font"]
        and not i["inline_source"]
        and (i["bbox"][1] < page.rect.height * 0.12 or i["bbox"][3] > page.rect.height * 0.87)
        for i in lines
    ):
        uncertain = True
    code_lines = [
        i
        for i in lines
        if not i["math_font"] and not i["inline_source"] and all(monospace(s) for s in i["spans"])
    ]
    code = len(code_lines) >= 2 and any(
        re.search(r"(?:\w+\s*=)|^\s*(?:#|>>>|from |import |def |class )", i["text"])
        for i in code_lines
    )
    return {
        "groups": formulas,
        "uncertain": uncertain,
        "code_top": bool(code and code_lines[0]["bbox"][1] < page.rect.height * 0.12),
        "code_bottom": bool(code and code_lines[-1]["bbox"][3] > page.rect.height * 0.85),
    }


def local_layout(folder: Path, book, pages):
    path = folder / "source-math-v1.json"
    saved = json.loads(path.read_text()) if path.exists() else {}
    if saved.get("version") != VERSION:
        saved = {"version": VERSION, "pages": {}}
    missing = [p for p in pages if str(p) not in saved["pages"]]
    if missing:
        if not (folder / "source.pdf").exists():
            return {str(p): {"groups": [], "uncertain": False} for p in pages}
        format_path = folder / "source-format-v1.json"
        formats = json.loads(format_path.read_text()) if format_path.exists() else {}
        with pymupdf.open(folder / "source.pdf") as pdf:
            for p in missing:
                tables = [t["bbox"] for t in formats.get(str(p), {}).get("tables", [])]
                saved["pages"][str(p)] = audit_page(pdf[p - 1], book["blocks"], tables)
        for number, entry in saved["pages"].items():
            following = saved["pages"].get(str(int(number) + 1))
            if entry.get("code_bottom") and following and following.get("code_top"):
                entry["uncertain"] = following["uncertain"] = True
        write_private_json(path, saved)
    return {str(p): saved["pages"][str(p)] for p in pages}


def overrides(folder):
    path = folder / "layout-overrides-v1.json"
    return json.loads(path.read_text()) if path.exists() else {"version": VERSION, "groups": []}


def page_groups(folder, book, pages):
    local = local_layout(folder, book, pages)
    visual = overrides(folder)["groups"]
    result = {}
    for p in pages:
        selected = [g for g in visual if g["start_page"] <= p <= g["end_page"]]
        used = {line["block_id"] for g in selected for line in g["lines"]}
        groups = [
            g
            for g in local[str(p)]["groups"]
            if not any(line["block_id"] in used for line in g["lines"])
        ] + selected
        fragments = []
        for g in groups:
            lines = [line for line in g["lines"] if line["page"] == p]
            if not lines:
                continue
            rect = pymupdf.Rect(lines[0]["bbox"])
            for line in lines[1:]:
                rect |= pymupdf.Rect(line["bbox"])
            fragments.append({**g, "lines": lines, "bbox": list(rect)})
        result[str(p)] = fragments
    return result
