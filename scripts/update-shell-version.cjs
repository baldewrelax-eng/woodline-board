"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const assets = [
  "dashboard.css",
  "app-config.js",
  "plan-data.js",
  "board-model.js",
  "cloud-sync.js",
  "app.js",
];
// A first navigation after removing an old worker must also bypass the
// browser's HTTP cache. Version URLs without duplicating files on Pages.
const assetHash = crypto.createHash("sha256");
for (const name of assets) {
  assetHash.update(name);
  assetHash.update(fs.readFileSync(path.join(root, name)));
}
const assetVersion = assetHash.digest("hex").slice(0, 16);
const indexFile = path.join(root, "index.html");
let html = fs.readFileSync(indexFile, "utf8");
for (const name of assets) {
  const pattern = new RegExp('((?:src|href)="' + name.replace(/\./g, "\\.") + ')(?:\\?v=[a-f0-9]+)?"', "g");
  if (!pattern.test(html)) throw Error("Missing app-shell asset: " + name);
  html = html.replace(pattern, '$1?v=' + assetVersion + '"');
}
fs.writeFileSync(indexFile, html);
const hash = crypto.createHash("sha256");
for (const name of ["index.html", ...assets]) {
  hash.update(name);
  hash.update(fs.readFileSync(path.join(root, name)));
}
const release = "woodline-v2-" + hash.digest("hex").slice(0, 16),
  file = path.join(root, "sw.js");
const old = fs.readFileSync(file, "utf8");
const lines = old.split("\n");
const index = lines.findIndex((line) => line.startsWith("const RELEASE = "));
if (index < 0) throw Error("Service worker release marker missing");
lines[index] = "const RELEASE = '" + release + "';";
fs.writeFileSync(file, lines.join("\n"));
console.log("App shell release updated:", release);
