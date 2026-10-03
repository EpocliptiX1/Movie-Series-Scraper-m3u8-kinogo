// Standalone kinogo -> cinemar resolver + player test. Run on a HOME connection (localhost):
//   npm install && npm start      ->  http://localhost:4747
//
// Nothing here touches the AniKino backend, its databases or its env. Ported from the
// kinogo.mu/cinemar.cc code that lived in Backend/server.js before commit 184b94f0 (git show
// 184b94f0^:Backend/server.js), trimmed to the essentials:
//   1. kinogo lightsearch (AJAX, not Cloudflare-challenged)      -> movie page URL
//   2. movie page (Cloudflare-challenged)                        -> cinemar.cc embed URL
//   3. embed page "file" field (custom-obfuscated)               -> tracks / season-episode tree
//   4. POST cinemar /api/playlist/load with the track's data     -> real stream URL (m3u8)
//   5. /proxy                                                    -> adds the Referer cinemar wants
//
// Optional env: KINOGO_PROXY=http://user:pass@host:port  (only used for steps 1-2)
const http = require('http');
const { URL } = require('url');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = Number(process.env.PORT) || 4747;
const PROXY_URL = process.env.KINOGO_PROXY || null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOSTS = ['user.kinogo.mu', 'kinogo.ec', 'kinogo.biz']; // verified identical mirrors
const CONFIDENCE = 90;
const fs = require('fs');
const path = require('path');

let _got = null;
const getGot = () => (_got ||= import('got-scraping').then(m => m.gotScraping));

// ---------- cinemar "file" decoding (reverse-engineered from cinemar's own player.js) ----------
function decodeCinemarFile(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('#2')) throw new Error('Unexpected cinemar file format');
    const s = raw.substr(2);
    const delim = String.fromCharCode(parseInt(s.substr(0, 2), 10));
    const chunks = s.substr(2).split(delim).map(chunk => {
        const t = parseInt(chunk.slice(-1), 10);
        return chunk.length > 32 ? chunk.substr(2 * t, chunk.length - 3 * t - 1) + chunk.substr(0, t) : chunk;
    });
    let val = chunks.join('');
    if (val.length % 4) val += '='.repeat(4 - (val.length % 4));
    return JSON.parse(Buffer.from(val, 'base64').toString('utf8'));
}

// ---------- title matching (whole-word, so "Cold" never matches "Coldplay") ----------
const norm = s => String(s || '').toLowerCase().replace(/\(\d{4}\)/g, '').replace(/[^a-zа-яё0-9]+/gi, ' ').trim().replace(/\s+/g, ' ');
function score(query, titles) {
    const nq = norm(query);
    if (!nq) return -1;
    let best = -1;
    for (const t of titles) {
        const nc = norm(t);
        if (!nc) continue;
        if (nc === nq) return 100;
        const q = nq.split(' '), c = nc.split(' ');
        if (c.length >= q.length && q.every((w, i) => c[i] === w)) best = Math.max(best, 90);
    }
    return best;
}

// ---------- step 1: lightsearch ----------
async function lightsearch(query, log) {
    const got = await getGot();
    let lastErr;
    for (const host of HOSTS) {
        try {
            const r = await got.post(`https://${host}/engine/ajax/controller.php?mod=lightsearch`, {
                form: { q: query, method: '', user_hash: '', skin: 'Kinogo' },
                headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `https://${host}/` },
                timeout: { request: 20000 },
                ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {})
            });
            const data = JSON.parse(r.body); // throws on a challenge/HTML page
            log(`lightsearch ok via ${host}`);
            return { host, html: data?.html || '' };
        } catch (e) { lastErr = e; log(`lightsearch ${host} failed: ${e.message}`); }
    }
    throw lastErr || new Error('all kinogo mirrors failed');
}

async function findMoviePage(titles, log) {
    let best = null;
    for (const q of titles) {
        const { host, html } = await lightsearch(q, log);
        const $ = cheerio.load(html);
        $('a.lightsearch__item').each((i, el) => {
            const href = $(el).attr('href') || '';
            if (!/^\/\d+-{1,2}[^/]+\.html$/.test(href)) return;
            const primary = $(el).find('.lightsearch__itemTitle').first().text().trim();
            const alt = $(el).find('.lightsearch__itemInfo > div').first().text().trim();
            const sc = score(q, [primary, alt]);
            if (!best || sc > best.score) best = { href, host, score: sc, matched: primary || alt };
        });
        log(`search "${q}" -> best ${best ? `"${best.matched}" (${best.score})` : 'none'}`);
        if (best && best.score >= CONFIDENCE) break;
    }
    if (!best || best.score < CONFIDENCE) throw new Error(`no confident kinogo match for ${titles.map(t => `"${t}"`).join(' / ')}`);
    return { url: `https://${best.host}${best.href}`, matched: best.matched };
}

