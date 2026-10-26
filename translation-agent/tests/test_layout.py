import asyncio
import json

import pymupdf
import pytest
from test_workflow import SubscriptionMock

from koodo_translation.chapters import ChapterQueue
from koodo_translation.documents import DocumentStore
from koodo_translation.layout import LayoutPlan, validate_plan
from koodo_translation.layout_sources import audit_page, page_groups, source_lines
from koodo_translation.storage import state_directory


def book_fixture(tmp_path):
    with pymupdf.open() as pdf:
        for i in range(6):
            page = pdf.new_page()
            page.insert_text((40, 160), f"Page {i + 1} body explanation.")
            if 2 <= i <= 4:
                page.insert_text((80, 400), f"value = {i + 1}", fontname="cour")
        data = pdf.tobytes()
    store = DocumentStore(state_directory(tmp_path))
    book = store.import_pdf(data, "fixture")
    queue = ChapterQueue(store)
    return store, book, queue


def authorize(monkeypatch, queue):
    monkeypatch.setattr(
        type(queue.auth), "access_token", property(lambda _: "test-subscription-token")
    )


async def test_visual_job_expands_beyond_three_pages_and_applies_cross_page_group_atomically(
    tmp_path, monkeypatch
):
    store, book, queue = book_fixture(tmp_path)
    authorize(monkeypatch, queue)
    folder = store.folder(book["id"])
    original = (folder / "document.json").read_bytes()
    source = (folder / "source.pdf").read_bytes()
    calls = []

    async def stage(agent, payload, context, config, *, images):
        calls.append((payload["start_page"], payload["end_page"], len(images)))
        assert not (folder / "layout-overrides-v1.json").exists()
        if len(calls) == 1:
            return LayoutPlan(groups=[], expand_before=False, expand_after=True, uncertain=False)
        chosen = [line["id"] for line in payload["lines"] if line["text"].startswith("value =")]
        return LayoutPlan(
            groups=[{"kind": "code", "line_ids": chosen}],
            expand_before=False,
            expand_after=False,
            uncertain=False,
        )

    monkeypatch.setattr("koodo_translation.layout.run_stage", stage)
    task = queue.layout.create(book["id"], 3, "test-model")
    assert queue.layout.create(book["id"], 3, "test-model")["id"] == task["id"]
    await queue.layout.run(task["id"])
    result = queue.layout.get(task["id"])
    assert calls == [(2, 4, 3), (2, 6, 5)]
    assert result["status"] == "completed" and result["end_page"] == 6
    saved = json.loads((folder / "layout-overrides-v1.json").read_text())
    assert saved["groups"][0]["start_page"] == 3 and saved["groups"][0]["end_page"] == 5
    assert [line["text"] for line in saved["groups"][0]["lines"]] == [
        "value = 3",
        "value = 4",
        "value = 5",
    ]
    fragments = page_groups(folder, book, [3, 4, 5])
    assert len({fragments[str(p)][0]["id"] for p in [3, 4, 5]}) == 1
    assert (folder / "document.json").read_bytes() == original
    assert (folder / "source.pdf").read_bytes() == source


async def test_invalid_visual_output_retries_once_and_never_partially_applies(
    tmp_path, monkeypatch
):
    store, book, queue = book_fixture(tmp_path)
    authorize(monkeypatch, queue)
    calls = []

    async def invalid(agent, payload, context, config, *, images):
        calls.append(payload)
        return LayoutPlan(
            groups=[{"kind": "formula", "line_ids": ["invented"]}],
            expand_before=False,
            expand_after=False,
            uncertain=False,
        )

    monkeypatch.setattr("koodo_translation.layout.run_stage", invalid)
    task = queue.layout.create(book["id"], 3, "test-model")
    await queue.layout.run(task["id"])
    assert len(calls) == 2 and calls[1]["previous_validation_error"]
    assert queue.layout.get(task["id"])["status"] == "needs_confirmation"
    assert not (store.folder(book["id"]) / "layout-overrides-v1.json").exists()


