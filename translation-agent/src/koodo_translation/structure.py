"""Add source layout to legacy manifests without replacing IDs or accepted text."""

import json
import re

import pymupdf

from .storage import write_private_json


def load_structure(folder, book):
    path = folder / "source-structure-v1.json"
    if path.exists():
        cached = json.loads(path.read_text())
        if cached.get("version") == 3:
            return cached["pages"]
    if not (folder / "source.pdf").exists():
        return {
            str(b["page"]): {
                "code": [],
                "code_ids": [],
                "inlines": [],
                "callouts": [],
                "suppress_images": [],
            }
            for b in book["blocks"]
        }
    with pymupdf.open(folder / "source.pdf") as pdf:
        pages = {
            str(page.number + 1): page_structure(
                page,
                [
                    b
                    for b in book["blocks"]
                    if any(a["page"] == page.number + 1 for a in b["anchors"])
                ],
            )
            for page in pdf
        }
    write_private_json(path, {"version": 3, "pages": pages})
    return pages


def monospace(span):
    return bool(span["flags"] & 8) or bool(
        re.search(r"mono|courier|consolas|menlo|typewriter|sourcecode", span["font"], re.I)
    )


def contains(bbox, line):
    rect = pymupdf.Rect(line["bbox"])
    return pymupdf.Rect(bbox).contains(rect.tl + (rect.br - rect.tl) * 0.5)


def compact(text):
    return re.sub(r"\s+", "", text)


def source_range(text, quote):
    indexed = [(i, c) for i, c in enumerate(text) if not c.isspace()]
    at = "".join(c for _, c in indexed).find(compact(quote))
    if at < 0 or not compact(quote):
        return None
    end = at + len(compact(quote)) - 1
    return indexed[at][0], indexed[end][0] + 1