// ---------- step 2: movie page -> cinemar embed (Cloudflare) ----------
const EMBED_RE = /(?:data-src|src)="(https:\/\/cinemar\.cc\/embed\/[^"]+)"/;

async function embedViaGot(pageUrl, log) {
    const got = await getGot();
    const r = await got.get(pageUrl, { timeout: { request: 25000 }, ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}) });
    const m = r.body.match(EMBED_RE);
    log(m ? 'embed found via plain fetch' : 'plain fetch: no embed (likely Cloudflare interstitial)');
    return m ? m[1] : null;
}

// Cloudflare fallback WITHOUT a browser: CapSolver's AntiCloudflareTask solves the challenge for a
// sticky proxy session and hands back a cf_clearance cookie + the UA it was solved with, which
// got-scraping then reuses for a normal fetch (the approach the main backend used before
// Puppeteer). Needs env: CAPSOLVER_API_KEY and CAPSOLVER_PROXY=http://user:pass@host:port
// (the proxy MUST be the same one used for the solve and the follow-up fetch). Returns null if
// not configured / on any failure - the caller reports a clear error instead.
async function embedViaCapSolver(pageUrl, log) {
    const key = process.env.CAPSOLVER_API_KEY, proxy = process.env.CAPSOLVER_PROXY;
    if (!key || !proxy) { log('plain fetch was blocked and CAPSOLVER_API_KEY / CAPSOLVER_PROXY are not set - no browserless fallback available'); return null; }
    try {
        const pu = new URL(proxy);
        const proxyString = `${pu.hostname}:${pu.port}:${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`;
        const created = (await axios.post('https://api.capsolver.com/createTask',
            { clientKey: key, task: { type: 'AntiCloudflareTask', websiteURL: pageUrl, proxy: proxyString } }, { timeout: 15000 })).data;
        if (!created.taskId) { log('capsolver createTask failed: ' + (created.errorDescription || JSON.stringify(created))); return null; }
        let solution = null;
        for (let i = 0; i < 20 && !solution; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const res = (await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId: created.taskId }, { timeout: 15000 })).data;
            if (res.status === 'ready') solution = res.solution;
            else if (res.status === 'failed') { log('capsolver solve failed: ' + res.errorDescription); return null; }
        }
        if (!solution) { log('capsolver timed out'); return null; }
        const got = await getGot();
        const r = await got.get(pageUrl, {
            headers: { 'User-Agent': solution.userAgent, Cookie: `cf_clearance=${solution.cookies.cf_clearance}` },
            proxyUrl: proxy, timeout: { request: 25000 }
        });
        const m = r.body.match(EMBED_RE);
        log(m ? 'embed found via capsolver' : 'capsolver solved but no embed in the page');
        return m ? m[1] : null;
    } catch (e) { log('capsolver error: ' + e.message); return null; }
}

// ---------- steps 3-4: embed -> tracks -> stream ----------
async function loadEmbedTree(embedUrl, pageUrl) {
    const r = await axios.get(embedUrl, { headers: { 'User-Agent': UA, Referer: pageUrl }, timeout: 20000 });
    const m = String(r.data).match(/"file":\s*"([^"]+)"/);
    if (!m) throw new Error('cinemar returned no player file data');
    const tree = decodeCinemarFile(m[1]);
    if (!Array.isArray(tree) || !tree.length) throw new Error('cinemar playlist is empty');
    return tree;
}

async function trackToStream(track, embedUrl) {
    if (!track?.data) throw new Error('track has no data payload');
    // track.file is always the literal placeholder "#" - the real URL only comes from this POST.
    const r = await axios.post('https://cinemar.cc/api/playlist/load', JSON.stringify(track.data), {
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Referer: embedUrl }, timeout: 20000
    });
    if (!r.data?.file) throw new Error('playlist/load returned no file URL');
    return r.data.file;
}