def test_validation_catches_missing_lines_and_canonical_cross_page_boundary(tmp_path):
    store, book, queue = book_fixture(tmp_path)
    with pymupdf.open(store.folder(book["id"]) / "source.pdf") as pdf:
        lines = source_lines(pdf[2], book["blocks"])
    code = next(line for line in lines if line["text"].startswith("value ="))
    plan = LayoutPlan(
        groups=[{"kind": "code", "line_ids": [code["id"]]}],
        expand_before=False,
        expand_after=False,
        uncertain=False,
    )
    owner = next(b for b in book["blocks"] if b["id"] == code["block_id"])
    owner["anchors"].append({"page": 5, "bbox": owner["anchors"][0]["bbox"]})
    _, before, after = validate_plan(plan, lines, book, 3, 3)
    assert not before and after
    lines.append({**code, "id": "another-line"})
    with pytest.raises(ValueError, match="截断"):
        validate_plan(plan, lines, book, 3, 5)


async def test_real_agents_sdk_sends_multiple_images_and_exact_source_ids(tmp_path, monkeypatch):
    store, book, queue = book_fixture(tmp_path)
    authorize(monkeypatch, queue)
    with pymupdf.open(store.folder(book["id"]) / "source.pdf") as pdf:
        chosen = [
            line["id"]
            for line in source_lines(pdf[2], book["blocks"])
            if line["text"].startswith("value =")
        ]
    mock = SubscriptionMock(
        [
            {
                "groups": [{"kind": "code", "line_ids": chosen}],
                "expand_before": False,
                "expand_after": False,
                "uncertain": False,
            }
        ]
    )
    monkeypatch.setattr("koodo_translation.layout.AsyncOpenAI", lambda **_: mock.client())
    task = queue.layout.create(book["id"], 3, "test-model")
    await queue.layout.run(task["id"])
    assert queue.layout.get(task["id"])["status"] == "completed"
    request = mock.requests[0]
    content = request["input"][0]["content"]
    assert len([i for i in content if i["type"] == "input_image"]) == 3
    assert request["text"]["format"]["type"] == "json_schema"
    assert request["store"] is False


async def test_cancelled_layout_requeues_without_applying_and_automatic_audit_is_idempotent(
    tmp_path, monkeypatch
):
    store, book, queue = book_fixture(tmp_path)
    authorize(monkeypatch, queue)
    assert queue.layout.create(book["id"], 3, "test-model", True) is None

    async def cancelled(*args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr("koodo_translation.layout.run_stage", cancelled)
    task = queue.layout.create(book["id"], 3, "test-model")
    with pytest.raises(asyncio.CancelledError):
        await queue.layout.run(task["id"])
    assert queue.layout.get(task["id"])["status"] == "queued"
    assert not (store.folder(book["id"]) / "layout-overrides-v1.json").exists()


def test_rule_audit_recovers_multiline_formula_and_does_not_merge_code_or_prose():
    class Page:
        number = 0
        rect = pymupdf.Rect(0, 0, 600, 800)

        def get_text(self, *args, **kwargs):
            rows = []
            for i, text in enumerate(
                ["max 30x + 50y", "s.t. x + y ≤ 30", "0 ≤ x ≤ 100", "0 ≤ y ≤ 100", "x,y ∈ ℤ"]
            ):
                bbox = [260, 300 + i * 24, 350, 312 + i * 24]
                rows.append(
                    {
                        "type": 0,
                        "bbox": bbox,
                        "lines": [
                            {
                                "bbox": bbox,
                                "spans": [
                                    {
                                        "text": text,
                                        "font": "Type3",
                                        "flags": 0,
                                        "size": 12,
                                        "bbox": bbox,
                                    }
                                ],
                            }
                        ],
                    }
                )
            return {"blocks": rows}

    blocks = [
        {
            "id": str(i),
            "kind": "paragraph",
            "text": text,
            "anchors": [{"page": 1, "bbox": [260, 300 + i * 24, 350, 312 + i * 24]}],
        }
        for i, text in enumerate(
            ["max 30x + 50y", "s.t. x + y ≤ 30", "0 ≤ x ≤ 100", "0 ≤ y ≤ 100", "x,y ∈ ℤ"]
        )
    ]
    result = audit_page(Page(), blocks)
    assert not result["uncertain"]
    assert len(result["groups"]) == 1 and len(result["groups"][0]["lines"]) == 5
