"""Loopback-only API, exposed through the reader's same-origin Node server."""

import asyncio
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

from .auth import AuthenticationError
from .chapters import ChapterQueue
from .documents import MAX_PDF_BYTES, DocumentStore
from .storage import state_directory


@asynccontextmanager
async def lifespan(app):
    documents = DocumentStore(state_directory())
    queue = ChapterQueue(documents)
    app.state.documents, app.state.queue = documents, queue
    await queue.start()
    try:
        yield
    finally:
        await queue.stop()


class LocalAccess(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            allowed = {
                "https://koodoreader.localhost",
                "http://127.0.0.1:3016",
                "http://localhost:3016",
            }
            if request.headers.get("x-koodo-translation") != "1" or (
                origin and origin not in allowed
            ):
                return JSONResponse({"error": "请从本地阅读器发起此操作。"}, status_code=403)
        try:
            response = await call_next(request)
        except KeyError as error:
            response = JSONResponse({"error": str(error).strip("'")}, status_code=404)
        except ValueError as error:
            response = JSONResponse({"error": str(error)}, status_code=400)
        except AuthenticationError:
            response = JSONResponse(
                {"error": "订阅连接不可用，请重新登录 ChatGPT。"}, status_code=401
            )
        except Exception:
            response = JSONResponse(
                {"error": "操作未完成，请稍后重试；已保存的译文仍然保留。"}, status_code=500
            )
        response.headers["Cache-Control"] = "no-store"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        return response


async def health(request):
    return JSONResponse({"status": "ok"})


async def status(request):
    return JSONResponse(request.app.state.queue.auth.status())


async def models(request):
    return JSONResponse(await request.app.state.queue.auth.models())


def book_summary(book):
    return {key: value for key, value in book.items() if key != "blocks"}


async def books(request: Request):
    store = request.app.state.documents
    key = request.query_params.get("key", "")
    if not key or len(key) > 200:
        raise ValueError("缺少有效的书库标识。")
    if request.method == "GET":
        return JSONResponse(book_summary(store.find(key)))
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > MAX_PDF_BYTES:
            raise ValueError("PDF 大小不能超过 128 MB。")
    async with request.app.state.import_lock:
        book = await run_in_threadpool(
            store.import_pdf, bytes(data), key, request.query_params.get("title", "")[:500]
        )
    return JSONResponse(book_summary(book), status_code=201)


async def book(request):
    return JSONResponse(
        book_summary(request.app.state.documents.get(request.path_params["book_id"]))
    )


async def chapter(request):
    return JSONResponse(
        request.app.state.queue.chapter(
            request.path_params["book_id"],
            request.path_params["chapter_id"],
        )
    )


async def translate(request):
    data = await request.json()
    model = data.get("model")
    queue = request.app.state.queue
    available = await queue.auth.models()
    if model not in {item["slug"] for item in available}:
        raise ValueError("请选择当前订阅支持的模型。")
    task = queue.create(request.path_params["book_id"], request.path_params["chapter_id"], model)
    return JSONResponse(queue.summary(task), status_code=202)


async def control(request):
    queue = request.app.state.queue
    if request.path_params["action"] not in {"pause", "resume"}:
        raise KeyError("找不到该任务操作。")
    result = (
        queue.pause(request.path_params["task_id"])
        if request.path_params["action"] == "pause"
        else (queue.resume(request.path_params["task_id"]))
    )
    return JSONResponse(result)


async def source(request):
    store = request.app.state.documents
    book_id = request.path_params["book_id"]
    store.get(book_id)
    return FileResponse(store.folder(book_id) / "source.pdf", media_type="application/pdf")


async def image(request):
    store = request.app.state.documents
    data = await run_in_threadpool(
        store.image, request.path_params["book_id"], request.path_params["block_id"]
    )
    return Response(data, media_type="image/png")


app = Starlette(
    lifespan=lifespan,
    routes=[
        Route("/healthz", health),
        Route("/api/translation/status", status),
        Route("/api/translation/models", models),
        Route("/api/translation/books", books, methods=["GET", "POST"]),
        Route("/api/translation/books/{book_id}", book),
        Route("/api/translation/books/{book_id}/chapters/{chapter_id}", chapter),
        Route(
            "/api/translation/books/{book_id}/chapters/{chapter_id}/translate",
            translate,
            methods=["POST"],
        ),
        Route(
            "/api/translation/tasks/{task_id}/{action}",
            control,
            methods=["POST"],
        ),
        Route("/api/translation/books/{book_id}/source.pdf", source),
        Route("/api/translation/books/{book_id}/blocks/{block_id}/image", image),
    ],
)
app.state.import_lock = asyncio.Lock()
app.add_middleware(LocalAccess)
