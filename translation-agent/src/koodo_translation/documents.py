"""Extract source-owned blocks and outline ranges from text PDFs."""

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

import pymupdf

from .storage import JobStore, write_private_json

EXTRACTION_VERSION = "pdf-blocks-v2"
MAX_PDF_BYTES = 128 * 1024 * 1024


def normalize_lines(lines: list[str]) -> str:
    result = ""
    for line in lines:
        line = re.sub(r"\s+", " ", line.replace("\u00ad", "")).strip()
        if not line:
            continue
        if result.endswith("-") and re.match(r"^[a-z]", line):
            result = result[:-1] + line
        else:
            result += (" " if result else "") + line
    return result


def chapter_ranges(toc: list[list], page_count: int) -> list[dict]:
    valid = [row for row in toc if 1 <= row[2] <= page_count]
    chapter_rows = [
        row for row in valid if re.match(r"^(chapter\s+\d|第.+章|appendix\b)", row[1], re.I)
    ]
    depth = min(
        (row[0] for row in chapter_rows),
        default=min(
            (row[0] for row in valid),
            default=1,
        ),
    )
    starts = {}
    for level, title, page in valid:
        if level == depth and page not in starts:
            starts[page] = title.strip()
    if not starts:
        # PDFs without bookmarks get explicit page groups instead of invented chapter titles.
        starts = {
            page: f"Pages {page}–{min(page + 9, page_count)}"
            for page in range(1, page_count + 1, 10)
        }
    elif min(starts) > 1:
        starts[1] = "Front matter"
    pages = sorted(starts)
    return [
        {
            "id": f"chapter-{page:04d}",
            "title": starts[page],
            "start_page": page,
            "end_page": pages[index + 1] - 1 if index + 1 < len(pages) else page_count,
        }
        for index, page in enumerate(pages)
    ]


def _parts(text: str, limit: int = 5000) -> list[str]:
    if len(text) <= limit:
        return [text]
    result = []
    while len(text) > limit:
        boundary = text.rfind(" ", 0, limit)
        boundary = boundary if boundary > limit // 2 else limit
        result.append(text[:boundary].strip())
        text = text[boundary:].strip()
    return result + ([text] if text else [])


def image_regions(page) -> list[list[float]]:
    """PDF figures can be mosaics of overlapping tiles; render each connected region once."""
    regions = [
        pymupdf.Rect(image["bbox"])
        for image in page.get_image_info()
        if pymupdf.Rect(image["bbox"]).get_area() >= 1000
    ]
    result = []
    while regions:
        region = regions.pop(0)
        changed = True
        while changed:
            changed = False
            for other in list(regions):
                expanded = region + (-1.5, -1.5, 1.5, 1.5)
                if expanded.intersects(other):
                    region |= other
                    regions.remove(other)
                    changed = True
        if region.y1 >= 45 and region.y0 <= page.rect.height - 20:
            result.append(list(region))
    return result


