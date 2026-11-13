const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { app, net, protocol, shell } = require("electron");
const { startBrowserReader } = require("./browser-reader");

const origin = "koodo-desktop://reader";
const executable = path.join(
  process.resourcesPath, "translation-runtime", "koodo-translation"
);
const renderer = path.join(__dirname, "../../../build");
let runtime;
let login;
let browserReader;

function register() {
  protocol.registerSchemesAsPrivileged([{ scheme: "koodo-desktop", privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
    stream: true,
  } }]);
}

function backendRequest(pathname, request) {
  return new Promise((resolve, reject) => {
    const method = request?.method || "GET";
    const headers = {};
    for (const key of ["content-type", "x-koodo-translation", "range"]) {
      const value = request?.headers.get(key);
      if (value) headers[key] = value;
    }
    const upstream = http.request({
      socketPath: runtime.socket, path: pathname, method, headers,
    }, (response) => {
      const hasBody = method !== "HEAD" && ![204, 205, 304].includes(response.statusCode);
      const safeHeaders = { "cache-control": "no-store" };
      for (const key of ["content-type", "content-length", "content-range", "content-disposition"]) {
        if (response.headers[key]) safeHeaders[key] = response.headers[key];
      }
      if (!hasBody) response.resume();
      resolve(new Response(hasBody ? Readable.toWeb(response) : null, {
        status: response.statusCode, headers: safeHeaders,
      }));
    });
    upstream.setTimeout(240000, () => upstream.destroy(new Error("Translation request timed out")));
    upstream.on("error", reject);
    const abort = () => upstream.destroy(new Error("Translation request cancelled"));
    request?.signal?.addEventListener("abort", abort, { once: true });
    upstream.once("close", () => request?.signal?.removeEventListener("abort", abort));
    if (request?.signal?.aborted) return abort();
    if (request?.body) {
      const body = Readable.fromWeb(request.body);
      body.on("error", () => upstream.destroy());
      body.pipe(upstream);
    } else upstream.end();
  });
}

function connectProtocol() {
  protocol.handle("koodo-desktop", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "reader" || url.username || url.password) return new Response(null, { status: 404 });
    if (url.pathname.startsWith("/api/translation/")) {
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin && requestOrigin !== origin) return new Response(null, { status: 403 });
      if (!["GET", "HEAD", "POST"].includes(request.method) ||
          (request.method === "POST" && request.headers.get("x-koodo-translation") !== "1")) {
        return new Response(null, { status: 403 });
      }
      try {
        await runtime?.ready;
        if (!runtime) throw new Error("Translation service unavailable");
        return await backendRequest(url.pathname + url.search, request);
      } catch {
        return Response.json({ error: "翻译后台不可用，请重新打开 Koodo Reader。" }, { status: 503 });
      }
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    try {
      const target = path.resolve(renderer, "." + decodeURIComponent(url.pathname));
      if (!target.startsWith(renderer + path.sep)) return new Response(null, { status: 404 });
      return await net.fetch(pathToFileURL(target).href);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

function start() {
  // macOS Unix socket paths are limited to roughly 104 bytes.
  const directory = mkdtempSync(path.join("/tmp", "koodo-translation-"));
  const socket = path.join(directory, "api.sock");
  const data = path.join(app.getPath("userData"), "translation");
  const child = spawn(executable, ["serve", socket, data], {
    stdio: "ignore", env: { ...process.env, PYINSTALLER_RESET_ENVIRONMENT: "1" },
  });
  runtime = { child, socket, data };
  child.on("error", () => {});
  child.once("close", () => rmSync(directory, { recursive: true, force: true }));
  runtime.ready = (async () => {
    for (let attempt = 0; attempt < 75; attempt++) {
      if (child.exitCode !== null || child.signalCode) throw new Error("Translation service exited");
      try {
        const response = await backendRequest("/healthz");
        await response.text();
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Translation service did not start");
  })();
  runtime.ready.catch(() => {});
  browserReader = startBrowserReader(renderer, async (pathname, request) => {
    await runtime.ready;
    return backendRequest(pathname, request);
  });
}

async function openInBrowser(senderUrl, book, page, bilingual) {
  if (!senderUrl?.startsWith(origin + "/") || !browserReader) return false;
  await shell.openExternal(await browserReader.url(book, page, bilingual));
  return true;
}

function signIn(senderUrl) {
  if (!senderUrl?.startsWith(origin + "/") || !runtime) return false;
  if (login) return login;
  const child = spawn(executable, ["cli", "--state-dir", runtime.data, "login"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, PYINSTALLER_RESET_ENVIRONMENT: "1" },
  });
  login = new Promise((resolve) => {
    const finish = (ok) => { login = null; resolve(ok); };
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-65536);
      const match = output.match(/"authorization_url":\s*("(?:[^"\\]|\\.)*")/);
      if (!match || child.browserOpened) return;
      try {
        const url = new URL(JSON.parse(match[1]));
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize") return;
        child.browserOpened = true;
        shell.openExternal(url.href).catch(() => child.kill());
      } catch {}
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
  runtime.loginChild = child;
  return login;
}

async function stop() {
  browserReader?.close();
  if (!runtime) return;
  runtime.loginChild?.kill();
  const child = runtime.child;
  if (child.exitCode !== null || child.signalCode || !child.pid) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 8000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

module.exports = { origin, register, connectProtocol, start, signIn, openInBrowser, stop };
