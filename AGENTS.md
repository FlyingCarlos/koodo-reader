## Local service lifecycle

Our maintained mainline is `codex/main`, based on upstream tag v2.4.6 (1fd0cc7f151916447d396e0c8a2c036180992cab). Push our changes to `fork/codex/main`; `origin` remains the official upstream. See `docs/local-service.md` for this Mac's deployment settings and maintenance commands.
Install web build dependencies with `yarn install --frozen-lockfile --ignore-scripts --ignore-optional`; the Electron native postinstall and optional macOS file watchers are not needed for this production web deployment. If an earlier install left `node_modules/fsevents`, remove that optional package before building: on this Mac its native module load stalled the build.
The production server is `scripts/local-server.cjs`, serving only `build/` on loopback port 3016. `/healthz` validates the index and manifest entrypoints. Reader data remains managed by the web client; hosting the app does not automatically migrate the official website's library or provide server-side sync.

This project runs as the macOS user LaunchAgent `com.carlosz.koodoreader`.

After any runtime-affecting code or configuration change:

1. Run `node --check scripts/local-server.cjs && yarn build` and complete the production build.
2. If the plist or runner changed, run `scripts/koodoreader-service.zsh install`; otherwise run `scripts/koodoreader-service.zsh restart`.
3. Run `scripts/koodoreader-service.zsh status` and verify `http://127.0.0.1:3016/healthz` at `/healthz` both directly and through `https://koodoreader.localhost/healthz`.
4. Confirm the existing Homepage card still links to `https://koodoreader.localhost` and its monitor reports HTTP 200.
5. If verification fails, inspect `scripts/koodoreader-service.zsh logs` before reporting completion.
