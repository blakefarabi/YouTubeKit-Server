/**
 * youtubekit-server — remote extraction for fallback.trending.fm
 *
 * Rewritten 2026-08-18. Two changes from the previous version:
 *
 *   1. Extraction runs SERVER-SIDE by default instead of delegating every HTTP
 *      call back to the app over the WebSocket. The old design existed because
 *      YouTubeKit upstream assumes stream URLs are bound to the requesting IP.
 *      They are not: a URL signed with `ip=<my address>` (with `ip` present in
 *      `sparams`) was fetched from unrelated infrastructure and served bytes.
 *      Verified 2026-08-18. Delegation is kept as a FALLBACK, because device IPs
 *      are residential and get bot-checked far less than datacenter IPs.
 *
 *   2. `visitorData` is now sent. Without it ANDROID_VR returns
 *      LOGIN_REQUIRED / "Sign in to confirm you're not a bot" on most videos —
 *      measured 3 of 4. The previous "retry each client twice, LOGIN_REQUIRED is
 *      transient" workaround was treating a deterministic missing-parameter bug
 *      as flakiness.
 *
 * Wire protocol is UNCHANGED, so builds already on the App Store work as-is.
 * RemoteYouTubeClient.swift loops on `task.receive()` and returns the moment it
 * sees a `result` message — it does not require any `urlRequest` first. So the
 * happy path is now a single message and zero app round trips.
 *
 *     server -> app : {"type":"result","content":[RemoteStream,...]}
 *
 * Delegated mode (only when server-side extraction comes back empty) still uses:
 *     server -> app : {"type":"urlRequest","content":{id,url,method,body(base64),
 *                       headers,allow_redirects,apply_cookies_on_redirect,
 *                       save_intermediate_responses}}
 *     app -> server : {"id","url","data"(base64),"status_code","headers"}
 *
 * RemoteStream keys are snake_case (the app decodes with .convertFromSnakeCase):
 *   url,itag,ext,video_codec,audio_codec,average_bitrate,audio_bitrate,
 *   video_bitrate,filesize
 *
 * ── On formats ──────────────────────────────────────────────────────────────
 * Combined video+audio is NOT gone — it is per-client. Measured 2026-08-18 over
 * 6 videos, probing every URL with a range request:
 *
 *   client              muxed itag 18   adaptive   HLS
 *   ANDROID (no params) 6/6  HTTP 206   none       no
 *   ANDROID_VR          1/6  (403s)     yes        no
 *   IOS                 not offered     yes        1/6
 *   VISIONOS            not offered     yes        6/6
 *   tv / tv_simply / web_safari / mweb / *_MUSIC / *_UNPLUGGED: nothing usable
 *
 * ANDROID's itag 18 is a genuine muxed MP4 — ffprobe confirms h264 640x360 +
 * AAC. VISIONOS returns an HLS master playlist with pre-merged video+audio
 * variants from 144p to 4K (avc1 + mp4a), which AVPlayer plays natively.
 *
 * So this server returns, in priority order:
 *   itag 18  — ANDROID's REAL muxed MP4 when available. 360p, but it is genuine
 *              video+audio in one URL, it is a plain MP4, and it therefore works
 *              through the app's KTVHTTPCache byte-range proxy. This is what
 *              installed App Store builds get.
 *   itag 18  — (fallback) the audio-only 140 URL under an itag 18 label, if
 *              ANDROID gave us nothing. Sound beats silence.
 *   140 + video-only adaptive — feeds getPlayerItem's AVMutableComposition.
 *   HLS      — ONLY when the caller passes ?hls=1. Installed builds must never
 *              receive it: PlayerViewController.m:3217 sends every url_18
 *              through KTVHTTPCache, which is an MP4 byte-range cache and does
 *              not understand m3u8. A future build that bypasses the proxy for
 *              m3u8 can opt in and get adaptive 1080p/4K with audio.
 */

// ── Clients ─────────────────────────────────────────────────────────────────
// MUXED: the only client still handing out a working combined video+audio URL.
// Sent WITHOUT playerParams — the app's local InnerTube.swift sends
// `params: "CgIQBg=="` for this client, which returns ERROR on 7 of 8 videos,
// while the same client with no params is 8/8. Version tracks yt-dlp master.
const CLIENT_MUXED = {
  name: "ANDROID",
  id: "3",
  ua: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
  ctx: {
    clientName: "ANDROID",
    clientVersion: "21.26.364",
    androidSdkVersion: 30,
    osName: "Android",
    osVersion: "11",
    hl: "en",
  },
};