def page_structure(page, blocks):
    raw = [b for b in page.get_text("dict")["blocks"] if b["type"] == 0]
    lines = [
        line for b in raw for line in b["lines"] if any(s["text"].strip() for s in line["spans"])
    ]
    code_lines = [
        line
        for line in lines
        if sum(len(s["text"]) for s in line["spans"] if monospace(s))
        >= sum(len(s["text"]) for s in line["spans"]) * 0.8
    ]
    syntax = re.compile(r"(^\s*(?:from |import |def |class |#|return |for |if |try:))|(?:\w+\s*=)")
    regions = []
    for shape in page.get_drawings():
        fill = shape.get("fill")
        rect = shape["rect"] & page.rect
        if (
            not fill
            or not all(0.88 < c < 0.99 for c in fill[:3])
            or rect.width < page.rect.width * 0.3
        ):
            continue
        selected = [line for line in lines if contains(rect, line)]
        code = [line for line in code_lines if contains(rect, line)]
        text = "\n".join("".join(s["text"] for s in line["spans"]) for line in code)
        if not code or len(code) < len(selected) * 0.85 or not syntax.search(text):
            continue
        if any(pymupdf.Rect(r).contains(rect) for r in regions):
            continue
        regions.append(list(rect))
    for block in raw:
        selected = [line for line in code_lines if line in block["lines"]]
        text = "\n".join("".join(s["text"] for s in line["spans"]) for line in selected)
        if not selected or len(selected) < len(block["lines"]) * 0.85 or not syntax.search(text):
            continue
        if not any(contains(r, selected[0]) for r in regions):
            regions.append(list(block["bbox"]))
    code, code_ids = [], set()
    for index, bbox in enumerate(sorted(regions, key=lambda r: (r[1], r[0]))):
        selected = sorted(
            [line for line in code_lines if contains(bbox, line)],
            key=lambda line: (line["bbox"][1], line["bbox"][0]),
        )
        if not selected:
            continue
        pitch = min(
            (
                b["bbox"][1] - a["bbox"][1]
                for a, b in zip(selected, selected[1:], strict=False)
                if b["bbox"][1] - a["bbox"][1] > 1
            ),
            default=12,
        )
        left = min(line["bbox"][0] for line in selected)
        parts = []
        previous = None
        for line in selected:
            spans = line["spans"]
            char_width = max(s["size"] for s in spans) * 0.6
            indent = " " * max(0, round((line["bbox"][0] - left) / char_width))
            gap = (
                "\n" * max(1, round((line["bbox"][1] - previous["bbox"][1]) / pitch))
                if previous
                else ""
            )
            text = indent + "".join(s["text"] for s in spans)
            owners = [
                b
                for b in blocks
                if b["kind"] != "image"
                and any(
                    a["page"] == page.number + 1 and contains(a["bbox"], line) for a in b["anchors"]
                )
            ]
            owner = min(
                owners,
                key=lambda b: pymupdf.Rect(
                    next(a["bbox"] for a in b["anchors"] if a["page"] == page.number + 1)
                ).get_area(),
                default=None,
            )
            block_id = owner["id"] if owner else None
            if block_id:
                code_ids.add(block_id)
            if parts and parts[-1]["block_id"] == block_id:
                parts[-1]["text"] += gap + text
            else:
                parts.append({"block_id": block_id, "prefix": gap, "text": text})
            previous = line
        code.append({"id": f"p{page.number + 1:04d}-code{index}", "bbox": bbox, "parts": parts})
    inlines = []
    for block in blocks:
        if block["kind"] == "image":
            continue
        anchors = [a for a in block["anchors"] if a["page"] == page.number + 1]
        math_lines = [
            line
            for line in lines
            if any(contains(a["bbox"], line) for a in anchors)
            and all(re.search(r"type3|symbol|math", s["font"], re.I) for s in line["spans"])
        ]
        for line in math_lines:
            text = "".join(s["text"] for s in line["spans"]).strip()
            if compact(text) not in compact(block["text"]):
                continue
            owners = [
                b
                for b in blocks
                if b["id"] != block["id"]
                and b["kind"] == "paragraph"
                and any(
                    a["page"] == page.number + 1 and contains(a["bbox"], line) for a in b["anchors"]
                )
            ]
            if not owners:
                continue
            owner = owners[0]
            inlines.append(
                {
                    "id": f"p{page.number + 1:04d}-inline{len(inlines)}",
                    "block_id": block["id"],
                    "owner_id": owner["id"],
                    "text": text,
                    "bbox": list(line["bbox"]),
                }
            )
            code_ids.add(block["id"])
    callouts, suppressed = [], []
    table_boxes = None
    images = [
        list(i["bbox"]) for i in page.get_image_info() if pymupdf.Rect(i["bbox"]).get_area() >= 1000
    ]
    for block in blocks:
        if block["kind"] != "image":
            continue
        bbox = block["anchors"][0]["bbox"]
        rect = pymupdf.Rect(bbox)
        if rect.height < 8 or rect.y0 > page.rect.height * 0.95:
            suppressed.append(block["id"])
            continue
        text_blocks = [
            b
            for b in blocks
            if b["kind"] not in {"image", "code"}
            and any(
                a["page"] == page.number + 1 and rect.contains(pymupdf.Rect(a["bbox"]))
                for a in b["anchors"]
            )
        ]
        if sum(len(b["text"]) for b in text_blocks) < 80:
            continue
        if table_boxes is None:
            table_boxes = [
                pymupdf.Rect(t.bbox)
                for t in page.find_tables().tables
                if t.row_count > 1 and t.col_count > 1
            ]
        if any((rect & table).get_area() >= table.get_area() * 0.8 for table in table_boxes):
            # A raster backdrop/shadow around a vector table is not a callout.
            # Its text must remain available to the existing table renderer.
            suppressed.append(block["id"])
            continue
        icons = [
            r
            for r in images
            if rect.contains(pymupdf.Rect(r)) and pymupdf.Rect(r).get_area() < rect.get_area() * 0.2
        ]
        if icons:
            callouts.append(
                {
                    "id": block["id"],
                    "bbox": bbox,
                    "image_bbox": icons[0],
                    "block_ids": [b["id"] for b in text_blocks],
                }
            )
        else:
            suppressed.append(block["id"])
    return {
        "code": code,
        "code_ids": sorted(code_ids),
        "inlines": inlines,
        "callouts": callouts,
        "suppress_images": suppressed,
    }


def prepare_book(book, structure):
    """Reading/planning view; the immutable manifest and accepted artifacts stay untouched."""
    literals = {i for page in structure.values() for i in page["code_ids"]}
    by_owner = {}
    for page in structure.values():
        for inline in page["inlines"]:
            by_owner.setdefault(inline["owner_id"], []).append(inline)
    blocks = [{**b, "kind": "code" if b["id"] in literals else b["kind"]} for b in book["blocks"]]
    for block in blocks:
        if block["kind"] == "code":
            continue
        additions = by_owner.get(block["id"], [])
        if additions:
            # Supply missing literals as context for new requests. Existing job
            # payloads are always resumed from storage.
            block["protected"] = sorted(
                set(block.get("protected", []) + [i["text"] for i in additions])
            )
            block["translation_source"] = (
                block["text"] + "\n" + "\n".join(i["text"] for i in additions)
            )
    chapters = [
        {
            **c,
            "text_count": sum(
                b["chapter_id"] == c["id"] and b["kind"] not in {"image", "code"} for b in blocks
            ),
        }
        for c in book["chapters"]
    ]
    return {**book, "blocks": blocks, "chapters": chapters}
