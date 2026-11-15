const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 나만 쓰는 비밀키 잠금 (Render 환경변수 ADDON_KEY)
//    ADDON_KEY 가 비어 있으면 기존처럼 루트 경로로 동작(호환 모드)
//    ADDON_KEY 가 있으면 /<ADDON_KEY>/... 로만 통과, 그 외는 403
const ADDON_KEY = (process.env.ADDON_KEY || '').trim().replace(/^\/+|\/+$/g, '');
const KEY_PREFIX = ADDON_KEY ? `/${ADDON_KEY}` : '';

// 0. 모든 요청보다 먼저 비밀키 경로 검사 (prefix 제거 후 기존 라우터로 전달)
app.use((req, res, next) => {
  if (!ADDON_KEY) return next();

  const rawUrl = req.url || '/';
  const isAllowed =
    rawUrl === KEY_PREFIX ||
    rawUrl.startsWith(`${KEY_PREFIX}/`) ||
    rawUrl.startsWith(`${KEY_PREFIX}?`);

  if (!isAllowed) {
    return res.status(403).type('text/plain; charset=utf-8').send('403 Forbidden');
  }

  const rest = rawUrl.slice(KEY_PREFIX.length);
  req.url = rest.startsWith('/') ? rest : `/${rest}`;
  next();
});

app.use(cors());

const CACHE_FILE = path.join(__dirname, 'library.json');
let trackIndex = [];
let scanLogs = [];
let isScanning = false;
const artworkCache = new Map();

// 📻 라디오 채널 정의 (KBS 1FM 클래식 / NRK Klassisk / Shonan Beach FM)
const RADIO_CHANNELS = [
  {
    id: 'kbs-1fm',
    title: 'KBS 1FM 클래식 (93.1MHz)',
    artist: 'KBS 라디오',
    album: '실시간 라디오 방송',
    artworkURL: 'https://padmin.static.kbs.co.kr/live/2025/3/11/1741700004216_443813.png',
    format: 'aac',
    mime: 'audio/aac',
    quality: 'HIGH',
    kind: 'hls',
    ownWords: ['kbs', '1fm', '1에프엠', '케이비에스']
  },
  {
    id: 'nrk-klassisk',
    title: 'NRK Klassisk (클래식 실시간)',
    artist: 'NRK 라디오',
    album: '실시간 라디오 방송',
    artworkURL: 'https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=600&auto=format&fit=crop&q=80',
    format: 'mp3',
    mime: 'audio/mpeg',
    quality: 'HIGH',
    kind: 'icecast',
    upstream: 'https://lyd.nrk.no/icecast/mp3/high/s0w7hwn47m/klassisk',
    ownWords: ['nrk', '노르웨이']
  },
  {
    id: 'shonan-beach-fm',
    title: 'Shonan Beach FM 78.9 (쇼난비치 FM)',
    artist: 'Shonan Beach FM',
    album: '실시간 라디오 방송',
    artworkURL: 'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=600&auto=format&fit=crop&q=80',
    format: 'mp3',
    mime: 'audio/mpeg',
    quality: 'HIGH',
    kind: 'icecast',
    upstream: 'https://shonanbeachfm.out.airtime.pro/shonanbeachfm_c',
    ownWords: ['쇼난', 'shonan', 'beach', '비치', '재즈', 'jazz']
  }
];

// 검색어가 특정 방송사 이름이 아니어도 라디오를 띄우는 일반 키워드
const RADIO_GENERIC_WORDS = [
  '라디오', 'radio', 'fm', '클래식', 'classic', 'classical',
  '방송', '실시간', 'live', '스트리밍', 'stream', '음악방송'
];

function findRadio(id) {
  return RADIO_CHANNELS.find(r => r.id === id);
}

// 검색어 → 노출할 라디오 목록 (방송사 지정 검색이면 그 채널, 일반 키워드면 3개 모두, 그 외 없음)
function matchingRadios(q) {
  if (!q) return RADIO_CHANNELS;
  const owned = RADIO_CHANNELS.filter(r => r.ownWords.some(w => q.includes(w)));
  if (owned.length > 0) return owned;
  if (RADIO_GENERIC_WORDS.some(w => q.includes(w))) return RADIO_CHANNELS;
  return [];
}

