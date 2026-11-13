import { createRequire } from "node:module";
import { rebuild } from "@electron/rebuild";

const require = createRequire(import.meta.url);
await rebuild({
  buildPath: process.cwd(),
  electronVersion: require("electron/package.json").version,
  arch: "arm64",
  force: true,
  onlyModules: ["better-sqlite3"],
});
