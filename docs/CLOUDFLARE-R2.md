# NSMBW Cloudflare R2 hosting

The extracted New Super Mario Bros. Wii partition contains **1,194 files**
(about **336 MiB**). A dedicated R2 bucket named `nsmbw-web-port` is configured
in the same Cloudflare account used by the Rabbids project. The bucket is
private. The Worker lives at:

`https://nsmbw-game-assets.jmhq20120212.workers.dev/`

The Worker is configured with `PUBLIC_GAME_DATA: "false"`. This protects all
`/game/` URLs, returning HTTP 403 while the site uses its local folder picker.
Its `/health` route and synthetic `/fixtures/` routes are available for network
and HTTP range tests; these contain no Nintendo assets.

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

## Release only with distribution authorization

The original game files are Nintendo's copyrighted content. Confirm that
there is permission to distribute the entire extracted game, including code,
music and textures, **before** changing the Worker setting. A personal copy
of the disc does not itself confer redistribution rights.

Once permission is established and private object integrity verified:

1. In `cloudflare/nsmbw-assets/wrangler.jsonc`, change `PUBLIC_GAME_DATA` to
   `"true"`, then deploy with Wrangler.
2. Confirm `HEAD /game/sys/boot.bin` returns `200` and an exposed
   `Content-Length`, and `GET` with `Range: bytes=0-31` returns `206` and a
   matching `Content-Range`, from the Pages origin.
3. Add `web/game-config.json` (normally Git-ignored):

   ```json
   { "assetBase": "https://nsmbw-game-assets.jmhq20120212.workers.dev/" }
   ```

4. Remove the `web/game-config.json` ignore entry and commit the non-secret
   configuration so GitHub Pages can automatically load the hosted game.
5. Test a complete boot and controls from the published Pages URL.

Do not enable the Worker or commit the automatic remote configuration
before release authorization. With no `game-config.json`, the published
site continues to support selecting extracted local game files.
