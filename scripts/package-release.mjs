#!/usr/bin/env node
// Modified 2026-09-27: include site policy and attribution in extension packages.
import { zipFiles } from "./zip.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "dist");
const extensionDir = resolve(repoRoot, "extension");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const baseName = `${packageJson.name}-extension-v${packageJson.version}`;
const zipPath = resolve(distDir, `${baseName}.zip`);
const checksumPath = resolve(distDir, `${baseName}.sha256`);
const manifestPath = resolve(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const serverSource = readFileSync(resolve(repoRoot, "server/server.mjs"), "utf8");
const loaderSource = readFileSync(resolve(extensionDir, "bridge-main.js"), "utf8");

const fail = (message, extra = {}) => {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
};

if (manifest.version !== packageJson.version) {
  fail("Extension manifest version must match package.json version.", {
    packageVersion: packageJson.version,
    extensionVersion: manifest.version
  });
}
if (!serverSource.includes(`const PRODUCT_VERSION = "${packageJson.version}"`)) {
  fail("Server PRODUCT_VERSION must match package.json version.", { packageVersion: packageJson.version });
}
if (!loaderSource.includes(`const LOADER_VERSION = "${packageJson.version}"`)) {
  fail("Extension loader version must match package.json version.", { packageVersion: packageJson.version });
}

mkdirSync(distDir, { recursive: true });
if (existsSync(zipPath)) rmSync(zipPath);
if (existsSync(checksumPath)) rmSync(checksumPath);

writeFileSync(zipPath,zipFiles(["manifest.json", "site-policy.js", "bridge-main.js", "LICENSE", "UPSTREAM.md"].map(name=>({name,bytes:readFileSync(resolve(extensionDir,name))}))));

const bytes = readFileSync(zipPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(checksumPath, `${sha256}  ${baseName}.zip\n`, "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      version: packageJson.version,
      artifacts: {
        extensionZip: zipPath,
        extensionSha256: checksumPath
      },
      githubReleaseAssets: [`dist/${baseName}.zip`, `dist/${baseName}.sha256`],
      npmPackage: `${packageJson.name}@${packageJson.version}`
    },
    null,
    2
  )
);
