const { randomBytes } = require("node:crypto");
const http = require("node:http");
const { Readable } = require("node:stream");

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
);

const bookId = /^[a-f0-9]{64}$/;
const chapterId = /^chapter-\d{4}$/;

function render(book, content, base) {
  const index = book.chapters.findIndex((chapter) => chapter.id === content.chapter.id);
  const adjacent = (offset, label) => {
    const chapter = book.chapters[index + offset];
    return chapter ? `<a href="${base}/${escape(chapter.id)}">${label}</a>` : "";
  };
  let lastPage = 0;
  const paragraphs = content.blocks.filter((block) =>
    block.text && block.page >= content.chapter.start_page && block.page <= content.chapter.end_page
  ).map((block) => {
    const page = block.page === lastPage ? "" : `<h3 id="page-${escape(block.page)}">PDF 第 ${escape(block.page)} 页</h3>`;
    lastPage = block.page;
    const tag = block.kind === "code" ? "pre" : block.kind === "heading" ? "h4" : "p";
    const translated = block.translation?.text
      ? `<p class="translation" lang="zh-CN">${escape(block.translation.text)}</p>` : "";
    return `${page}<${tag} lang="en">${escape(block.text)}</${tag}>${translated}`;
  }).join("");
  const title = escape(book.title);
  const chapter = escape(content.chapter.title);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${chapter} · Koodo Reader</title>
<style>
body{max-width:48rem;margin:3rem auto;padding:0 1.25rem;font:18px/1.7 system-ui;color:#21282e;background:#fcfbf8}
header{border-bottom:1px solid #d6d4ca;padding-bottom:1rem}h1,h2,h3,h4{line-height:1.3}
nav{display:flex;gap:1.25rem;flex-wrap:wrap}a{color:#125d69}summary{cursor:pointer}
h3{margin-top:2rem;color:#475c61}p,pre,h4{white-space:pre-wrap;overflow-wrap:anywhere}
.translation{margin:-.5em 0 1.5em;border-left:3px solid #8daaa5;padding-left:1rem}
@media(prefers-color-scheme:dark){body{background:#172024;color:#eef2ee}a{color:#93d9dd}h3{color:#a4c4c7}}
</style></head><body><header><h1>${title}</h1><nav aria-label="章节导航">
${adjacent(-1, "上一章")}${adjacent(1, "下一章")}<a href="${base}/source.pdf">打开原 PDF</a></nav>
<details><summary>目录</summary><ol>${book.chapters.map((item) =>
    `<li><a href="${base}/${escape(item.id)}">${escape(item.title)}</a></li>`).join("")}</ol></details>
</header><main><h2>${chapter}</h2>${paragraphs || "<p>本章没有可提取的文字，可打开原 PDF 查看。</p>"}</main></body></html>`;
}

function startBrowserReader(requestBackend) {
  const token = randomBytes(24).toString("hex");
  const shared = new Set();
  const server = http.createServer(async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    const reply = (status, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { ...headers, "Content-Type": type });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.headers.host !== address || req.headers["sec-fetch-site"] === "cross-site") {
      return reply(403, "此阅读页仅供本机访问。");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "此页面为只读。");
    const [, prefix, id, item, ...extra] = req.url.split("?")[0].split("/");
    if (prefix !== token || !shared.has(id) || extra.length) return reply(404, "找不到阅读页。");
    try {
      const get = async (suffix, options) => {
        const response = await requestBackend(`/api/translation/books/${id}${suffix}`, options);
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Reader backend request failed");
        }
        return response;
      };
      if (item === "source.pdf") {
        const pdf = await get("/source.pdf", new Request("http://127.0.0.1", {
          method: req.method,
          headers: req.headers.range ? { range: req.headers.range } : {},
        }));
        for (const key of ["content-length", "content-range"]) {
          if (pdf.headers.has(key)) headers[key] = pdf.headers.get(key);
        }
        res.writeHead(pdf.status, { ...headers, "Content-Type": "application/pdf", "Accept-Ranges": "bytes" });
        if (!pdf.body) return res.end();
        const stream = Readable.fromWeb(pdf.body);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      const book = await (await get("")).json();
      const chapter = item || book.chapters[0]?.id;
      if (!chapterId.test(chapter) || !book.chapters.some((entry) => entry.id === chapter)) {
        return reply(404, "找不到该章节。");
      }
      const content = await (await get(`/chapters/${chapter}`)).json();
      reply(200, render(book, content, `/${token}/${id}`), "text/html; charset=utf-8");
    } catch {
      if (!res.headersSent) reply(503, "暂时无法读取，请确认 Koodo Reader 仍在运行。");
      else res.destroy();
    }
  });
  let address;
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      address = `127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  ready.catch(() => {});
  return {
    async url(id, chapter, page) {
      if (!bookId.test(id) || (chapter && !chapterId.test(chapter))) throw new Error("Invalid book");
      await ready;
      shared.add(id);
      const fragment = Number.isSafeInteger(page) && page > 0 ? `#page-${page}` : "";
      return `http://${address}/${token}/${id}${chapter ? "/" + chapter : ""}${fragment}`;
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

module.exports = { startBrowserReader };