// ADAPTIVE + HLS. VISIONOS first: it is the only client returning an HLS master
// playlist reliably (6/6 vs IOS 1/6) AND it carries a full adaptive set
// (itag 140 plus ~20 video-only), so one call covers everything. It needs
// visitorData — without it the response comes back with no streamingData.
// IOS and ANDROID_VR are backups for the day VISIONOS stops answering.
const CLIENTS_ADAPTIVE = [
  {
    name: "VISIONOS",
    id: "101",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    ctx: {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471",
      hl: "en",
    },
  },
  {
    name: "IOS",
    id: "5",
    ua: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    ctx: {
      clientName: "IOS",
      clientVersion: "21.26.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      hl: "en",
    },
  },
  {
    name: "ANDROID_VR",
    id: "28",
    ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    ctx: {
      clientName: "ANDROID_VR",
      clientVersion: "1.65.10",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      hl: "en",
    },
  },
];

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// Progressive/muxed itags — combined video+audio in a single URL.
const MUXED_ITAGS = new Set([5, 6, 17, 18, 22, 34, 35, 36, 37, 38, 43, 44, 45, 46, 59, 78]);

// ── Small helpers ───────────────────────────────────────────────────────────
const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
const b64decodeToText = (b64) => decodeURIComponent(escape(atob(b64)));

function extFor(mime) {
  if (!mime) return "mp4";
  if (mime.includes("audio/mp4")) return "m4a";
  if (mime.includes("audio/webm")) return "webm";
  if (mime.includes("video/webm")) return "webm";
  return "mp4";
}

function codecOf(mime) {
  const m = /codecs="([^",]+)/.exec(mime || "");
  return m ? m[1] : null;
}

