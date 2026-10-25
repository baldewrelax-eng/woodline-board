"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const hash = crypto.createHash("sha256");
for (const name of [
  "index.html",
  "dashboard.css",
  "app-config.js",
  "plan-data.js",
  "board-model.js",
  "cloud-sync.js",
  "app.js",
]) {
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