// 시작 즉시 이전 캐시 파일 로드 (재배포/재부팅 시 0곡 공백 원천 차단)
if (fs.existsSync(CACHE_FILE)) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (Array.isArray(cached) && cached.length > 0) {
      trackIndex = cached;
      console.log(`[Cache Loaded] Loaded ${trackIndex.length} tracks from disk`);
    }
  } catch (e) {
    console.error('Cache load error:', e.message);
  }
}

async function getFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.ftp.timeout = 7000; // 7초 타임아웃
  await client.access({
    host: process.env.FTP_HOST,
    port: Number(process.env.FTP_PORT || 2021),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: false
  });
  return client;
}

// 📻 KBS 1FM (클래식 FM) 실시간 스트림 주소 동적 획득
async function getKbsClassicFmStream() {
  try {
    const resp = await fetch('https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/24');
    const data = await resp.json();
    if (data && data.channel_item && data.channel_item.length > 0) {
      return data.channel_item[0].service_url;
    }
  } catch (err) {
    console.error('KBS API Error:', err.message);
  }
  return null;
}

// 📁 NAS 전 서브디렉토리 고속 무중단 탐색 (실시간 점진 반영 & 소켓 오류 자동 복구)
async function refreshLibrary() {
  if (isScanning) {
    console.log('Scan already in progress, skipping duplicate call');
    return;
  }
  isScanning = true;
  scanLogs = [];
  const log = (msg) => { console.log(msg); scanLogs.push(msg); };
  log(`[Scan Start] ${new Date().toISOString()} - Host: ${process.env.FTP_HOST}`);

  let client;
  try {
    client = await getFtp();
    const baseDir = process.env.FTP_MUSIC_DIR || '/music';
    log(`Connecting to base directory: ${baseDir}`);

    const queue = [baseDir];
    let allTracks = [...trackIndex]; // 기존 인덱스 유지
    let scannedFolders = 0;
    const MAX_FOLDERS = 5000;

    while (queue.length > 0 && scannedFolders < MAX_FOLDERS) {
      const currentDir = queue.shift();
      scannedFolders++;

      let list;
      try {
        list = await client.list(currentDir);
      } catch (dirErr) {
        log(`Folder skip [${currentDir.split('/').slice(-2).join('/')}]: ${dirErr.message}`);
        // FTP 오류 발생 시 소켓 깨짐 방지를 위해 재연결
        try { client.close(); } catch (e) {}
        try {
          client = await getFtp();
        } catch (reconnErr) {
          log(`FTP reconnect error: ${reconnErr.message}`);
          break;
        }
        continue;
      }

      for (const item of list) {
        const itemName = (item.name || '').normalize('NFC');

        // 시놀로지 휴지통, 썸네일, 숨김파일, 백업 복제본 제외
        if (
          itemName.startsWith('.') ||
          itemName.startsWith('@') ||
          itemName.startsWith('#') ||
          itemName.includes('.bak')
        ) {
          continue;
        }

        const fullPath = `${currentDir.replace(/\/$/, '')}/${itemName}`;

        if (item.isDirectory) {
          queue.push(fullPath);
          if (itemName.includes('강성훈')) {
            log(`[Target Folder] ${fullPath}`);
          }
        } else if (
          /\.(flac|mp3|m4a|wav|ogg|aac|wma|ape|mp4)$/i.test(itemName) &&
          item.size > 10240
        ) {
          const track = formatTrack(item, fullPath, baseDir);
          allTracks.push(track);

          // 실시간 점진 업데이트 (10곡마다 검색 인덱스에 즉각 반영)
          if (allTracks.length % 10 === 0) {
            trackIndex = allTracks;
          }
        }
      }
    }

    // 중복 제거 후 최종 반영 및 디스크 영구 저장
    const uniqueMap = new Map();
    for (const t of allTracks) {
      uniqueMap.set(t.filePath, t);
    }
    trackIndex = Array.from(uniqueMap.values());
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(trackIndex));
    } catch (e) {}

    log(`[Scan Complete] Scanned ${scannedFolders} folders. Total tracks: ${trackIndex.length}`);
  } catch (err) {
    log(`[Scan Error] ${err.message}`);
  } finally {
    isScanning = false;
    if (client) {
      try { client.close(); } catch (e) {}
    }
  }
}

