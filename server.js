const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

let trackIndex = [];
let scanLogs = [];
const artworkCache = new Map();

async function getFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.ftp.timeout = 10000; // 10초 타임아웃
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

// 📁 NAS 전 서브디렉토리 무제한 깊이 재귀 탐색 (한글 유니코드 NFC 정규화 및 WMA/APE 확장자 완비)
async function refreshLibrary() {
  scanLogs = [];
  const log = (msg) => { console.log(msg); scanLogs.push(msg); };
  log(`[Scan Start] ${new Date().toISOString()} - Host: ${process.env.FTP_HOST}`);

  let client;
  try {
    client = await getFtp();
    const baseDir = process.env.FTP_MUSIC_DIR || '/music';
    log(`Connecting to base directory: ${baseDir}`);

    const queue = [baseDir];
    let allTracks = [];
    let scannedFolders = 0;
    const MAX_FOLDERS = 2000; // 하위 폴더 최대 2,000개까지 대폭 확대 탐색

    while (queue.length > 0 && scannedFolders < MAX_FOLDERS) {
      const currentDir = queue.shift();
      scannedFolders++;
      try {
        const list = await client.list(currentDir);
        for (const item of list) {
          // 한글 유니코드 NFD -> NFC 표준 완성형 변환
          const itemName = (item.name || '').normalize('NFC');
          if (itemName.startsWith('.') || itemName.startsWith('@')) continue;

          const fullPath = `${currentDir.replace(/\/$/, '')}/${itemName}`;

          if (item.isDirectory) {
            queue.push(fullPath);
            if (itemName.includes('강성훈')) {
              log(`[Found Targeted Folder] ${fullPath}`);
            }
          } else if (/\.(flac|mp3|m4a|wav|ogg|aac|wma|ape|mp4)$/i.test(itemName) && item.size > 10240) {
            allTracks.push(formatTrack(item, fullPath, baseDir));
          }
        }
      } catch (dirErr) {
        log(`Folder scan skipped [${currentDir}]: ${dirErr.message}`);
      }
    }

    trackIndex = allTracks;
    log(`[Scan Complete] Scanned ${scannedFolders} folders. Total tracks indexed: ${trackIndex.length}`);
  } catch (err) {
    log(`[Scan Error] ${err.message}`);
  } finally {
    if (client) client.close();
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
    name: '개인 NAS 무손실 및 KBS 라디오',
    version: '1.0.8',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music'
  });
});

// 2. 음원 및 서브디렉토리 전체 통합 검색 (한글 NFC 정규화 검색)
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

  // KBS 클래식 FM 항목 (kbs/라디오/클래식 관련 검색 또는 검색창 진입 시 노출)
  const isRadioMatch = !q || q.includes('kbs') || q.includes('라디오') || q.includes('클래식') || q.includes('1fm') || q.includes('fm') || q.includes('classic');
  const radioItem = isRadioMatch ? [{
    id: 'kbs-1fm',
    title: 'KBS 1FM 클래식 (93.1MHz)',
    artist: 'KBS 라디오',
    album: '실시간 라디오 방송',
    duration: 0,
    artworkURL: 'https://padmin.static.kbs.co.kr/live/2025/3/11/1741700004216_443813.png',
    format: 'aac',
    audioQuality: 'HIGH'
  }] : [];

  const host = req.get('host');
  const tracks = [
    ...radioItem,
    ...results.slice(0, 50).map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: 240,
      artworkURL: `https://${host}/artwork/${t.id}`,
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

// 4. 스트림 링크 조회 (무한 AAC 스트림 직결)
app.get('/stream/:id', (req, res) => {
  const host = req.get('host');

  if (req.params.id === 'kbs-1fm') {
    return res.json({
      url: `https://${host}/radio/kbs-1fm`,
      format: 'aac',
      quality: 'HIGH',
      mimeType: 'audio/aac',
      manifest: 'none',
      encrypted: false
    });
  }

  const track = trackIndex.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Not found' });

  res.json({
    url: `https://${host}/audio/${track.id}`,
    format: track.format,
    quality: track.format === 'flac' ? 'LOSSLESS' : 'HIGH',
    mimeType: track.mime,
    manifest: 'none',
    encrypted: false
  });
});

// 5. 📻 실시간 HLS -> 무한 AAC 스트림 중계 (버퍼 고갈 방지)
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

// 6. 실시간 오디오 스트리밍 (NAS 음원 전용 HTTP 206 Partial Content 파이프)
app.get('/audio/:id', async (req, res) => {
  if (req.params.id === 'kbs-1fm') {
    return res.redirect('/radio/kbs-1fm');
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
    version: '1.0.8',
    radio_channel: 'KBS 1FM Classic',
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
  if (process.env.FTP_HOST) {
    setTimeout(refreshLibrary, 1000);
  }
});
