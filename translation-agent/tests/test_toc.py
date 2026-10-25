import json

from koodo_translation.formatting import fingerprint, page_presentation, source_formats
from koodo_translation.toc import toc_entries


def rows():
    return [
        {
            "id": str(i),
            "kind": "paragraph",
            "page": 5,
            "text": title + "." * 40 + label,
            "anchors": [
                {"page": 5, "bbox": [40 + (24 if i == 2 else 0), 100 + i * 15, 400, 110 + i * 15]}
            ],
        }
        for i, (title, label) in enumerate(
            [("Preface", "9"), ("Chapter 1: Models", "23"), ("1.1 Layers", "26")]
        )
    ]


def test_contents_detects_aligned_rows_preserves_printed_labels_indent_and_weight():
    entries = toc_entries(
        rows(),
        [
            {"block_id": "1", "kind": "bold", "text": rows()[1]["text"]},
            {"block_id": "0", "kind": "bold", "text": "9"},
        ],
    )
    assert [e["page_label"] for e in entries] == ["9", "23", "26"]
    assert entries[1]["bold"] is True
    assert entries[0]["bold"] is False and entries[0]["page_bold"] is True
    assert entries[2]["indent"] == 24
    assert toc_entries(rows()[:1], []) == []
    ordinary = rows()
    ordinary[1]["anchors"][0]["bbox"][2] = 200
    ordinary[2]["anchors"][0]["bbox"][2] = 300
    assert toc_entries(ordinary, []) == []


def test_old_cached_paragraph_groups_gain_toc_metadata_without_invalidating_style_cache(tmp_path):
    source = {
        "version": 1,
        "marks": [],
        "tables": [],
        "body_font_size": 10,
        "paragraph_groups": [["0", "1", "2"]],
    }
    (tmp_path / "source-format-v1.json").write_text(json.dumps({"5": source}))
    texts = {"0": "前言.....9"}
    saved = {"fingerprint": fingerprint(source, texts), "marks": {}, "cells": {}}
    updated = source_formats(tmp_path, {"blocks": rows()}, [5])["5"]
    assert len(updated["toc_entries"]) == 3
    assert page_presentation(updated, texts, saved)["status"] == "ready"
    # The immutable source cache and book IDs/text do not need a migration.
    assert json.loads((tmp_path / "source-format-v1.json").read_text()) == {"5": source}
