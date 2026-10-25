## Local service lifecycle

Our maintained mainline is `codex/main`, based on upstream tag v2.4.6 (1fd0cc7f151916447d396e0c8a2c036180992cab). Push our changes to `fork/codex/main`; `origin` remains the official upstream. See `docs/local-service.md` for this Mac's deployment settings and maintenance commands.
Install web build dependencies with `yarn install --frozen-lockfile --ignore-scripts --ignore-optional`; the Electron native postinstall and optional macOS file watchers are not needed for this production web deployment. If an earlier install left `node_modules/fsevents`, remove that optional package before building: on this Mac its native module load stalled the build.
The production server is `scripts/local-server.cjs`, serving `build/` on loopback port 3016 and proxying `/api/translation/` to its managed Python child on loopback port 3017. `/healthz` validates the index, manifest entrypoints and Python readiness. Reader data remains managed by the web client; hosting the app does not automatically migrate the official website's library or provide server-side sync. Imported translation sources and results are stored separately in the private translation state directory.

This project runs as the macOS user LaunchAgent `com.carlosz.koodoreader`.

The Python translation backend lives in `translation-agent/`; its runtime is OpenAI Agents SDK. Use `uv sync --locked --python 3.12`, `uv run ruff check src tests`, `uv run ruff format --check src tests`, and `uv run pytest -q` in that directory. See `translation-agent/README.md` for subscription authorization, PDF extraction, chapter tasks and stage-level resume. Credentials and job state must stay outside the repository and `build/`. Never reuse Codex's credentials or silently fall back from subscription usage to an API key. The deployed PDF reader's bilingual mode uses this backend through the same-origin API. Do not start a second production worker against the same state directory.

After any runtime-affecting code or configuration change:

1. Run `node --check scripts/local-server.cjs && yarn build` and complete the production build.
2. If the plist or runner changed, run `scripts/koodoreader-service.zsh install`; otherwise run `scripts/koodoreader-service.zsh restart`.
3. Run `scripts/koodoreader-service.zsh status` and verify `http://127.0.0.1:3016/healthz` at `/healthz` both directly and through `https://koodoreader.localhost/healthz`.
4. Confirm the existing Homepage card still links to `https://koodoreader.localhost` and its monitor reports HTTP 200.
5. If verification fails, inspect `scripts/koodoreader-service.zsh logs` before reporting completion.
