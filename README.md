# New Super Mario Bros. Wii — browser port

**Play:** https://teaserlua.github.io/nsmbw-web-port/

This website contains the user's existing browser port (WebAssembly, WebGL2,
sound and controller UI). It can read an extracted game partition from the
visitor's computer without uploading it. The extracted **Nintendo game disc**
files are not distributed in this repository or on the website.

### How to play

Open the Play link in a desktop version of **Chrome or Edge**. Click **Choose
game folder**, then select the extracted partition folder containing both
`sys/boot.bin`, `sys/fst.bin`, `sys/main.dol` and `files/` from your game copy.
The page reads small chunks locally through `FileReaderSync` in game workers.
The browser may reload itself once to activate the isolation headers required
for WebAssembly threads. The game starts after selecting the folder.

### Controls

WASD or arrow keys = move, Space = jump (Wii button 2), Shift = run / fire
(Wii button 1), E = shake, Enter = pause. Xbox / PlayStation controllers are
supported. See Settings for binding adjustments. DSU Remote needs the local
`serve.py` launcher because a static GitHub Pages site cannot bridge UDP.

### Development and hosting

The site is deployed from `web/` via `.github/workflows/pages.yml`.
The optional untracked `web/game-config.json` can specify an external asset
server if the game data is licensed for distribution. The server must allow
cross-origin `HEAD`, `GET Range` (HTTP 206), and expose `Content-Length` and
`Content-Range` to `https://teaserlua.github.io`.

Example configuration (not included in published site):

```json
{ "assetBase": "https://YOUR-AUTHORIZED-ASSET-SERVER/" }
```

For local use, run `py serve.py --game "C:\path\to\partition" --port 8081`
from the repository root. The game loads automatically from the local server.

This project is not affiliated with Nintendo. Nintendo owns New Super Mario
Bros. Wii and its original assets.
