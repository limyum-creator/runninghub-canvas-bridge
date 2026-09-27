// Added 2026-09-27: bundle pinned synchronization dependencies locally.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
await build({
  stdin: {
    contents: `export * as Y from 'yjs';
      export { WebsocketProvider } from 'y-websocket';
      export * as decoding from 'lib0/decoding';
      export { messageYjsSyncStep1 } from 'y-protocols/sync';`,
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome120",
  legalComments: "linked",
  outfile: "server/vendor/yjs.js"
});
const notices = await Promise.all(["yjs", "y-websocket", "y-protocols", "lib0", "isomorphic.js"].map(async (name) => {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
  return `${name} ${pkg.version}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`;
}));
await writeFile("server/vendor/THIRD_PARTY_LICENSES.txt", notices.join("\n\n----------------------------------------\n\n"));
const upload = await build({
  stdin: { contents: "export { S3 } from '@aws-sdk/client-s3'; export { Upload } from '@aws-sdk/lib-storage';", resolveDir: process.cwd() },
  bundle: true, platform: "browser", format: "esm", target: "chrome120", legalComments: "linked",
  outfile: "server/vendor/upload.js", metafile: true
});
const packages = new Set(Object.keys(upload.metafile.inputs).map(path => path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
const uploadNotices = [];
for (const name of packages) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
  let license;
  for (const file of ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE-MIT.txt", "COPYING"]) {
    try { license = await readFile(`node_modules/${name}/${file}`, "utf8"); break; } catch {}
  }
  if (!license) throw new Error(`Missing bundled license: ${name}`);
  uploadNotices.push(`${name} ${pkg.version}\n${license}`);
}
await writeFile("server/vendor/UPLOAD_LICENSES.txt", uploadNotices.join("\n\n----------------------------------------\n\n"));