function formatTrack(item, fullPath, baseDir) {
  const normPath = fullPath.normalize('NFC');
  const ext = path.extname(normPath).toLowerCase();
  const base = path.basename(normPath, ext);
  const parts = base.split(' - ');

  // 폴더 경로 구조 분석 (예: KPOP/강성훈/1집/01.mp3)
  const relPath = normPath.replace(baseDir, '').replace(/^\//, '');
  const dirParts = path.dirname(relPath).split('/').filter(Boolean);
  const parentFolder = dirParts[dirParts.length - 1] || 'NAS Library';
  const rootCategory = dirParts.length > 0 ? dirParts[0] : 'Music';

  let artist = parts.length > 1 ? parts[0].trim() : parentFolder;
  let title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : base;

  return {
    id: Buffer.from(normPath).toString('base64url'),
    title: title,
    artist: artist,
    album: dirParts.length > 1 ? `${rootCategory} / ${parentFolder}` : parentFolder,
    fileName: normPath.split('/').pop(),
    filePath: normPath,
    size: item.size,
    format: ext.replace('.', ''),
    mime: ext === '.flac' ? 'audio/flac' : (ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4')
  };
}

// 1. BitChord Manifest 규격
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.seonghun.nas.bitchord',
    name: '개인 NAS 무손실 및 라디오 (KBS·NRK·쇼난비치)',
    version: '1.2.0',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music'
  });
});

// 2. 음원 및 서브디렉토리 전체 통합 검색
app.get('/search', (req, res) => {
  const rawQ = (req.query.q || '').trim();
  const q = rawQ.normalize('NFC').toLowerCase();
  let results = trackIndex;

  if (q) {
    results = trackIndex.filter(t => {
      const title = (t.title || '').normalize('NFC').toLowerCase();
      const artist = (t.artist || '').normalize('NFC').toLowerCase();
      const album = (t.album || '').normalize('NFC').toLowerCase();
      const filePath = (t.filePath || '').normalize('NFC').toLowerCase();
      return title.includes(q) || artist.includes(q) || album.includes(q) || filePath.includes(q);
    });
  }

  // 📻 라디오 항목 (검색창 진입 시 3개 모두, 방송사/장르 키워드면 해당 채널)
  const radioItems = matchingRadios(q).map(r => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    duration: 0,
    artworkURL: r.artworkURL,
    format: r.format,
    audioQuality: r.quality
  }));

  const host = req.get('host');
  const tracks = [
    ...radioItems,
    ...results.slice(0, 50).map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: 240,
      artworkURL: `https://${host}${KEY_PREFIX}/artwork/${t.id}`,
      format: t.format,
      audioQuality: t.format === 'flac' ? 'LOSSLESS' : 'HIGH'
    }))
  ];

  res.json({ tracks });
});

// 3. 고화질 앨범 아트 자동 매칭 (Apple Music / iTunes API)
app.get('/artwork/:id', async (req, res) => {
  const track = trackIndex.find(t => t.id === req.params.id);
  const defaultArt = 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80';
  if (!track) return res.redirect(defaultArt);

  if (artworkCache.has(track.id)) {
    return res.redirect(artworkCache.get(track.id));
  }

  try {
    const cleanTitle = track.title.replace(/^[\d\s\-_.]+/, '').replace(/\[.*?\]|\(.*?\)/g, '').trim();
    const cleanArtist = track.artist.replace(/^[\d\s\-_.]+/, '').replace(/\[.*?\]|\(.*?\)/g, '').trim();
    const query = `${cleanArtist} ${cleanTitle}`.trim();

    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`;
    const resp = await fetch(itunesUrl);
    const data = await resp.json();
    if (data.resultCount > 0 && data.results[0].artworkUrl100) {
      const art = data.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
      artworkCache.set(track.id, art);
      return res.redirect(art);
    }
  } catch (e) {
    console.error('Artwork search error:', e.message);
  }

  artworkCache.set(track.id, defaultArt);
  res.redirect(defaultArt);
});

// 4. 스트림 링크 조회 (라디오 3채널 + NAS 음원)
app.get('/stream/:id', (req, res) => {
  const host = req.get('host');
  const radio = findRadio(req.params.id);

  if (radio) {
    return res.json({
      url: `https://${host}${KEY_PREFIX}/radio/${radio.id}`,
      format: radio.format,
      quality: radio.quality,
      mimeType: radio.mime,
      manifest: 'none',
      encrypted: false
    });
  }

  const track = trackIndex.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Not found' });

  res.json({
    url: `https://${host}${KEY_PREFIX}/audio/${track.id}`,
    format: track.format,
    quality: track.format === 'flac' ? 'LOSSLESS' : 'HIGH',
    mimeType: track.mime,
    manifest: 'none',
    encrypted: false
  });
});

