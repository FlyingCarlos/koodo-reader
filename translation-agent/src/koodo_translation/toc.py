"""Source-owned contents entries: printed labels are not physical PDF indexes."""

import re
from collections import Counter

LEADER = re.compile(r"^(.*?)(\s*[.．·…‥]{3,}\s*)(\d+|[ivxlcdmIVXLCDM]+)\s*$", re.S)


def split_entry(text: str):
    match = LEADER.fullmatch(text.strip())
    if not match or not match[1].strip():
        return None
    return match[1].strip(), match[3]


def toc_entries(blocks: list[dict], marks: list[dict]) -> list[dict]:
    candidates = [
        (b, split_entry(b["text"]))
        for b in blocks
        if b["kind"] == "paragraph" and len(b["anchors"]) == 1
    ]
    candidates = [(b, parts) for b, parts in candidates if parts]
    if len(candidates) < 3:
        return []
    # Require a shared page-number edge as well as repeated leader syntax. An
    # ellipsis in ordinary prose must not turn its paragraph into a contents row.
    edges = Counter(round(b["anchors"][0]["bbox"][2] / 3) for b, _ in candidates)
    edge = edges.most_common(1)[0][0]
    aligned = [
        (b, parts)
        for b, parts in candidates
        if abs(round(b["anchors"][0]["bbox"][2] / 3) - edge) <= 1
    ]
    if len(aligned) < 3:
        return []
    left = min(b["anchors"][0]["bbox"][0] for b, _ in aligned)

    def normalized(value):
        return "".join(c.lower() for c in value if c.isalnum())

    def title_bold(block, title):
        return any(
            m["block_id"] == block["id"]
            and m["kind"] == "bold"
            and normalized(title) in normalized(m.get("text", ""))
            for m in marks
        )

    def page_bold(block, label):
        return any(
            m["block_id"] == block["id"]
            and m["kind"] == "bold"
            and normalized(m.get("text", "")).endswith(normalized(label))
            for m in marks
        )

    return [
        {
            "block_id": b["id"],
            "title": parts[0],
            "page_label": parts[1],
            "indent": max(0, b["anchors"][0]["bbox"][0] - left),
            "bold": title_bold(b, parts[0]),
            "page_bold": page_bold(b, parts[1]),
        }
        for b, parts in aligned
    ]


def compact_text(text: str) -> str:
    entry = split_entry(text)
    return f"{entry[0]}\t{entry[1]}" if entry else text


def toc_block_ids(blocks: list[dict]) -> set[str]:
    pages = {}
    for block in blocks:
        if "page" in block and "anchors" in block:
            pages.setdefault(block["page"], []).append(block)
    return {entry["block_id"] for page in pages.values() for entry in toc_entries(page, [])}
