#!/usr/bin/env node

// TODO
//  - live/dev mode?
//  - index.html should probably be "synthesized", or templated, so that
//    version can be updated in live mode?
//  - live mode changes:
//     - `Cache-Control: max=age=15` on application html?
//     - url-based versioning? possibly in the filename, like foo.v123.js ...
//       although hash-based is also interesting..
//     - version.txt that is loaded on start and on SIGUSR1? i.e. it allows for
//       atomic deployments
//  - CDN?
//  - room(/hood?) state?
//  - journal files?

import http from 'http';
import fs from 'fs';
import path from 'path';
const __dirname = import.meta.dirname;

const PORT = parseInt(process.env.PORT || 8888, 10);

function log_request(req, status) {
	console.info(`${req.method} ${req.url} => ${status}`);
}

function serve500(req, error) {
	res.setHeader("Content-Type", "text/html");
	res.writeHead(500);
	res.end("500 Internal Server Error", "utf-8");
	console.error(error);
	log_request(req, 500);
	return;
}

const server = http.createServer((req, res) => {
	if (req.method !== "GET") {
		res.setHeader("Content-Type", "text/html");
		res.setHeader("Allow", "GET");
		res.writeHead(405);
		res.end("405 Method Not Allowed", "utf-8");
		return;
	}

	const fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);

	res.setHeader("Cache-Control", "no-cache");

	fs.stat(fp, (error, stat) => {
		if (error && error.code === 'ENOENT') {
			res.setHeader("Content-Type", "text/html");
			res.writeHead(404);
			res.end("404 Not Found", "utf-8");
			log_request(req, 404);
			return;
		} else if (error) {
			return serve500(req, error);
		}
		const etag = "m"+stat.mtime.getTime();
		if (etag === req.headers["if-none-match"]) {
			res.writeHead(304);
			res.end();
			log_request(req, 304);
			return;
		}
		const ext = path.extname(fp).toLowerCase();
		let mime = {
		".html"  : "text/html",
		".js"    : "text/javascript",
		".mjs"   : "text/javascript",
		".css"   : "text/css",
		".wasm"  : "application/wasm",
		".ttf"   : "font/ttf",
		".woff"  : "font/woff",
		".woff2" : "font/woff2",
		}[ext];
		if (!mime) mime = "application/octet-stream";
		const encoding = {"text":"utf-8"}[mime.split("/")[0]];
		fs.readFile(fp, (error, data) => {
			if (error) return serve500(req, error);
			if (path.basename(fp) === "index.html") {
				data = data.toString(encoding);
			}
			res.setHeader("ETag", etag);
			res.setHeader("Content-Type", mime);
			res.writeHead(200);
			res.end(data, encoding);
			log_request(req, 200);
		});
	});
});

// Start the server
server.listen(PORT, () => {
	console.info(`Serving at:\nhttp://localhost:${PORT}`);
});