// 5-1. 📻 KBS 1FM 실시간 HLS -> 무한 AAC 스트림 중계 (버퍼 고갈 방지)
app.get('/radio/kbs-1fm', async (req, res) => {
  if (req.socket) {
    req.socket.setKeepAlive(true, 5000);
    req.socket.setNoDelay(true);
  }

  res.writeHead(200, {
    'Content-Type': 'audio/aac',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Connection': 'keep-alive',
    'Accept-Ranges': 'none'
  });

  let isAlive = true;
  req.on('close', () => { isAlive = false; });
  req.on('error', () => { isAlive = false; });

  const sentSegments = new Set();
  let playlistUrl = await getKbsClassicFmStream();

  while (isAlive) {
    try {
      if (!playlistUrl) {
        playlistUrl = await getKbsClassicFmStream();
        if (!playlistUrl) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }

      const m3u8Resp = await fetch(playlistUrl);
      if (!m3u8Resp.ok) {
        playlistUrl = null;
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const m3u8Text = await m3u8Resp.text();
      const lines = m3u8Text.split('\n');

      const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
      const segments = lines.filter(l => l.trim().includes('.aac')).map(l => l.trim());

      for (const seg of segments) {
        if (!isAlive) break;
        if (sentSegments.has(seg)) continue;

        sentSegments.add(seg);
        if (sentSegments.size > 50) {
          const first = sentSegments.values().next().value;
          sentSegments.delete(first);
        }

        const segUrl = seg.startsWith('http') ? seg : `${baseUrl}${seg}`;
        try {
          const segResp = await fetch(segUrl);
          if (!segResp.ok) continue;

          const arrayBuf = await segResp.arrayBuffer();
          const buf = Buffer.from(arrayBuf);

          // ID3 태그 헤더 제거 후 순수 ADTS AAC 프레임 스트리밍
          let audioBuf = buf;
          if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
            const id3Size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
            const offset = 10 + id3Size;
            if (offset < buf.length) {
              audioBuf = buf.subarray(offset);
            }
          }

          res.write(audioBuf);
        } catch (fetchErr) {
          console.error('Segment fetch error:', fetchErr.message);
        }
      }
    } catch (err) {
      console.error('Radio relay loop error:', err.message);
    }

    if (!isAlive) break;
    await new Promise(r => setTimeout(r, 1800));
  }

  res.end();
});

// 5-2. 📻 Icecast MP3 실시간 중계 (NRK Klassisk / Shonan Beach FM)
//      - 301/302 리다이렉트 자동 추적 (redirect: 'follow')
//      - 클라이언트 접속 종료 시 AbortController 로 업스트림 즉시 정리
//      - 업스트림이 끊기면(Connection: Close) 1.5초 후 자동 재접속하여 무한 재생 유지
// Icecast 는 청취자가 방송 중간에 접속하므로 첫 바이트가 MP3 프레임 중간(또는 ID3 태그 중간)일 수 있다.
// 첫 청크에서 유효한 MP3 프레임 시작점을 찾아 앞쪽 자투리를 잘라낸다 (못 찾으면 원본 그대로 전송).
function findMp3FrameStart(buf, maxScan = 8192) {
  const limit = Math.min(buf.length - 1, maxScan);
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== 0xff) continue;
    const b1 = buf[i + 1];
    if ((b1 & 0xe0) !== 0xe0) continue;
    const version = (b1 >> 3) & 0x03;
    const layer = (b1 >> 1) & 0x03;
    const bitrate = (buf[i + 2] >> 4) & 0x0f;
    const samplerate = (buf[i + 2] >> 2) & 0x03;
    if (version === 1 || layer === 0 || bitrate === 0x0f || samplerate === 3) continue;
    return i;
  }
  return -1;
}

