'use strict';
// server/serve-static.js — 本地开发用静态服务器（支持 HTTP Range，供前端按需拉取联调）。
// 生产环境用 Apache/Nginx 直接托管 web/ 即可（均原生支持 Range）。
// 用法：node server/serve-static.js [port]   然后访问 http://localhost:<port>/?seasonid=<id>
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'web');
const PORT = Number(process.argv[2]) || 4607;
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.jsonl': 'application/x-ndjson; charset=utf-8', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-store');
        if (range && (range[1] || range[2])) {
            let start, end;
            if (range[1] === '') { start = Math.max(0, st.size - Number(range[2])); end = st.size - 1; }
            else { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1; }
            if (start > end || start >= st.size) { res.writeHead(416); return res.end(); }
            res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${st.size}` });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
            fs.createReadStream(filePath).pipe(res);
        }
    });
}).listen(PORT, '127.0.0.1', () => console.log(`serving web/ at http://127.0.0.1:${PORT}/?seasonid=8019898`));
