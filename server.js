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

async function refreshLibrary() {
  scanLogs = [];
  const log = (msg) => { console.log(msg); scanLogs.push(msg); };
  log(`[Scan Start] ${new Date().toISOString()} - Host: ${process.env.FTP_HOST}`);

  let client;
  try {
    client = await getFtp();
    const baseDir = process.env.FTP_MUSIC_DIR || '/music';
    log(`Connecting to base directory: ${baseDir}`);

    const baseList = await client.list(baseDir);
    let allTracks = [];
    let foldersToScan = [baseDir];

    for (const item of baseList) {
      if (item.name.startsWith('.') || item.name.startsWith('@')) continue;
      const fullPath = `${baseDir.replace(/\/$/, '')}/${item.name}`;

      if (item.isDirectory) {
        foldersToScan.push(fullPath);
      } else if (/\.(flac|mp3|m4a|wav)$/i.test(item.name) && item.size > 10240) {
        allTracks.push(formatTrack(item, fullPath, baseDir));
      }
    }
    log(`Root folder found: ${allTracks.length} tracks, ${foldersToScan.length - 1} subfolders`);

    for (const folder of foldersToScan.slice(1, 25)) {
      try {
        log(`Scanning folder: ${folder}`);
        const subList = await client.list(folder);
        for (const item of subList) {
          if (item.name.startsWith('.') || item.name.startsWith('@')) continue;
          const subPath = `${folder}/${item.name}`;
          if (item.isDirectory) {
            try {
              const albumList = await client.list(subPath);
              for (const song of albumList) {
                if (/\.(flac|mp3|m4a|wav)$/i.test(song.name) && song.size > 10240) {
                  allTracks.push(formatTrack(song, `${subPath}/${song.name}`, item.name));
                }
              }
            } catch (err) {}
          } else if (/\.(flac|mp3|m4a|wav)$/i.test(item.name) && item.size > 10240) {
            allTracks.push(formatTrack(item, subPath, folder.split('/').pop()));
          }
        }
      } catch (err) {
        log(`Error scanning ${folder}: ${err.message}`);
      }
    }

    trackIndex = allTracks;
    log(`[Scan Complete] Total tracks: ${trackIndex.length}`);
  } catch (err) {
    log(`[Scan Error] ${err.message}`);
  } finally {
    if (client) client.close();
  }
}

function formatTrack(item, fullPath, parentName) {
  const ext = path.extname(item.name).toLowerCase();
  const base = path.basename(item.name, ext);
  const parts = base.split(' - ');
  return {
    id: Buffer.from(fullPath).toString('base64url'),
    title: parts.length > 1 ? parts.slice(1).join(' - ') : base,
    artist: parts.length > 1 ? parts[0] : (parentName || 'NAS Library'),
    album: parentName || 'NAS Storage',
    fileName: item.name,
    filePath: fullPath,
    size: item.size,
    format: ext.replace('.', ''),
    mime: ext === '.flac' ? 'audio/flac' : (ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4')
  };
}

// 1. BitChord Manifest 규격
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.seonghun.nas.bitchord',
    name: '개인 NAS 및 KBS 클래식FM',
    version: '1.0.5',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music'
  });
});

// 2. 음원 및 KBS 클래식 FM 검색
app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let results = trackIndex;
  if (q) {
    results = trackIndex.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
  }

  // KBS 클래식 FM 항목 (검색어가 없거나 kbs/라디오/클래식 검색 시 최상단 노출)
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

// 5. 📻 실시간 HLS -> 무한 AAC 스트림 중계 (BitChord 18초 끊김 방지)
app.get('/radio/kbs-1fm', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/aac',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Accept-Ranges': 'none'
  });

  let isAlive = true;
  req.on('close', () => {
    isAlive = false;
  });

  const sentSegments = new Set();
  let firstRun = true;

  while (isAlive) {
    try {
      const playlistUrl = await getKbsClassicFmStream();
      if (!playlistUrl) break;

      const m3u8Resp = await fetch(playlistUrl);
      const m3u8Text = await m3u8Resp.text();
      const lines = m3u8Text.split('\n');

      const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
      const segments = lines.filter(l => l.trim().includes('.aac')).map(l => l.trim());

      // 첫 연결 시 최근 2개 세그먼트를 즉시 보내 재생 시작
      const candidates = firstRun ? segments.slice(-2) : segments;
      firstRun = false;

      for (const seg of candidates) {
        if (!isAlive) break;
        if (sentSegments.has(seg)) continue;

        sentSegments.add(seg);
        if (sentSegments.size > 50) {
          const first = sentSegments.values().next().value;
          sentSegments.delete(first);
        }

        const segUrl = seg.startsWith('http') ? seg : `${baseUrl}${seg}`;
        const segResp = await fetch(segUrl);
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
      }
    } catch (err) {
      console.error('Radio relay error:', err.message);
    }

    if (!isAlive) break;
    await new Promise(r => setTimeout(r, 3500));
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
    version: '1.0.5',
    radio_channel: 'KBS 1FM Classic (Continuous AAC)',
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
