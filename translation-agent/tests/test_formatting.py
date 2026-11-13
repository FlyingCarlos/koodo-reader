import copy

import httpx2
import pymupdf
import pytest
from openai import AsyncOpenAI
from test_workflow import SubscriptionMock

from koodo_translation.documents import DocumentStore
from koodo_translation.formatting import (
    FormatAlignment,
    align_page,
    fingerprint,
    page_presentation,
    source_formats,
    validate_alignment,
)
from koodo_translation.storage import state_directory


def test_enrichment_preserves_book_ids_text_and_recovers_real_pdf_styles_and_cells(tmp_path):
    with pymupdf.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 80), "Bold label:", fontname="hebo", fontsize=12)
        page.insert_text((40, 110), "Italic phrase", fontname="heit", fontsize=12)
        page.insert_text((40, 140), "batch_size", fontname="cour", fontsize=12)
        for x in [40, 220, 400]:
            page.draw_line((x, 200), (x, 280))
        for y in [200, 240, 280]:
            page.draw_line((40, y), (400, y))
        for x, y, text in [
            (50, 225, "Pros"),
            (230, 225, "Cons"),
            (50, 265, "Low cost"),
            (230, 265, "No control"),
        ]:
            page.insert_text((x, y), text, fontsize=10)
        data = pdf.tobytes()
    store = DocumentStore(state_directory(tmp_path))
    before = store.import_pdf(data, "original")
    formats = source_formats(store.folder(before["id"]), before, [1])
    assert {m["kind"] for m in formats["1"]["marks"]} >= {"bold", "italic"}
    # Full code blocks already have a code role; no translated substring is needed.
    assert any(n["kind"] == "code" for n in before["blocks"])
    assert formats["1"]["tables"][0]["rows"] == 2
    assert formats["1"]["tables"][0]["columns"] == 2
    assert len(formats["1"]["tables"][0]["cells"]) == 4
    assert store.get(before["id"]) == before
    assert (store.folder(before["id"]) / "source.pdf").read_bytes() == data
    assert source_formats(store.folder(before["id"]), before, [1]) == formats


SOURCE = {
    "version": 1,
    "marks": [{"id": "s0", "block_id": "body", "kind": "code", "text": "x"}],
    "tables": [
        {
            "cells": [
                {"id": "left", "row": 0, "column": 0, "block_ids": ["header"], "text": "Pros"},
                {"id": "right", "row": 0, "column": 1, "block_ids": ["header"], "text": "Cons"},
            ]
        }
    ],
}
TEXTS = {"body": "😀使用 x 的实例", "header": "优点 缺点"}


def test_whole_cell_translation_requires_complete_source_and_unique_ownership():
    source = {
        "marks": [],
        "tables": [{"cells": [{"id": "one", "block_ids": ["b"], "text": "Cost"}]}],
    }
    texts = {"b": "成本😀"}
    result = page_presentation(source, texts, original_texts={"b": "Cost"})
    assert result["table_state"] == "ready"
    assert result["translated_cells"] == {"one": [{"block_id": "b", "start": 0, "end": 4}]}
    assert result["status"] == "pending"
    partial = page_presentation(source, texts, original_texts={"b": "Cost and prose"})
    assert partial["table_state"] == "pending"
    shared = page_presentation(SOURCE, TEXTS, original_texts={"header": "Pros Cons"})
    assert shared["table_state"] == "pending"
    assert not shared["translated_cells"]
    headers = copy.deepcopy(SOURCE)
    for cell in headers["tables"][0]["cells"]:
        cell["header"] = True
    delimited = page_presentation(headers, TEXTS, original_texts={"header": "Pros Cons"})
    assert delimited["table_state"] == "ready"
    assert delimited["translated_cells"]["right"][0]["start"] == 3
    undelimited = page_presentation(
        headers, {"header": "优点缺点"}, original_texts={"header": "Pros Cons"}
    )
    assert undelimited["table_state"] == "pending"


ALIGNMENT = {
    "marks": [{"source_id": "s0", "quote": "x", "occurrence": 0}],
    "cells": [
        {"cell_id": "left", "parts": [{"block_id": "header", "quote": "优点", "occurrence": 0}]},
        {"cell_id": "right", "parts": [{"block_id": "header", "quote": "缺点", "occurrence": 0}]},
    ],
}


def test_exact_quotes_utf16_and_whitespace_coverage_keep_old_offsets():
    output = validate_alignment(SOURCE, TEXTS, FormatAlignment.model_validate(ALIGNMENT))
    assert output["marks"]["body"] == [{"start": 5, "end": 6, "kind": "code"}]
    assert output["cells"]["left"][0] == {"block_id": "header", "start": 0, "end": 3}
    assert output["cells"]["right"][0]["start"] == 3
    saved = {**output, "fingerprint": fingerprint(SOURCE, TEXTS)}
    assert page_presentation(SOURCE, TEXTS, saved)["status"] == "ready"
    assert page_presentation(SOURCE, {**TEXTS, "body": "新译文"}, saved)["status"] == "pending"


@pytest.mark.parametrize(
    "fault", ["rewrite", "omission", "duplicate", "wrong_owner", "missing_mark"]
)
def test_format_alignment_rejects_text_changes_loss_and_foreign_ids(fault):
    value = copy.deepcopy(ALIGNMENT)
    if fault == "rewrite":
        value["marks"][0]["quote"] = "改写后的文字"
    elif fault == "omission":
        value["cells"][1]["parts"] = []
    elif fault == "duplicate":
        value["cells"][1]["parts"][0]["quote"] = "优点"
    elif fault == "wrong_owner":
        value["cells"][0]["parts"][0]["block_id"] = "body"
    else:
        value["marks"] = []
    with pytest.raises(ValueError):
        validate_alignment(SOURCE, TEXTS, FormatAlignment.model_validate(value))


async def test_format_agent_uses_real_sdk_schema_and_never_returns_rewritten_translation(tmp_path):
    backend = SubscriptionMock([ALIGNMENT])
    store = DocumentStore(state_directory(tmp_path)).jobs
    job = store.start({"source": SOURCE, "translations": TEXTS}, "test-model")
    async with AsyncOpenAI(
        api_key="test-subscription-token",
        base_url="https://api.openai.com/v1",
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(backend.handle)),
    ) as client:
        result = await align_page(SOURCE, TEXTS, "test-model", client, store, job)
        # A completed formatting stage can resume without another model request.
        assert (
            await align_page(SOURCE, TEXTS, "test-model", client, store, store.get(job["id"]))
            == result
        )
    assert len(backend.requests) == 1
    assert store.get(job["id"])["status"] == "completed"
    assert "text" not in result
    assert result["marks"]["body"][0]["start"] == 5


def test_inline_math_anchors_existing_text_in_utf16_without_rewriting():
    source = {
        "marks": [],
        "tables": [],
        "inline_sources": [{"id": "math", "owner_id": "body", "text": "x + y <= 30"}],
    }
    texts = {"body": "😀添加约束，得到解。"}
    output = validate_alignment(
        source,
        texts,
        FormatAlignment.model_validate(
            {
                "marks": [],
                "cells": [],
                "inlines": [
                    {"source_id": "math", "quote": "添加约束", "occurrence": 0, "after": True}
                ],
            }
        ),
    )
    assert output["inlines"] == {"math": 6}
    assert texts == {"body": "😀添加约束，得到解。"}
    with pytest.raises(ValueError):
        validate_alignment(source, texts, FormatAlignment(marks=[], cells=[], inlines=[]))
    assert fingerprint(source, texts) == fingerprint(
        {**source, "source_layout": {"code": []}}, texts
    )
