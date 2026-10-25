"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const assets = new Map(
  [
    "index.html",
    "dashboard.css",
    "app-config.js",
    "plan-data.js",
    "board-model.js",
    "cloud-sync.js",
    "app.js",
    "sw.js",
  ].map((name) => [
    "/" + name,
    {
      body: fs.readFileSync(path.join(__dirname, name)),
      type: name.endsWith(".html")
        ? "text/html"
        : name.endsWith(".css")
          ? "text/css"
          : "text/javascript",
    },
  ]),
);
const server = http.createServer((req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch (e) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(req.method === "HEAD" ? undefined : "ok");
    return;
  }
  const file = assets.get(pathname === "/" ? "/index.html" : pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": file.type + "; charset=utf-8",
    "Content-Length": file.body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  res.end(req.method === "HEAD" ? undefined : file.body);
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log("Woodline server ready"),
);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