// ── Auth ────────────────────────────────────────────────────────────────────
// A logged-in cookie materially reduces "Sign in to confirm you're not a bot",
// which matters more now that requests originate from datacenter IPs. Optional:
// everything below works without one, just less reliably.
async function sha1Hex(input) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authHeaders(cookie) {
  if (!cookie) return {};
  const origin = "https://www.youtube.com";
  const get = (name) => (new RegExp(name + "=([^;]+)").exec(cookie) || [])[1];
  const sapisid = get("SAPISID") || get("__Secure-3PAPISID");
  if (!sapisid) return { Cookie: cookie, Origin: origin };
  const p1 = get("__Secure-1PAPISID") || sapisid;
  const p3 = get("__Secure-3PAPISID") || sapisid;
  const ts = Math.floor(Date.now() / 1000);
  // youtube.com sends all three; some endpoints only honour the 1P/3P variants.
  const auth = [
    `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${origin}`)}`,
    `SAPISID1PHASH ${ts}_${await sha1Hex(`${ts} ${p1} ${origin}`)}`,
    `SAPISID3PHASH ${ts}_${await sha1Hex(`${ts} ${p3} ${origin}`)}`,
  ].join(" ");
  return { Cookie: cookie, Origin: origin, "X-Goog-AuthUser": "0", Authorization: auth };
}

// ── visitorData ─────────────────────────────────────────────────────────────
// Cached for the life of the isolate (6h ceiling). Only fetched lazily, when a
// client that actually needs it is reached — IOS usually answers first and
// doesn't, so most requests never pay for this.
let _visitorData = null;
let _visitorDataAt = 0;

async function getVisitorData(doFetch) {
  const now = Date.now();
  if (_visitorData && now - _visitorDataAt < 6 * 60 * 60 * 1000) return _visitorData;
  try {
    const res = await doFetch("visitor", "https://www.youtube.com/", "GET", {
      "User-Agent": BROWSER_UA,
      "Accept-Language": "en-US,en;q=0.9",
    });
    const m = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(res.text);
    if (m) {
      _visitorData = m[1];
      _visitorDataAt = now;
    }
  } catch (_) {
    // Non-fatal: clients that want it will just do without.
  }
  return _visitorData;
}

// ── Format parsing ──────────────────────────────────────────────────────────
// Splits one player response into the three things we care about, without
// deciding anything. buildResult() does the choosing.
function splitFormats(streamingData) {
  const adaptive = [];
  const muxed = [];

  for (const f of [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])]) {
    if (!f.url) continue; // ciphered / SABR — unusable without a solver
    const mime = f.mimeType || "";
    const isAudioOnly = mime.startsWith("audio/");
    const codecs = codecOf(mime); // e.g. "avc1.42001E, mp4a.40.2" for muxed
    const isMuxed = MUXED_ITAGS.has(f.itag);

    const stream = {
      url: f.url,
      itag: f.itag,
      ext: extFor(mime),
      video_codec: isAudioOnly ? null : (isMuxed ? (codecs || "").split(",")[0].trim() || null : codecs),
      audio_codec: isAudioOnly ? codecs : (isMuxed ? "mp4a.40.2" : null),
      average_bitrate: f.averageBitrate ?? f.bitrate ?? null,
      audio_bitrate: isAudioOnly ? (f.averageBitrate ?? f.bitrate ?? null) : null,
      video_bitrate: isAudioOnly ? null : (f.averageBitrate ?? f.bitrate ?? null),
      filesize: f.contentLength ? parseInt(f.contentLength, 10) : null,
    };

    (isMuxed ? muxed : adaptive).push(stream);
  }

  return { adaptive, muxed, hls: streamingData.hlsManifestUrl || null };
}

// Assembles the array the app receives. Order matters: the shipped getLink()
// remote branch walks `tfRemoteItagPriority ?? [18, 140, 22]` and takes the
// first match, so whatever sits at itag 18 is what actually plays.
function buildResult({ adaptive, muxed, hls }, includeHLS) {
  const out = [];

  // 1. A REAL combined video+audio URL if we got one. ANDROID's itag 18 is a
  //    genuine muxed MP4 and survives the app's byte-range cache proxy.
  const realMuxed = muxed.find((s) => s.itag === 18) || muxed[0];
  if (realMuxed) {
    out.push({ ...realMuxed, itag: 18 });
  } else {
    // 2. No muxed available — put audio under the itag 18 label so installed
    //    builds still get sound. video_codec stays null so nothing downstream
    //    believes there is a video track: Stream.isNativelyPlayable treats a
    //    nil codec as playable, so this still passes the filter.
    const audio =
      adaptive.find((s) => s.itag === 140) ||
      adaptive.filter((s) => s.audio_codec).sort((a, b) => (b.audio_bitrate || 0) - (a.audio_bitrate || 0))[0];
    if (audio) out.push({ ...audio, itag: 18, ext: "m4a", video_codec: null });
  }

  // 3. Real adaptive streams — itag 140 for audio-only playback, plus the
  //    video-only ladder that getPlayerItem composes against.
  out.push(...adaptive);

  // 4. HLS last and opt-in only. See the header note on KTVHTTPCache.
  if (includeHLS && hls) {
    out.push({
      url: hls,
      itag: 96,
      ext: "m3u8",
      video_codec: "avc1.640028",
      audio_codec: "mp4a.40.2",
      average_bitrate: null,
      audio_bitrate: null,
      video_bitrate: null,
      filesize: null,
    });
  }

  return out;
}

// ── Extraction ──────────────────────────────────────────────────────────────
// `doFetch(id, url, method, headers, body) -> {status, text}` is the only thing
// that differs between server-side and app-delegated mode.
async function callPlayer(videoID, cl, visitorData, auth, doFetch) {
  const client = { ...cl.ctx };
  if (visitorData) client.visitorData = visitorData;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": cl.ua,
    "X-YouTube-Client-Name": cl.id,
    "X-YouTube-Client-Version": cl.ctx.clientVersion,
    ...auth,
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;

  const res = await doFetch(
    `player-${cl.name}`,
    PLAYER_URL,
    "POST",
    headers,
    JSON.stringify({
      context: { client },
      videoId: videoID,
      contentCheckOk: true,
      racyCheckOk: true,
    })
  );
  return JSON.parse(res.text);
}

async function extractStreams(videoID, cookie, doFetch, log, includeHLS = false) {
  const auth = await authHeaders(cookie);
  const visitorData = await getVisitorData(doFetch);

  // The muxed call and the adaptive call are independent — run them together.
  const muxedTask = (async () => {
    try {
      const j = await callPlayer(videoID, CLIENT_MUXED, visitorData, auth, doFetch);
      const status = j.playabilityStatus?.status;
      if (!j.streamingData) {
        log(`vid=${videoID} muxed=${CLIENT_MUXED.name} status=${status} no streamingData`);
        return [];
      }
      const { muxed } = splitFormats(j.streamingData);
      log(`vid=${videoID} muxed=${CLIENT_MUXED.name} status=${status} muxed=${muxed.map((s) => s.itag).join(",") || "none"}`);
      return muxed;
    } catch (e) {
      log(`vid=${videoID} muxed=${CLIENT_MUXED.name} threw: ${e && e.message}`);
      return [];
    }
  })();

  const adaptiveTask = (async () => {
    for (const cl of CLIENTS_ADAPTIVE) {
      try {
        const j = await callPlayer(videoID, cl, visitorData, auth, doFetch);
        const status = j.playabilityStatus?.status;
        if (!j.streamingData) {
          log(`vid=${videoID} adaptive=${cl.name} status=${status} no streamingData`);
          continue;
        }
        const { adaptive, hls } = splitFormats(j.streamingData);
        log(`vid=${videoID} adaptive=${cl.name} status=${status} formats=${adaptive.length} hls=${!!hls}`);
        if (adaptive.length) return { adaptive, hls };
      } catch (e) {
        log(`vid=${videoID} adaptive=${cl.name} threw: ${e && e.message}`);
      }
    }
    return { adaptive: [], hls: null };
  })();

  const [muxed, { adaptive, hls }] = await Promise.all([muxedTask, adaptiveTask]);
  return buildResult({ adaptive, muxed, hls }, includeHLS);
}
// Server-side transport: the worker makes the call itself. One round trip.
function serverFetcher() {
  return async (_id, url, method, headers, body) => {
    const res = await fetch(url, { method, headers, body: body ?? undefined });
    return { status: res.status, text: await res.text() };
  };
}

// Delegated transport: the app makes the call from its own (residential) IP.
// Kept because datacenter IPs draw bot checks that phone IPs mostly don't.
function appFetcher(server, pending) {
  return (id, url, method, headers, body) =>
    new Promise((resolve, reject) => {
      pending.set(id, (msg) => {
        try {
          resolve({ status: msg.status_code, text: b64decodeToText(msg.data) });
        } catch (e) {
          reject(e);
        }
      });
      const content = {
        id,
        url,
        method,
        headers,
        allow_redirects: true,
        apply_cookies_on_redirect: false,
        save_intermediate_responses: false,
      };
      if (body != null) content.body = b64encode(body);
      try {
        server.send(JSON.stringify({ type: "urlRequest", content }));
      } catch (e) {
        pending.delete(id);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("app fetch timeout"));
        }
      }, 20000);
    });
}

// ── WebSocket session ───────────────────────────────────────────────────────
async function handleSession(server, videoID, cookie, includeHLS) {
  server.accept();

  const pending = new Map();
  server.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
      );
      if (msg.id && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (_) {}
  });

  const log = (line) => console.log(line);
  let streams = [];

  try {
    streams = await extractStreams(videoID, cookie, serverFetcher(), log, includeHLS);

    // Server-side came back empty — most likely a bot check on the datacenter
    // IP. Retry through the device, which is what the old design always did.
    if (streams.length === 0) {
      log(`vid=${videoID} server-side empty, retrying via device`);
      streams = await extractStreams(videoID, cookie, appFetcher(server, pending), log, includeHLS);
    }
  } catch (e) {
    log(`vid=${videoID} fatal: ${e && e.message}`);
  }

  log(`vid=${videoID} RETURNING ${streams.length} itags=${streams.map((s) => s.itag).join(",")}`);
  try {
    server.send(JSON.stringify({ type: "result", content: streams }));
  } catch (_) {}
  try {
    server.close(1000, "done");
  } catch (_) {}
}

// ── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        muxedClient: CLIENT_MUXED.name,
        adaptiveClients: CLIENTS_ADAPTIVE.map((c) => c.name),
        mode: "server-side, device fallback",
        cookie: env.YOUTUBE_COOKIE ? "configured" : "absent",
      });
    }

    // Plain HTTPS extraction. Nothing in the shipped app calls this — it exists
    // so the server can be tested with curl, and so a future build can drop the
    // WebSocket entirely.
    //   curl 'https://fallback.trending.fm/v1/streams?videoID=dQw4w9WgXcQ'
    if (url.pathname === "/v1/streams") {
      const videoID = url.searchParams.get("videoID");
      if (!videoID) return new Response("missing videoID", { status: 400 });
      const streams = await extractStreams(
        videoID,
        env.YOUTUBE_COOKIE || null,
        serverFetcher(),
        console.log,
        url.searchParams.get("hls") === "1"
      );
      return Response.json({ videoID, count: streams.length, streams });
    }

    if (url.pathname === "/v1") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const videoID = url.searchParams.get("videoID");
      if (!videoID) return new Response("missing videoID", { status: 400 });

      const pair = new WebSocketPair();
      handleSession(pair[1], videoID, env.YOUTUBE_COOKIE || null, url.searchParams.get("hls") === "1");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("Not found", { status: 404 });
  },
};
