const { randomBytes } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { stat } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");

const bookId = /^[a-f0-9]{64}$/;
const readRoute = /^(?:\/source\.pdf|\/whole|\/layout|\/chapters\/chapter-\d{4}|\/blocks\/[\w-]+\/image)?$/;
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain",
};

function startBrowserReader(renderer, requestBackend) {
  const token = randomBytes(24).toString("hex");
  const shared = new Set();
  let address;
  const server = http.createServer(async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    };
    const reply = (status, body) => {
      res.writeHead(status, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.headers.host !== address || req.headers["sec-fetch-site"] === "cross-site") {
      return reply(403, "此阅读页仅供本机访问。");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "此页面为只读。");
    try {
      const url = new URL(req.url, `http://${address}`);
      const pathname = decodeURIComponent(url.pathname);
      const [, prefix, id, ...parts] = pathname.split("/");
      const bookRoot = prefix === token && shared.has(id);
      const requested = bookRoot ? parts.join("/") : pathname.slice(1);
      if (bookRoot && (requested === "api/translation/books" || requested.startsWith("api/translation/books/"))) {
        const base = `api/translation/books/${id}`;
        if (requested !== "api/translation/books" && requested !== base && !requested.startsWith(base + "/")) {
          return reply(404, "找不到阅读页。");
        }
        if (requested === "api/translation/books" && url.searchParams.get("key") !== id) {
          return reply(404, "找不到阅读页。");
        }
        const suffix = requested === "api/translation/books" ? "" : requested.slice(base.length);
        if (!readRoute.test(suffix)) return reply(404, "找不到阅读页。");
        const response = await requestBackend(`/api/translation/books/${id}${suffix}${url.search}`,
          new Request("http://127.0.0.1", {
            method: req.method,
            headers: req.headers.range ? { range: req.headers.range } : {},
          }));
        for (const key of ["content-type", "content-length", "content-range"]) {
          if (response.headers.has(key)) headers[key] = response.headers.get(key);
        }
        if (suffix === "/source.pdf") headers["Accept-Ranges"] = "bytes";
        res.writeHead(response.status, headers);
        if (!response.body) return res.end();
        const stream = Readable.fromWeb(response.body);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      const asset = /^(?:static|lib|assets)\/|^favicon\.png$/;
      if (!(bookRoot && requested === "index.html") && !asset.test(requested)) {
        return reply(404, "找不到阅读页。");
      }
      const target = path.resolve(renderer, requested);
      if (!target.startsWith(renderer + path.sep)) return reply(404, "找不到阅读页。");
      const file = await stat(target);
      if (!file.isFile()) return reply(404, "找不到阅读页。");
      res.writeHead(200, {
        ...headers,
        "Content-Type": mime[path.extname(target)] || "application/octet-stream",
        "Content-Length": file.size,
      });
      if (req.method === "HEAD") return res.end();
      const stream = createReadStream(target);
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      return stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) {
        return error.code === "ENOENT"
          ? reply(404, "找不到阅读页。")
          : reply(503, "暂时无法读取，请确认 Koodo Reader 仍在运行。");
      }
      res.destroy();
    }
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      address = `127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  ready.catch(() => {});
  return {
    async url(id, page, bilingual) {
      if (typeof id !== "string" || !bookId.test(id)) throw new Error("Invalid book");
      await ready;
      shared.add(id);
      const initialPage = Number.isSafeInteger(page) && page > 0 ? page : 1;
      return `http://${address}/${token}/${id}/index.html#/pdf/${id}?page=${initialPage}&bilingual=${bilingual === true ? "yes" : "no"}`;
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
module.exports = { startBrowserReader };
