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

async function getFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  client.ftp.timeout = 10000; // 10초 타임아웃으로 먹통 방지
  await client.access({
    host: process.env.FTP_HOST,
    port: Number(process.env.FTP_PORT || 2021),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: false
  });
  return client;
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

    // 하위 폴더 순차 스캔
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
    fileName: item.name,
    filePath: fullPath,
    size: item.size,
    format: ext.replace('.', ''),
    mime: ext === '.flac' ? 'audio/flac' : (ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4')
  };
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.seonghun.nas.bitchord',
    name: '성훈 님의 NAS 무손실 음원',
    version: '1.0.2',
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

app.get('/debug', (req, res) => {
  res.json({
    status: 'online',
    version: '1.0.2',
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
