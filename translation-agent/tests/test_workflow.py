import json
from pathlib import Path

import httpx2
import pytest
from openai import AsyncOpenAI

from koodo_translation.storage import JobStore, state_directory
from koodo_translation.workflow import (
    InferenceError,
    Issue,
    Review,
    TranslatedSegment,
    Translation,
    TranslationInput,
    translate_job,
    validate_review,
    validate_translation,
)

SOURCE = TranslationInput.model_validate_json(
    (Path(__file__).parents[1] / "examples/sample.json").read_text()
)
DRAFT = {
    "segments": [
        {
            "segment_id": "sample-p1",
            "text": "延迟是单个请求完成所需的时间。吞吐量更高不一定延迟更低。",
        },
        {
            "segment_id": "sample-p2",
            "text": "batch_size = 8 设置批大小。更大的批大小可能提高吞吐量。",
        },
    ]
}
REVISION = {
    "segments": [
        {
            "segment_id": "sample-p1",
            "text": "延迟为请求耗时。吞吐量为每秒完成的请求数。吞吐量高不代表延迟低。",
        },
        DRAFT["segments"][1],
    ]
}
FINDING = {
    "issues": [
        {
            "segment_id": "sample-p1",
            "severity": "major",
            "category": "omission",
            "source_evidence": "Throughput is the number of requests completed per second.",
            "explanation": "The definition of throughput was omitted.",
            "suggested_fix": "Restore the complete definition.",
        }
    ]
}


class SubscriptionMock:
    """Real SDK + mock HTTP/SSE: exercises tools, schemas, request contract and repair."""

    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.requests = []

    def handle(self, request):
        assert str(request.url) == "https://api.openai.com/v1/responses"
        assert request.headers["authorization"] == "Bearer test-subscription-token"
        body = json.loads(request.content)
        assert body["store"] is False
        assert body["stream"] is True
        assert isinstance(body["input"], list)
        forbidden = {
            "background",
            "conversation",
            "previous_response_id",
            "max_output_tokens",
            "max_tool_calls",
            "metadata",
            "multi_agent",
            "prompt",
            "temperature",
            "top_p",
            "truncation",
            "user",
            "prompt_cache_retention",
            "safety_identifier",
        }
        assert not forbidden.intersection(body)
        assert all(item.get("role") != "system" for item in body["input"])
        assert all(tool["type"] == "namespace" for tool in body.get("tools", []))
        self.requests.append(body)
        output = self.outputs.pop(0)
        if output == "tool":
            assert body["tools"][0]["name"] == "book"
            items = [
                {
                    "type": "function_call",
                    "id": "fc_glossary",
                    "call_id": "call_glossary",
                    "namespace": "book",
                    "name": "lookup_glossary",
                    "arguments": "{}",
                    "status": "completed",
                }
            ]
        else:
            items = [
                {
                    "type": "message",
                    "id": f"msg_{len(self.requests)}",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": json.dumps(output, ensure_ascii=False),
                            "annotations": [],
                        }
                    ],
                }
            ]
        response = {
            "id": f"resp_{len(self.requests)}",
            "object": "response",
            "created_at": 1,
            "model": body["model"],
            "status": "completed",
            "output": items,
            "parallel_tool_calls": False,
            "tool_choice": "auto",
            "tools": [],
            "usage": {
                "input_tokens": 10,
                "output_tokens": 10,
                "total_tokens": 20,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        }
        if output == "quota":
            response.update(
                {
                    "status": "failed",
                    "output": [],
                    "error": {
                        "code": "subscription_sharing_usage_limit_exceeded",
                        "message": "Limit reached",
                    },
                }
            )
            event_type = "response.failed"
        else:
            event_type = "response.completed"
        event = {"type": event_type, "sequence_number": 0, "response": response}
        stream = f"event: {event_type}\ndata: {json.dumps(event)}\n\n"
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=stream)

    def client(self):
        return AsyncOpenAI(
            api_key="test-subscription-token",
            max_retries=0,
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(self.handle)),
        )


async def test_sdk_tool_translation_review_revision_and_resume(tmp_path):
    store = JobStore(state_directory(tmp_path))
    job = store.start(SOURCE.model_dump(), "test-model")
    mock = SubscriptionMock(["tool", DRAFT, FINDING, REVISION, {"issues": []}])
    async with mock.client() as client:
        result = await translate_job(SOURCE, "test-model", client, store, job["id"])
        assert result["status"] == "completed"
        assert result["artifacts"]["accepted"] == REVISION
        assert result["artifacts"]["draft"] == DRAFT
        assert result["artifacts"]["tool_calls"] == ["book.lookup_glossary"]
        assert sum(stage["requests"] for stage in result["artifacts"]["usage"]) == 5
        again = await translate_job(SOURCE, "test-model", client, store, job["id"])
        assert again["artifacts"] == result["artifacts"]
    assert len(mock.requests) == 5


async def test_failed_review_resumes_from_saved_draft(tmp_path):
    store = JobStore(state_directory(tmp_path))
    job = store.start(SOURCE.model_dump(), "test-model")
    first = SubscriptionMock(["tool", DRAFT, "quota"])
    async with first.client() as client:
        with pytest.raises(InferenceError):
            await translate_job(SOURCE, "test-model", client, store, job["id"])
    saved = store.get(job["id"])
    assert saved["artifacts"]["draft"] == DRAFT
    assert saved["status"] == "paused_usage_limit"
    assert "accepted" not in saved["artifacts"]
    second = SubscriptionMock([{"issues": []}])
    async with second.client() as client:
        result = await translate_job(SOURCE, "test-model", client, store, job["id"])
    assert result["status"] == "completed"
    assert len(second.requests) == 1


async def test_unresolved_revision_is_not_accepted(tmp_path):
    store = JobStore(state_directory(tmp_path))
    job = store.start(SOURCE.model_dump(), "test-model")
    mock = SubscriptionMock(["tool", DRAFT, FINDING, REVISION, FINDING])
    async with mock.client() as client:
        result = await translate_job(SOURCE, "test-model", client, store, job["id"])
    assert result["status"] == "needs_review"
    assert "accepted" not in result["artifacts"]
    assert result["artifacts"]["revision"] == REVISION
    assert len(mock.requests) == 5


def test_validation_rejects_lost_segments_protected_code_and_fake_evidence():
    with pytest.raises(ValueError, match="IDs"):
        validate_translation(SOURCE, Translation(segments=[]))
    invalid = Translation.model_validate(DRAFT)
    invalid.segments[1] = TranslatedSegment(segment_id="sample-p2", text="设置批大小为九。")
    with pytest.raises(ValueError, match="protected"):
        validate_translation(SOURCE, invalid)
    issue = Issue.model_validate(FINDING["issues"][0])
    issue.source_evidence = "Something not in the source"
    with pytest.raises(ValueError, match="evidence"):
        validate_review(SOURCE, Review(issues=[issue]))


def test_resume_rejects_changed_model_or_source(tmp_path):
    store = JobStore(state_directory(tmp_path))
    job = store.start(SOURCE.model_dump(), "test-model")
    assert store.start(SOURCE.model_dump(), "test-model", job["id"])["id"] == job["id"]
    with pytest.raises(ValueError, match="Resume"):
        store.start(SOURCE.model_dump(), "other-model", job["id"])
