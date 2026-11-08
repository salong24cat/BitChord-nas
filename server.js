const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

let trackIndex = [];

async function getFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({
    host: process.env.FTP_HOST,
    port: Number(process.env.FTP_PORT || 2021),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: false
  });
  return client;
}

// 하위 폴더까지 재귀적으로 스캔하는 함수
async function scanDir(client, currentPath, depth = 0) {
  if (depth > 4) return [];
  let results = [];
  try {
    const list = await client.list(currentPath);
    for (const item of list) {
      if (item.name.startsWith('.') || item.name.startsWith('@')) continue; // 시놀로지 시스템 폴더 제외
      const fullPath = `${currentPath.replace(/\/$/, '')}/${item.name}`;
      
      if (item.isDirectory) {
        const sub = await scanDir(client, fullPath, depth + 1);
        results = results.concat(sub);
      } else if (/\.(flac|mp3|m4a|wav)$/i.test(item.name) && item.size > 10240) {
        const ext = path.extname(item.name).toLowerCase();
        const base = path.basename(item.name, ext);
        const parts = base.split(' - ');
        results.push({
          id: Buffer.from(fullPath).toString('base64url'),
          title: parts.length > 1 ? parts.slice(1).join(' - ') : base,
          artist: parts.length > 1 ? parts[0] : (currentPath.split('/').filter(Boolean).pop() || 'NAS Library'),
          fileName: item.name,
          filePath: fullPath,
          size: item.size,
          format: ext.replace('.', ''),
          mime: ext === '.flac' ? 'audio/flac' : (ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4')
        });
      }
    }
  } catch (e) {
    console.error(`Scan error [${currentPath}]:`, e.message);
  }
  return results;
}

async function refreshLibrary() {
  try {
    console.log('[Scan] NAS 음악 폴더 전체 스캔 시작...');
    const client = await getFtp();
    const baseDir = process.env.FTP_MUSIC_DIR || '/music';
    trackIndex = await scanDir(client, baseDir);
    client.close();
    console.log(`[Scan] 완료! 총 ${trackIndex.length}곡의 정상 음원을 찾았습니다.`);
  } catch (e) {
    console.error('Scan failed:', e.message);
  }
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.seonghun.nas.bitchord',
    name: '성훈 님의 NAS 무손실 음원',
    version: '1.0.1',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music'
  });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let results = trackIndex;
  if (q) {
    results = trackIndex.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
  }
  res.json({
    tracks: results.slice(0, 50).map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: 'NAS Storage',
      duration: 240,
      artworkURL: null,
      format: t.format,
      audioQuality: t.format === 'flac' ? 'LOSSLESS' : 'HIGH'
    }))
  });
});

app.get('/stream/:id', (req, res) => {
  const track = trackIndex.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Not found' });
  const host = req.get('host');
  res.json({
    url: `https://${host}/audio/${track.id}`,
    format: track.format,
    quality: track.format === 'flac' ? 'LOSSLESS' : 'HIGH',
    mimeType: track.mime,
    manifest: 'none',
    encrypted: false
  });
});

app.get('/audio/:id', async (req, res) => {
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

app.get('/refresh', async (req, res) => {
  await refreshLibrary();
  res.json({ success: true, count: trackIndex.length });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.FTP_HOST) await refreshLibrary();
});
