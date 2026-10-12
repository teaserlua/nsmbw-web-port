# NSMBW Cloudflare R2 hosting

The extracted New Super Mario Bros. Wii partition contains **1,194 files**
(about **336 MiB**). A dedicated R2 bucket named `nsmbw-web-port` is configured
in the same Cloudflare account used by the Rabbids project. The bucket is
private. The Worker lives at:

`https://nsmbw-game-assets.jmhq20120212.workers.dev/`

The Worker is configured with `PUBLIC_GAME_DATA: "true"` following the owner's
confirmation of distribution authorization. Requests for `/game/` URLs now
return virtual files from the packed data. Its `/health` route and synthetic
`/fixtures/` routes remain available for network and HTTP range tests.

**Private upload verified:** all six pack objects and `manifest.json` were
uploaded to `nsmbw-web-port` on October 12, 2026. All seven were downloaded
again and checked against the local originals using SHA-256; every check
matched. The private uploader also confirmed that an immediate second run
skipped all seven completed objects.

## Why files are packed

Uploading 1,194 individual game assets would require many remote operations.
`tools/pack-partition.mjs` produces about six pack objects (up to 64 MiB each)
plus a JSON manifest. Each original game path maps to a pack file, its byte
offset, length and SHA-256 checksum. The Cloudflare Worker serves an ordinary
HTTP 200 HEAD or 206 GET Range response for each virtual game path, so the
original browser runtime does not need to understand pack files.

The packer writes no files unless given `--execute`. Packed files remain under
the Git-ignored `generated/` directory, and no extracted game files enter Git.

```powershell
node tools/pack-partition.mjs --source "C:\Users\owner\Documents\nsmbw files\partition\partition" --output generated/r2
node tools/pack-partition.mjs --source "C:\Users\owner\Documents\nsmbw files\partition\partition" --output generated/r2 --execute
```

For an existing output directory, use a new destination instead of overwriting.

## Upload to the private bucket

Use Wrangler OAuth, already connected on the user's PC. The uploader verifies
local pack sizes and SHA-256 hashes, retries transient failures, and records
completed objects in a private state file in the user profile. It uploads the
manifest **last** after the pack objects. A private upload does not change
the Worker's public access setting.

```powershell
npm install --no-save --no-package-lock wrangler
node tools/upload-packed.mjs --source generated/r2 --bucket nsmbw-web-port
node tools/upload-packed.mjs --source generated/r2 --bucket nsmbw-web-port --execute --private-backup
```

To apply the CORS policy and redeploy the private Worker:

```powershell
npm exec --yes --package=wrangler -- wrangler r2 bucket cors set nsmbw-web-port --file tools/r2-cors.json
npm exec --yes --package=wrangler -- wrangler deploy --config cloudflare/nsmbw-assets/wrangler.jsonc
```

## Published game delivery

The owner confirmed authorization to distribute the extracted game files. To
verify the public deployment:

1. Confirm `HEAD /game/sys/boot.bin` returns `200` and an exposed
   `Content-Length`, and `GET` with `Range: bytes=0-31` returns `206` and a
   matching `Content-Range`, from the Pages origin.
2. Confirm the published `web/game-config.json` contains:

   ```json
   { "assetBase": "https://nsmbw-game-assets.jmhq20120212.workers.dev/" }
   ```

3. Test a complete boot and controls from the published Pages URL with no local
   game folder. The optional folder picker continues to support a local copy.

**Deployment checks (October 12, 2026):** the public Worker returned correct
200 HEAD, 206 byte ranges and 416 invalid-range responses. Forty-two virtual
files were sampled and matched local packed bytes. A Chrome boot using only
GitHub Pages and remote R2 reached nine game threads and 193 rendered frames,
displaying the Wii safety screen; no local game directory was selected. The
initial boot reached that screen after roughly 45 seconds in the test. Full
level gameplay and controller input have not yet been tested on this deployment.

To make the files private again, set `PUBLIC_GAME_DATA` to `"false"` in
`cloudflare/nsmbw-assets/wrangler.jsonc` and redeploy with Wrangler; also
remove `web/game-config.json` from the published site.