def extract_pdf(path: Path, book_id: str, title: str = "") -> dict:
    with pymupdf.open(path) as pdf:
        if pdf.needs_pass:
            raise ValueError("PDF 已加密，请先提供可读取的文件。")
        if not 1 <= len(pdf) <= 3000:
            raise ValueError("仅支持 1–3000 页的 PDF。")
        pages = [
            page.get_text("dict", sort=True, flags=pymupdf.TEXTFLAGS_DICT & ~4) for page in pdf
        ]
        sizes = Counter()
        for page in pages:
            for block in page["blocks"]:
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        sizes[round(span["size"], 1)] += len(span["text"])
        body_size = sizes.most_common(1)[0][0] if sizes else 10
        toc = pdf.get_toc()
        chapters = chapter_ranges(toc, len(pdf))
        nodes = []
        empty_pages = []
        for page_index, data in enumerate(pages):
            page = pdf[page_index]
            page_number = page_index + 1
            chapter = next(c for c in chapters if c["start_page"] <= page_number <= c["end_page"])
            page_nodes = []
            for block_index, block in enumerate(data["blocks"]):
                if block.get("type") != 0:
                    continue
                spans = [s for line in block["lines"] for s in line["spans"] if s["text"].strip()]
                if not spans:
                    continue
                lines = ["".join(s["text"] for s in line["spans"]) for line in block["lines"]]
                text = normalize_lines(lines)
                bbox = [round(value, 2) for value in block["bbox"]]
                font_size = max(s["size"] for s in spans)
                at_edge = bbox[3] < page.rect.height * 0.085 or bbox[1] > page.rect.height * 0.94
                if at_edge and (font_size < body_size * 0.95 or text.isdigit()):
                    continue
                mono = [
                    s
                    for s in spans
                    if re.search(r"mono|courier|consolas|menlo|typewriter", s["font"], re.I)
                ]
                mono_chars = sum(len(s["text"]) for s in mono)
                kind = "paragraph"
                if mono_chars > len(text) * 0.55:
                    kind, text = "code", "\n".join(lines).strip()
                elif font_size >= body_size * 1.25 and len(text) < 250:
                    kind = "heading"
                elif re.match(r"^Figure\s+[\d.]+", text, re.I):
                    kind = "caption"
                elif re.match(r"^[•●▪]|^\d+[.)]\s", text):
                    kind = "list"
                protected = [s["text"].strip() for s in mono if s["text"].strip() in text]
                anchor = {"page": page_number, "bbox": bbox}
                for part_index, part in enumerate(_parts(text) if kind != "code" else [text]):
                    page_nodes.append(
                        {
                            "id": f"p{page_number:04d}-b{block_index:03d}-{part_index}",
                            "chapter_id": chapter["id"],
                            "page": page_number,
                            "end_page": page_number,
                            "kind": kind,
                            "text": part,
                            "anchors": [anchor],
                            "raw_text": "\n".join(lines),
                            "protected": sorted({value for value in protected if value in part}),
                        }
                    )
            if not page_nodes:
                empty_pages.append(page_number)
            # Source images stay local. Rasterize on demand; do not send figures to the text agent.
            for image_index, bbox in enumerate(image_regions(page)):
                page_nodes.append(
                    {
                        "id": f"p{page_number:04d}-image{image_index:03d}",
                        "chapter_id": chapter["id"],
                        "page": page_number,
                        "end_page": page_number,
                        "kind": "image",
                        "text": "",
                        "anchors": [{"page": page_number, "bbox": bbox}],
                        "raw_text": "",
                        "protected": [],
                    }
                )
            page_nodes.sort(
                key=lambda node: (
                    round(node["anchors"][0]["bbox"][1] / 4),
                    node["anchors"][0]["bbox"][0],
                )
            )
            for node in page_nodes:
                previous = nodes[-1] if nodes else None
                if (
                    previous
                    and node["kind"] == previous["kind"] == "paragraph"
                    and node["chapter_id"] == previous["chapter_id"]
                    and node["page"] == previous["end_page"] + 1
                    and previous["anchors"][-1]["bbox"][3] > page.rect.height * 0.70
                    and node["anchors"][0]["bbox"][1] < page.rect.height * 0.22
                    and not re.search(r"[.!?:;。！？]$", previous["text"])
                    and re.match(r"^[a-z]", node["text"])
                    and len(previous["text"]) + len(node["text"]) < 5000
                ):
                    previous["text"] = normalize_lines([previous["text"], node["text"]])
                    previous["raw_text"] += "\n" + node["raw_text"]
                    previous["anchors"].extend(node["anchors"])
                    previous["end_page"] = node["page"]
                    previous["protected"] = sorted(set(previous["protected"] + node["protected"]))
                else:
                    nodes.append(node)
        for chapter in chapters:
            chapter["block_count"] = sum(n["chapter_id"] == chapter["id"] for n in nodes)
            chapter["text_count"] = sum(
                n["chapter_id"] == chapter["id"]
                and n["kind"]
                not in {
                    "code",
                    "image",
                }
                for n in nodes
            )
        outline = []
        for level, label, page_number in toc:
            candidates = [n for n in nodes if n["page"] == page_number and n["kind"] != "image"]
            plain_label = re.sub(r"\W+", "", label).lower()
            target = next(
                (n for n in candidates if plain_label in re.sub(r"\W+", "", n["text"]).lower()),
                candidates[0] if candidates else None,
            )
            owner = next(
                (c for c in chapters if c["start_page"] <= page_number <= c["end_page"]), None
            )
            if owner:
                outline.append(
                    {
                        "title": label,
                        "level": level,
                        "page": page_number,
                        "chapter_id": owner["id"],
                        "block_id": target["id"] if target else None,
                    }
                )
        return {
            "id": book_id,
            "title": title or pdf.metadata.get("title") or path.stem,
            "extractor_version": EXTRACTION_VERSION,
            "page_count": len(pdf),
            "chapters": chapters,
            "outline": outline,
            "blocks": nodes,
            "empty_text_pages": empty_pages,
        }


class DocumentStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self.root = directory / "books"
        self.root.mkdir(exist_ok=True, mode=0o700)
        self.jobs = JobStore(directory)
        with self.jobs.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS book_aliases (key TEXT PRIMARY KEY, book_id TEXT)"
            )

    def folder(self, book_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{64}", book_id):
            raise ValueError("无效的书籍标识。")
        return self.root / book_id

    def import_pdf(self, content: bytes, key: str, title: str = "") -> dict:
        if not content or len(content) > MAX_PDF_BYTES or b"%PDF-" not in content[:1024]:
            raise ValueError("请选择不超过 128 MB 的有效 PDF。")
        source_hash = hashlib.sha256(content).hexdigest()
        book_id = hashlib.sha256((source_hash + EXTRACTION_VERSION).encode()).hexdigest()
        folder = self.folder(book_id)
        folder.mkdir(exist_ok=True, mode=0o700)
        source = folder / "source.pdf"
        manifest_path = folder / "document.json"
        if not manifest_path.exists():
            source.write_bytes(content)
            source.chmod(0o600)
            manifest = extract_pdf(source, book_id, title)
            manifest["source_hash"] = source_hash
            write_private_json(manifest_path, manifest)
        with self.jobs.connect() as db:
            db.execute(
                "INSERT INTO book_aliases VALUES(?,?) ON CONFLICT(key) "
                "DO UPDATE SET book_id=excluded.book_id",
                (key, book_id),
            )
        return self.get(book_id)

    def get(self, book_id: str) -> dict:
        try:
            return json.loads((self.folder(book_id) / "document.json").read_text())
        except FileNotFoundError as error:
            raise KeyError("尚未提取这本书，请先导入 PDF。") from error

    def find(self, key: str) -> dict:
        with self.jobs.connect() as db:
            row = db.execute("SELECT book_id FROM book_aliases WHERE key=?", (key,)).fetchone()
        if not row:
            raise KeyError("尚未提取这本书。")
        return self.get(row["book_id"])

    def image(self, book_id: str, block_id: str) -> bytes:
        manifest = self.get(book_id)
        node = next((node for node in manifest["blocks"] if node["id"] == block_id), None)
        if not node or node["kind"] != "image":
            raise KeyError("找不到原图。")
        with pymupdf.open(self.folder(book_id) / "source.pdf") as pdf:
            anchor = node["anchors"][0]
            return (
                pdf[anchor["page"] - 1]
                .get_pixmap(
                    clip=pymupdf.Rect(anchor["bbox"]),
                    matrix=pymupdf.Matrix(2, 2),
                )
                .tobytes("png")
            )
