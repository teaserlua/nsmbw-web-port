# New Super Mario Bros. Wii — browser port

**Play:** https://teaserlua.github.io/nsmbw-web-port/

**Cloudflare R2 game data hosting:** [docs/CLOUDFLARE-R2.md](docs/CLOUDFLARE-R2.md)

This website contains the user's existing browser port (WebAssembly, WebGL2,
sound and controller UI). The game data is hosted on Cloudflare R2 and served
as individual virtual files with byte-range requests by a Cloudflare Worker.
The original extracted files and R2 packs are not committed to this Git repo.

### How to play

Open the Play link in a desktop version of **Chrome or Edge**. The game starts
automatically and reads its disc files from Cloudflare R2. The browser may
reload itself once to activate the isolation headers required for WebAssembly
threads. On first launch, downloading and preparing the game may take a little
time depending on network speed.

If you prefer your own extracted game partition, open
[local folder mode](https://teaserlua.github.io/nsmbw-web-port/?local=1), then
select the folder containing `sys/boot.bin`, `sys/fst.bin`, `sys/main.dol` and
`files/`. Local files are read directly using `FileReaderSync` and never
uploaded.

### Controls

WASD or arrow keys = move, Space = jump (Wii button 2), Shift = run / fire
(Wii button 1), E = shake, Enter = pause. Xbox / PlayStation controllers are
supported. See Settings for binding adjustments. DSU Remote needs the local
`serve.py` launcher because a static GitHub Pages site cannot bridge UDP.

### Development and hosting

The site is deployed from `web/` via `.github/workflows/pages.yml`.
The published `web/game-config.json` selects the Cloudflare Worker. The
remote server supports cross-origin `HEAD`, `GET Range` (HTTP 206), and exposes
`Content-Length` and `Content-Range` to `https://teaserlua.github.io`.

Current published configuration:

```json
{ "assetBase": "https://nsmbw-game-assets.jmhq20120212.workers.dev/" }
```

For local use, run `py serve.py --game "C:\path\to\partition" --port 8081`
from the repository root. The game loads automatically from the local server.

This project is not affiliated with Nintendo. Nintendo owns New Super Mario
Bros. Wii and its original assets.
