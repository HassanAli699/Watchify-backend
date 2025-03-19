// watchify_server.mjs
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import WebTorrent from 'webtorrent';

const app = express();
const client = new WebTorrent();
const PORT = 3000;
const DOWNLOAD_DIR = './downloads';
const activeTorrents = new Map();
const TORRENT_TTL = 10 * 60 * 1000; // 10 minutes

app.use(cors());

// ✅ Health check
app.get('/status', (req, res) => {
    res.json({ status: 'Watchify server running ✅' });
});

// ✅ Torrent search endpoint (using an external API)
// You can replace with your preferred torrent API or scraping
app.get('/search', async (req, res) => {
    const query = req.query.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        // Example using apibay or any other open API
        const response = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`);
        const allTorrents = response.data
            .filter(item => item.name)
            .map(item => ({
                name: item.name,
                size: item.size,
                seeders: item.seeders,
                leechers: item.leechers,
                magnet: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}`
            }));

        const totalResults = allTorrents.length;
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedResults = allTorrents.slice(startIndex, endIndex);

        res.json({
            totalResults,
            currentPage: page,
            perPage: limit,
            totalPages: Math.ceil(totalResults / limit),
            results: paginatedResults
        });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: 'Error fetching torrents' });
    }
});


app.get('/stream', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) {
        return res.status(400).json({ error: 'Magnet link is required' });
    }

    let torrent = client.get(magnet);
    if (!torrent) {
        console.log('Adding new torrent...');
        torrent = await new Promise((resolve, reject) => {
            client.add(magnet, (t) => resolve(t));
        });
    } else {
        console.log('Torrent found in client, reusing...');
    }

    if (!torrent.ready) {
        await new Promise((resolve) => torrent.once('ready', resolve));
    }

    // Refresh keep-alive timer
    keepTorrentAlive(torrent);

    const file = torrent.files.find(file =>
        file.name.endsWith('.mp4') ||
        file.name.endsWith('.mkv') ||
        file.name.endsWith('.avi')
    );

    if (!file) {
        return res.status(404).json({ error: 'No video file found in torrent.' });
    }

    const fileSize = file.length;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;

        const headers = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        };

        console.log(`Streaming ${file.name} from byte ${start} to ${end}`);

        res.writeHead(206, headers);
        const stream = file.createReadStream({ start, end });
        stream.pipe(res);

        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
            keepTorrentAlive(torrent);
        });

        res.on('close', () => {
            if (!stream.destroyed) stream.destroy();
            console.log('Client closed connection, keeping torrent alive...');
            keepTorrentAlive(torrent);
        });

    } else {
        // No range header — stream entire file
        console.log(`No Range header — streaming full video: ${file.name}`);

        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
        });

        const stream = file.createReadStream();
        stream.pipe(res);

        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
            keepTorrentAlive(torrent);
        });

        res.on('close', () => {
            if (!stream.destroyed) stream.destroy();
            console.log('Client closed full stream, keeping torrent alive...');
            keepTorrentAlive(torrent);
        });
    }

    torrent.on('error', (err) => {
        console.error('Torrent error:', err.message);
        if (!torrent.destroyed) torrent.destroy();
        activeTorrents.delete(torrent.infoHash);
    });
});


function keepTorrentAlive(torrent) {
    // Clear existing timeout if any
    const existing = activeTorrents.get(torrent.infoHash);
    if (existing && existing.timeout) {
        clearTimeout(existing.timeout);
    }

    // Set new timeout
    const timeout = setTimeout(() => {
        console.log(`Destroying cached torrent: ${torrent.infoHash}`);
        if (!torrent.destroyed) torrent.destroy();
        activeTorrents.delete(torrent.infoHash);
    }, TORRENT_TTL);

    // Store/refresh entry
    activeTorrents.set(torrent.infoHash, { torrent, timeout });
}


// ✅ Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Watchify server running at http://0.0.0.0:${PORT}`);
});