const stripTags = s => String(s || '').replace(/<[^>]+>/g, '').trim();

async function resolve({ title, type, season, episode }, log) {
    const titles = [title].filter(Boolean);
    const page = await findMoviePage(titles, log);
    log(`movie page: ${page.url}`);
    const embedUrl = (await embedViaGot(page.url, log)) || (await embedViaCapSolver(page.url, log));
    if (!embedUrl) throw new Error('no cinemar embed found on the kinogo page (Cloudflare block - see log - or the title has no player)');
    log(`embed: ${embedUrl}`);
    const tree = await loadEmbedTree(embedUrl, page.url);

    let track, label;
    if (type === 'series') {
        const s = tree[season - 1];
        if (!s || !Array.isArray(s.folder)) throw new Error(`season ${season} not found (kinogo lists ${tree.length} season(s))`);
        const e = s.folder[episode - 1];
        if (!e || !Array.isArray(e.folder) || !e.folder.length) throw new Error(`episode ${episode} not found in season ${season} (${s.folder.length} episode(s))`);
        track = e.folder[0]; // first entry = default Russian track
        label = `${stripTags(s.title)} / ${stripTags(e.title)} / ${stripTags(track.title)}`;
    } else {
        track = tree[0];
        label = stripTags(track.title);
    }
    log(`track: ${label}`);
    const streamUrl = await trackToStream(track, embedUrl);
    log(`stream: ${streamUrl}`);
    return { matched: page.matched, pageUrl: page.url, label, streamUrl, referer: 'https://cinemar.cc/', seasons: type === 'series' ? tree.length : undefined };
}

// ---------- HLS proxy (adds the Referer cinemar's CDN checks; rewrites playlists) ----------
const proxied = (u, r) => `/proxy?u=${encodeURIComponent(u)}&r=${encodeURIComponent(r)}`;
async function handleProxy(req, res, q) {
    const target = q.get('u'), referer = q.get('r') || 'https://cinemar.cc/';
    if (!/^https?:\/\//i.test(target || '')) { res.writeHead(400); return res.end('bad url'); }
    try {
        const headers = { 'User-Agent': UA, Referer: referer, Origin: new URL(referer).origin };
        if (req.headers.range) headers.Range = req.headers.range;
        const up = await axios.get(target, { headers, responseType: 'stream', timeout: 30000, validateStatus: () => true, maxRedirects: 5 });
        const ct = String(up.headers['content-type'] || '');
        const isPlaylist = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target);
        if (isPlaylist) {
            const chunks = []; for await (const c of up.data) chunks.push(c);
            const body = Buffer.concat(chunks).toString('utf8');
            const base = up.request?.res?.responseUrl || target;
            const out = body.split(/\r?\n/).map(line => {
                if (!line.trim()) return line;
                if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(new URL(u, base).href, referer)}"`);
                return proxied(new URL(line.trim(), base).href, referer);
            }).join('\n');
            res.writeHead(up.status, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
            return res.end(out);
        }
        const h = { 'Content-Type': ct || 'application/octet-stream' };
        for (const k of ['content-length', 'content-range', 'accept-ranges']) if (up.headers[k]) h[k] = up.headers[k];
        res.writeHead(up.status, h);
        up.data.pipe(res);
    } catch (e) { res.writeHead(502); res.end('proxy failed: ' + e.message); }
}

// ---------- server ----------
http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/api/resolve') {
        const logs = [];
        const log = m => { logs.push(m); console.log('[kinogo]', m); };
        try {
            const p = {
                title: (u.searchParams.get('title') || '').trim(),
                type: u.searchParams.get('type') === 'series' ? 'series' : 'movie',
                season: Math.max(1, parseInt(u.searchParams.get('season'), 10) || 1),
                episode: Math.max(1, parseInt(u.searchParams.get('episode'), 10) || 1)
            };
            if (!p.title) throw new Error('title required');
            const r = await resolve(p, log);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...r, stream: proxied(r.streamUrl, r.referer), logs }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message, logs }));
        }
        return;
    }
    if (u.pathname === '/proxy') return handleProxy(req, res, u.searchParams);
    if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`kinogo-standalone on http://localhost:${PORT}${PROXY_URL ? ' (proxy for steps 1-2)' : ''}`));
