# Kinogo movie / series loader

Small localhost tool. You type a title (and season/episode for series), it finds the title on
kinogo, pulls the video stream and plays it in a bare HTML page. No framework, no database.

## Run

```
npm install
npm start
```

Open http://localhost:4747. Needs Node 18 or newer.

## Dependencies

- axios - plain HTTP requests (embed page, stream lookup, video proxy)
- cheerio - parses kinogo's search results
- got-scraping - kinogo requests with a browser-like TLS fingerprint (needed to get past Cloudflare on a home connection)
- hls.js - loaded from a CDN in `index.html`, nothing to install

No Puppeteer, no browser.

## How it works

1. Search: posts the title to kinogo's search endpoint (tries `user.kinogo.mu`, then `kinogo.ec`, then `kinogo.biz`). Only whole-word title matches are accepted, so "Cold" will not match "Coldplay".
2. Page: fetches the matched kinogo page and reads the cinemar.cc embed URL out of it.
3. Playlist: the embed page holds a custom-obfuscated playlist (movie tracks, or a season/episode tree for series). The server decodes it.
4. Stream: the chosen track is posted to cinemar's playlist endpoint, which returns the real HLS stream URL. For series, season and episode are 1-based positions in kinogo's tree. The first track is the default Russian one.
5. Playback: the stream goes through a small local proxy (`/proxy`) that adds the Referer cinemar's CDN requires and rewrites the playlist so hls.js loads everything through it.

## Limits

- Run it from a home connection. Cloudflare blocks datacenter IPs (VPS, Webshare-type proxies) on the movie page and serves a challenge instead of the player. Search still works there, the page fetch does not.
- If you must run it behind a blocked IP, set `CAPSOLVER_API_KEY` and `CAPSOLVER_PROXY=http://user:pass@host:port` and it will try to solve the challenge through CapSolver. Untested, and commercial proxy IPs have been seen to lose the player even after solving.
- `KINOGO_PROXY=http://user:pass@host:port` routes only the search and page fetch through a proxy.
- Use the exact title as kinogo lists it. Russian or original titles match best.
- `PORT` env var changes the port (default 4747). The server only listens on 127.0.0.1.
