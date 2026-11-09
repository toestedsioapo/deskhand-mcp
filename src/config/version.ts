import { readFileSync } from "node:fs";

// src/config/ and dist/config/ are both two levels below the package root.
const pkgUrl = new URL("../../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };

export const PACKAGE_VERSION: string = pkg.version;
