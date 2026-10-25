"""CLI-only subscription verification; no reader data or service routes are changed."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from openai import AsyncOpenAI
from pydantic import ValidationError

from .auth import API, AuthenticationError, ChatGPTAuth
from .storage import JobStore, exclusive_lock, state_directory
from .workflow import TranslationInput, translate_job


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2), flush=True)


async def execute(args, directory: Path):
    auth = ChatGPTAuth(directory)
    if args.command == "models":
        emit(await auth.models())
        return
    store = JobStore(directory)
    if args.command == "jobs":
        emit(store.list_jobs())
        return
    if args.command == "show":
        job = store.get(args.job_id)
        emit({key: job[key] for key in ("id", "model", "status", "error_code", "artifacts")})
        return
    source = TranslationInput.model_validate_json(args.input.read_text())
    with exclusive_lock(directory / "worker.lock"):
        job = store.start(source.model_dump(), args.model, args.resume)
        emit({"job_id": job["id"], "status": job["status"]})
        if job["status"] not in {"completed", "needs_review"}:
            models = await auth.models()
            if args.model not in {model["slug"] for model in models}:
                raise AuthenticationError(
                    "Selected model is not in the signed-in account's catalog."
                )
            async with AsyncOpenAI(
                api_key=auth.access_token,
                base_url=API,
                max_retries=0,
            ) as client:
                job = await translate_job(source, args.model, client, store, job["id"])
        emit({key: job[key] for key in ("id", "model", "status", "artifacts")})
        if job["status"] != "completed":
            raise RuntimeError("The draft needs review; it has not been marked complete.")


def main():
    parser = argparse.ArgumentParser(description="Koodo translation agents with ChatGPT plan usage")
    parser.add_argument("--state-dir", type=Path, help="Private local state directory")
    commands = parser.add_subparsers(dest="command", required=True)
    login = commands.add_parser("login", help="Continue with ChatGPT in Edge using the printed URL")
    login.add_argument("--timeout", type=int, default=300)
    commands.add_parser("status", help="Print connection status without credentials")
    commands.add_parser("models", help="List models available to this ChatGPT connection")
    commands.add_parser("jobs", help="List local translation jobs")
    show = commands.add_parser("show", help="Show a saved draft, review and revision")
    show.add_argument("job_id")
    translate = commands.add_parser("translate", help="Translate and review a small JSON input")
    translate.add_argument("--input", type=Path, required=True)
    translate.add_argument("--model", required=True, help="A slug returned by the models command")
    translate.add_argument("--resume", help="Continue a saved job with the same input and model")
    args = parser.parse_args()
    try:
        directory = state_directory(args.state_dir)
        if args.command == "login":
            emit(
                ChatGPTAuth(directory).login(
                    lambda url: emit(
                        {
                            "action": "Continue with ChatGPT",
                            "authorization_url": url,
                            "instructions": (
                                "Open this URL in Edge and review the ChatGPT plan usage consent."
                            ),
                        }
                    ),
                    timeout=args.timeout,
                )
            )
        elif args.command == "status":
            emit(ChatGPTAuth(directory).status())
        else:
            asyncio.run(execute(args, directory))
    except KeyboardInterrupt:
        print("Interrupted. Saved stages can be resumed.", file=sys.stderr)
        raise SystemExit(130) from None
    except Exception as error:
        # Avoid printing SDK/OAuth exception bodies, request headers, source text or credentials.
        safe_message = (
            str(error)
            if isinstance(error, (AuthenticationError, ValueError))
            and not (isinstance(error, ValidationError))
            else (
                "Operation failed. Inspect the saved job status; credentials and partial streams "
                "were not printed."
            )
        )
        emit(
            {"error": getattr(error, "code", None) or type(error).__name__, "message": safe_message}
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
