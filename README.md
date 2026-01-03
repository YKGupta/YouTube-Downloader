# YouTube Downloader (local)

Minimal local UI for downloading YouTube videos/playlists via `yt-dlp`.

## Prereqs
- Node.js **18+**
- `yt-dlp` installed (recommended on Windows):
  - `winget install yt-dlp.yt-dlp`

## Install & run
From this repo:

```bash
npm install
npm install -g .
youtube
```

Open the URL printed in the terminal.

## Notes
- Downloads are written to a job folder under your OS **Downloads** directory and then served as links for the browser to save.
- If `yt-dlp` isn’t found, set `YTDLP_BIN` to the full path of `yt-dlp.exe`.


