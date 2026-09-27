# Release guide

Source and releases: https://github.com/limyum-creator/runninghub-canvas-bridge

The product has two parts: the local bridge/MCP package and the Chrome extension. Both must use the same product version. Node.js 20.19+, ffmpeg/ffprobe and a logged-in Chrome profile are required. Lumen is optional and only needed for its archive tools.

## Install from source

```sh
git clone https://github.com/limyum-creator/runninghub-canvas-bridge.git
cd runninghub-canvas-bridge
npm ci
npm run build
RH_BRIDGE_ALLOW_GENERATION=1 npm start
```

Load `extension/` as an unpacked Chrome extension. Register `server/mcp.mjs` with the absolute Node executable in the MCP client, then call `rh_status`. Full instructions are in [AGENT_INSTALL.md](../AGENT_INSTALL.md).

## Install a release package

Download the `.tgz` from the matching GitHub Release:

```sh
npm install -g ./runninghub-canvas-bridge-0.4.0.tgz
runninghub-canvas-bridge setup
```

Load the `extension.unpackedPath` returned by setup in Chrome, or extract the matching extension ZIP and load that directory. The ZIP requires the local bridge; it is not a standalone cloud service. Register the installed `runninghub-canvas-mcp` command with your MCP client. No npm registry publication is implied by the `.tgz` package.

## Build and publish

1. Keep package, extension, loader, server and MCP versions aligned.
2. Run `npm ci`, `npm run check`, `npm test` and `npm run build`.
3. Run `npm run release:package` and `npm pack --pack-destination dist`.
4. Inspect the staged source and package inventory. Exclude private configuration, canvas payloads, media, credentials and `local-private/`.
5. Push the reviewed source to this repository. Push a matching `v*` tag to run the release workflow, or attach the verified artifacts to a release manually. Use one publication path per version.

Release assets:

- `runninghub-canvas-bridge-<version>.tgz`
- `runninghub-canvas-bridge-extension-v<version>.zip`
- `runninghub-canvas-bridge-extension-v<version>.sha256`

The tag workflow installs dependencies and ffmpeg, runs tests, builds the browser dependencies and packages the artifacts. It publishes a GitHub Release; it does not publish to npm.

Bridge protocol version is `1`. Refresh canvas tabs after updating the extension and bridge. Keep the private archive directory across updates so pending imports can resume with their original identities.
