import copy

import pymupdf

from koodo_translation.batching import batches
from koodo_translation.structure import monospace, page_structure, prepare_book


def test_source_code_keeps_lines_and_excludes_legacy_paragraph_from_agent():
    with pymupdf.open() as pdf:
        page = pdf.new_page(width=500, height=800)
        page.draw_rect((35, 25, 460, 125), fill=(0.96, 0.97, 0.96))
        for x, y, text in [
            (40, 42, "from math import sqrt"),
            (40, 65, "# Keep this comment"),
            (40, 77, "if True:"),
            (64, 89, "value = sqrt(4)"),
        ]:
            page.insert_text((x, y), text, fontname="cour", fontsize=10)
        blocks = [
            {
                "id": "old",
                "kind": "paragraph",
                "text": "from math import sqrt # Keep this comment if True: value = sqrt(4)",
                "chapter_id": "c",
                "page": 1,
                "anchors": [{"page": 1, "bbox": [35, 25, 460, 125]}],
            }
        ]
        original = copy.deepcopy(blocks)
        layout = page_structure(page, blocks)
    source = "".join(p["prefix"] + p["text"] for p in layout["code"][0]["parts"])
    assert source.startswith("from math import sqrt\n\n# Keep this comment")
    assert "\n    value = sqrt(4)" in source
    prepared = prepare_book({"blocks": blocks, "chapters": [{"id": "c"}]}, {"1": layout})
    assert batches(prepared["blocks"]) == []
    assert prepared["blocks"][0]["id"] == "old"
    assert blocks == original
    assert monospace({"font": "SourceCodePro-Medium", "flags": 12})


def test_overlapping_prose_bbox_does_not_become_math_literal():
    class Page:
        number = 0
        rect = pymupdf.Rect(0, 0, 500, 800)

        def get_text(self, mode):
            return {
                "blocks": [
                    {
                        "type": 0,
                        "bbox": [100, 100, 150, 112],
                        "lines": [
                            {
                                "bbox": [100, 100, 150, 112],
                                "spans": [
                                    {"font": "Type3", "flags": 0, "size": 10, "text": "x + y"}
                                ],
                            }
                        ],
                    }
                ]
            }

        def get_drawings(self):
            return []

        def get_image_info(self):
            return []

    blocks = [
        {
            "id": "literal",
            "kind": "paragraph",
            "text": "x + y model = Model()",
            "anchors": [{"page": 1, "bbox": [100, 100, 150, 112]}],
        },
        {
            "id": "prose",
            "kind": "paragraph",
            "text": "Add the constraint to the model.",
            "anchors": [{"page": 1, "bbox": [40, 90, 460, 130]}],
        },
    ]
    layout = page_structure(Page(), blocks)
    assert layout["code_ids"] == ["literal"]
    assert len(layout["inlines"]) == 1
    assert layout["inlines"][0]["owner_id"] == "prose"
