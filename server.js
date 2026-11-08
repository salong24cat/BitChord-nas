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

async function scan() {
  try {
    const client = await getFtp();
    const list = await client.list(process.env.FTP_MUSIC_DIR || '/music');
    trackIndex = list
      .filter(f => !f.isDirectory && /\.(flac|mp3|m4a|wav)$/i.test(f.name))
      .map(f => {
        const ext = path.extname(f.name).toLowerCase();
        const base = path.basename(f.name, ext);
        const parts = base.split(' - ');
        return {
          id: Buffer.from(f.name).toString('base64url'),
          title: parts.length > 1 ? parts.slice(1).join(' - ') : base,
          artist: parts.length > 1 ? parts[0] : 'NAS Library',
          fileName: f.name,
          format: ext.replace('.', ''),
          mime: ext === '.flac' ? 'audio/flac' : (ext === '.mp3' ? 'audio/mpeg' : 'audio/mp4')
        };
      });
    client.close();
    console.log(`Scan complete: ${trackIndex.length} tracks`);
  } catch (e) {
    console.error('Scan error:', e.message);
  }
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.seonghun.nas.bitchord',
    name: '성훈 님의 NAS 무손실 음원',
    version: '1.0.0',
    resources: ['search', 'stream'],
    types: ['track'],
    contentType: 'music'
  });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const results = trackIndex.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
  res.json({
    tracks: results.slice(0, 30).map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: 'NAS Storage',
      duration: 180,
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
  let client;
  try {
    client = await getFtp();
    res.setHeader('Content-Type', track.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    const dir = process.env.FTP_MUSIC_DIR || '/music';
    await client.downloadTo(res, `${dir}/${track.fileName}`);
  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(500).send('Error');
  } finally {
    if (client) client.close();
  }
});

app.get('/refresh', async (req, res) => {
  await scan();
  res.json({ count: trackIndex.length });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.FTP_HOST) await scan();
});
