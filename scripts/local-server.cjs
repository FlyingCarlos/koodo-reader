const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../build');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.pdf':'application/pdf','.xml':'application/xml','.txt':'text/plain; charset=utf-8'};

function ready() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'asset-manifest.json'), 'utf8'));
    const files = ['index.html', ...(manifest.entrypoints || [])];
    return files.length > 1 && files.every(file => fs.statSync(path.join(root, file)).isFile());
  } catch { return false; }
}

const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, {Allow:'GET, HEAD'}); res.end(); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  if (pathname === '/healthz') {
    const healthy = ready();
    res.writeHead(healthy ? 200 : 503, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({status:healthy ? 'ok' : 'not-ready'}));
    return;
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Content-Length':stat.size, 'Cache-Control':pathname.startsWith('/static/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options':'nosniff'});
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});
server.listen(3016, '127.0.0.1', () => console.log('Koodo Reader listening on 127.0.0.1:3016'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
