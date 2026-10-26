"""Budgeted multi-segment calls; never change source IDs to combine requests."""

import math
from dataclasses import dataclass

from .toc import compact_text, split_entry, toc_block_ids

TRANSLATABLE = {"paragraph", "heading", "list", "caption"}
SOURCE_MODE = "compact-toc-v1"


@dataclass(frozen=True)
class BatchBudget:
    max_segments: int = 96
    max_characters: int = 20_000
    max_input_tokens: int = 6_000
    max_output_tokens: int = 6_000
    max_review_tokens: int = 14_000
    overhead_tokens: int = 1_500


DEFAULT_BUDGET = BatchBudget()


def estimate(text: str):
    # Conservative local estimates, not a model-specific tokenizer. Reserve JSON
    # IDs/schema per segment, plus shared prompts/tools/glossary per request.
    size = len(text.encode("utf-8"))
    return math.ceil(size / 3) + 36, math.ceil(size / 2) + 24


def segment_payload(block: dict, mode: str | None = None, *, is_toc: bool = False) -> dict:
    if mode != SOURCE_MODE or not is_toc:
        return {
            "id": block["id"],
            "text": block.get("translation_source", block["text"]),
            "protected": block.get("protected", []),
        }
    text = compact_text(block["text"])
    protected = list(block.get("protected", []))
    if any(literal not in text for literal in protected):
        return {"id": block["id"], "text": block["text"], "protected": protected}
    entry = split_entry(block["text"])
    if entry:
        protected.append(f"\t{entry[1]}")
    return {"id": block["id"], "text": text, "protected": sorted(set(protected))}


def batches(blocks: list[dict], budget: BatchBudget = DEFAULT_BUDGET) -> list[list[str]]:
    result, current = [], []
    characters = input_tokens = output_tokens = 0
    contents = toc_block_ids(blocks)
    for block in blocks:
        if block["kind"] not in TRANSLATABLE:
            continue
        text = segment_payload(block, SOURCE_MODE, is_toc=block["id"] in contents)["text"]
        source, translated = estimate(text)
        overflow = (
            len(current) + 1 > budget.max_segments
            or characters + len(text) > budget.max_characters
            or input_tokens + source + budget.overhead_tokens > budget.max_input_tokens
            or output_tokens + translated > budget.max_output_tokens
            or input_tokens + source + output_tokens + translated + budget.overhead_tokens
            > budget.max_review_tokens
        )
        if current and overflow:
            result.append(current)
            current, characters, input_tokens, output_tokens = [], 0, 0, 0
        current.append(block["id"])
        # An indivisible legacy block may exceed this soft estimate; it gets its
        # own call, still subject to TranslationInput's hard character limit.
        characters += len(text)
        input_tokens += source
        output_tokens += translated
    return result + ([current] if current else [])


def replan_unstarted(chunks: list[dict], nodes: dict[str, dict]) -> list[dict]:
    """Only coalesce contiguous chunks with no job/fingerprint yet; retain all started jobs."""
    result, pending = [], []

    def flush():
        result.extend(
            {"ids": ids, "job_id": None, "source_mode": SOURCE_MODE}
            for ids in batches([nodes[i] for i in pending])
        )
        pending.clear()

    for chunk in chunks:
        if chunk["job_id"]:
            flush()
            result.append(chunk)
        else:
            pending.extend(chunk["ids"])
    flush()
    return result
