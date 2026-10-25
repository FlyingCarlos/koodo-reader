import json

import httpx2
import pytest
from openai import AsyncOpenAI
from pydantic import ValidationError
from test_workflow import SubscriptionMock

from koodo_translation.batching import (
    DEFAULT_BUDGET,
    SOURCE_MODE,
    BatchBudget,
    batches,
    estimate,
    replan_unstarted,
    segment_payload,
)
from koodo_translation.storage import JobStore, state_directory
from koodo_translation.toc import toc_block_ids
from koodo_translation.workflow import TranslationInput, translate_job


def contents(count=155):
    return [
        {
            "id": f"row-{i}",
            "kind": "paragraph",
            "page": i // 36 + 1,
            "anchors": [{"page": i // 36 + 1, "bbox": [40, i % 36 * 15, 400, i % 36 * 15 + 11]}],
            "text": f"Section {i}" + "." * 80 + str(i + 9),
            "protected": [],
        }
        for i in range(count)
    ]


def test_short_contents_use_multi_segment_budget_not_twelve_line_cap():
    nodes = contents()
    planned = batches(nodes)
    assert len(planned) == 2
    assert max(map(len, planned)) > 20
    assert [i for group in planned for i in group] == [n["id"] for n in nodes]
    assert max(map(len, planned)) <= DEFAULT_BUDGET.max_segments
    by_id = {n["id"]: n for n in nodes}
    for ids in planned:
        texts = [segment_payload(by_id[i], SOURCE_MODE, is_toc=True)["text"] for i in ids]
        assert sum(len(t) for t in texts) <= DEFAULT_BUDGET.max_characters
        assert (
            sum(estimate(t)[0] for t in texts) + DEFAULT_BUDGET.overhead_tokens
            <= DEFAULT_BUDGET.max_input_tokens
        )
        assert sum(estimate(t)[1] for t in texts) <= DEFAULT_BUDGET.max_output_tokens


def test_output_and_review_reserves_can_split_calls_before_count_limit():
    nodes = [
        {"id": str(i), "kind": "paragraph", "text": "x" * 1200, "protected": []} for i in range(10)
    ]
    assert all(len(group) <= 2 for group in batches(nodes, BatchBudget(max_output_tokens=1400)))
    assert all(len(group) <= 1 for group in batches(nodes, BatchBudget(max_review_tokens=3000)))
    assert [i for group in batches(nodes) for i in group] == [n["id"] for n in nodes]


def test_resume_preserves_every_started_fingerprint_and_only_repacks_unstarted_ids(tmp_path):
    nodes = contents(48)
    store = JobStore(state_directory(tmp_path))
    legacy = TranslationInput(
        book_title="Book",
        chapter_title="Contents",
        glossary={},
        segments=[segment_payload(n) for n in nodes[:12]],
    )
    job = store.start(legacy.model_dump(), "test-model")
    chunks = [
        {"ids": [n["id"] for n in nodes[i : i + 12]], "job_id": job["id"] if i == 0 else None}
        for i in range(0, 48, 12)
    ]
    planned = replan_unstarted(chunks, {n["id"]: n for n in nodes})
    assert planned[0] == chunks[0]
    assert len(planned) == 2 and len(planned[1]["ids"]) == 36
    assert (
        store.start(legacy.model_dump(), "test-model", planned[0]["job_id"])["fingerprint"]
        == job["fingerprint"]
    )
    assert [i for c in planned for i in c["ids"]] == [n["id"] for n in nodes]
    assert replan_unstarted(planned, {n["id"]: n for n in nodes}) == planned


def test_compaction_only_changes_verified_contents_model_input_and_protects_printed_page():
    node = contents(3)[0]
    saved = json.dumps(node, sort_keys=True)
    payload = segment_payload(node, SOURCE_MODE, is_toc=node["id"] in toc_block_ids(contents(3)))
    assert payload["text"] == "Section 0\t9" and payload["protected"] == ["\t9"]
    assert json.dumps(node, sort_keys=True) == saved
    assert segment_payload(node)["text"] == node["text"]
    ordinary = {**node, "text": "Wait... 9"}
    assert segment_payload(ordinary, SOURCE_MODE)["text"] == "Wait... 9"
    with pytest.raises(ValidationError):
        TranslationInput(
            book_title="Book",
            chapter_title="C",
            glossary={},
            segments=[{"id": "oversized", "text": "a" * 20001}],
        )


async def test_real_sdk_translates_and_reviews_more_than_twenty_segments_in_one_batch(tmp_path):
    nodes = contents(48)
    source = TranslationInput(
        book_title="Book",
        chapter_title="Contents",
        glossary={},
        segments=[segment_payload(n, SOURCE_MODE, is_toc=True) for n in nodes],
    )
    output = {
        "segments": [
            {"segment_id": n["id"], "text": f"章节 {i}\t{i + 9}"} for i, n in enumerate(nodes)
        ]
    }
    mock = SubscriptionMock(["tool", output, {"issues": []}])
    store = JobStore(state_directory(tmp_path))
    job = store.start(source.model_dump(), "test-model")
    async with AsyncOpenAI(
        api_key="test-subscription-token",
        base_url="https://api.openai.com/v1",
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(mock.handle)),
    ) as client:
        result = await translate_job(source, "test-model", client, store, job["id"])
    assert result["status"] == "completed"
    assert len(result["artifacts"]["accepted"]["segments"]) == 48
    assert len(mock.requests) == 3  # glossary turn + translation + independent review, not 48 calls