function waitForDrainOrClose(res) {
  return new Promise((resolve) => {
    const finish = () => {
      res.off('drain', finish);
      res.off('close', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 10000);
    res.once('drain', finish);
    res.once('close', finish);
  });
}

async function relayIcecast(req, res, upstreamUrl, label) {
  if (req.socket) {
    req.socket.setKeepAlive(true, 5000);
    req.socket.setNoDelay(true);
  }

  const controller = new AbortController();
  let aborted = false;
  const abortUpstream = () => {
    if (aborted) return;
    aborted = true;
    try { controller.abort(); } catch (e) {}
  };

  req.on('close', abortUpstream);
  req.on('error', abortUpstream);
  res.on('close', abortUpstream);

  let started = false;

  try {
    while (!aborted) {
      let upstream;
      try {
        upstream = await fetch(upstreamUrl, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'BitChord-NAS-Addon/1.2 (+https://github.com/salong24cat/bitchord-nas)',
            'Accept': '*/*',
            'Icy-MetaData': '0'
          }
        });
      } catch (err) {
        if (aborted || err.name === 'AbortError') break;
        console.error(`[Radio ${label}] upstream fetch error:`, err.message);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      if (!upstream.ok || !upstream.body) {
        console.error(`[Radio ${label}] upstream status ${upstream.status}`);
        if (!started) {
          return res.status(502).json({ error: 'Upstream radio unavailable', upstream_status: upstream.status });
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (!started) {
        started = true;
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Connection': 'keep-alive',
          'Accept-Ranges': 'none'
        });
      }

      const reader = upstream.body.getReader();
      let firstChunk = true;
      try {
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) break;

          let buf = Buffer.from(value);
          if (firstChunk) {
            firstChunk = false;
            const startsAtSync = buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
            if (!startsAtSync) {
              const offset = findMp3FrameStart(buf);
              if (offset > 0) buf = buf.subarray(offset);
            }
          }

          const ok = res.write(buf);
          if (!ok) await waitForDrainOrClose(res);
        }
      } catch (err) {
        if (!aborted && err.name !== 'AbortError') {
          console.error(`[Radio ${label}] stream read error:`, err.message);
        }
      } finally {
        try { await reader.cancel(); } catch (e) {}
      }

      if (aborted) break;
      // 업스트림이 스스로 끊은 경우 잠시 후 재접속
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    if (!aborted && err.name !== 'AbortError') {
      console.error(`[Radio ${label}] relay error:`, err.message);
    }
  } finally {
    abortUpstream();
    if (!res.writableEnded) {
      try { res.end(); } catch (e) {}
    }
  }
}

app.get('/radio/nrk-klassisk', (req, res) => {
  const radio = findRadio('nrk-klassisk');
  return relayIcecast(req, res, radio.upstream, radio.id);
});

app.get('/radio/shonan-beach-fm', (req, res) => {
  const radio = findRadio('shonan-beach-fm');
  return relayIcecast(req, res, radio.upstream, radio.id);
});

// 6. 실시간 오디오 스트리밍 (NAS 음원 전용 HTTP 206 Partial Content 파이프)
app.get('/audio/:id', async (req, res) => {
  const radio = findRadio(req.params.id);
  if (radio) {
    return res.redirect(`${KEY_PREFIX}/radio/${radio.id}`);
  }

  const track = trackIndex.find(t => t.id === req.params.id);
  if (!track) return res.status(404).send('Not found');

  const range = req.headers.range;
  let client;

  try {
    client = await getFtp();

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : track.size - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${track.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': track.mime
      });

      await client.downloadTo(res, track.filePath, start);
    } else {
      res.writeHead(200, {
        'Content-Length': track.size,
        'Accept-Ranges': 'bytes',
        'Content-Type': track.mime
      });

      await client.downloadTo(res, track.filePath);
    }
  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(500).send('Streaming error');
  } finally {
    if (client) client.close();
  }
});

// 7. 상태 진단 및 온디맨드 리프레시
app.get('/debug', (req, res) => {
  res.json({
    status: 'online',
    version: '1.2.0',
    radio_channels: RADIO_CHANNELS.map(r => ({ id: r.id, title: r.title })),
    addon_key_locked: Boolean(ADDON_KEY),
    key_prefix: KEY_PREFIX,
    is_scanning: isScanning,
    total_tracks: trackIndex.length,
    sample_tracks: trackIndex.slice(0, 5),
    logs: scanLogs
  });
});

app.get('/refresh', async (req, res) => {
  refreshLibrary();
  res.json({ message: 'Scan started in background', current_count: trackIndex.length });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (ADDON_KEY) {
    console.log(`[Addon Key] Locked. Register with https://<host>${KEY_PREFIX}/manifest.json`);
  } else {
    console.log('[Addon Key] Not set. Open mode (legacy) - /manifest.json');
  }
  if (process.env.FTP_HOST) {
    setTimeout(refreshLibrary, 1000);
  }
});
