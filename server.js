import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import os from 'node:os';


const app = express();
const PORT = process.env.PORT || 4003;

const DATA_FILE = path.resolve('./data.json');
const IMAGES_DB_FILE = path.resolve('./images.json');
const UPLOAD_DIR = path.resolve('./uploads');

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// --- Initialization ---
async function initStorage() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  for (const file of [DATA_FILE, IMAGES_DB_FILE]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify({}, null, 2));
    }
  }
}

// --- Multer Configuration ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    req.generatedImageId = id; // Pass ID to route handler
    cb(null, `${id}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ==========================================
// 1. HEALTH ROUTE
// ==========================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// 2. JSON FILE CRUD ROUTES (/json)
// ==========================================
app.post('/json', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required' });

    const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
    if (key in data) {
      return res.status(409).json({ error: 'Key already exists. Use PATCH to update.' });
    }

    data[key] = value;
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));

    res.status(201).json({ message: 'Key added', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/json/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
    if (!(key in data)) {
      return res.status(404).json({ error: 'Key not found' });
    }

    data[key] = value;
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));

    res.json({ message: 'Key updated', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/json', async (req, res) => {  
  const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
  res.json(data);
});

app.get('/json/:key', async (req, res) => {
  const { key } = req.params;
  const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
  res.json(data[key]);
});
app.delete('/json/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf-8'));
    if (!(key in data)) {
      return res.status(404).json({ error: 'Key not found' });
    }

    delete data[key];
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));

    res.json({ message: 'Key deleted', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. IMAGE STORAGE ROUTES (/images)
// ==========================================

app.get('/images', async (req, res) => {
  const imagesDb = JSON.parse(await fs.readFile(IMAGES_DB_FILE, 'utf-8'));
  res.json(imagesDb);
});

// POST: Save image with random ID & record metadata in images.json
app.post('/images', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file uploaded under field "image"' });
    }

    const id = req.generatedImageId;
    const imagesDb = JSON.parse(await fs.readFile(IMAGES_DB_FILE, 'utf-8'));

    imagesDb[id] = {
      id,
      originalName: req.file.originalname,
      storedFilename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
    };

    await fs.writeFile(IMAGES_DB_FILE, JSON.stringify(imagesDb, null, 2));

    res.status(201).json({
      message: 'Image saved',
      image: imagesDb[id],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: Replace image by random ID & update originalName in images.json
app.patch('/images/:id', upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No replacement image uploaded' });
    }

    const imagesDb = JSON.parse(await fs.readFile(IMAGES_DB_FILE, 'utf-8'));
    const existing = imagesDb[id];

    if (!existing) {
      await fs.unlink(req.file.path); // Clean up newly uploaded temp file
      return res.status(404).json({ error: 'Image ID not found' });
    }

    // Delete the old file on disk (handles extension changes like .jpg -> .png)
    const oldFilePath = path.join(UPLOAD_DIR, existing.storedFilename);
    await fs.unlink(oldFilePath).catch(() => {});

    // Rename new file to use the existing random ID + new extension
    const newStoredFilename = `${id}${path.extname(req.file.originalname)}`;
    const newFilePath = path.join(UPLOAD_DIR, newStoredFilename);
    await fs.rename(req.file.path, newFilePath);

    imagesDb[id] = {
      id,
      originalName: req.file.originalname,
      storedFilename: newStoredFilename,
      url: `/uploads/${newStoredFilename}`,
    };

    await fs.writeFile(IMAGES_DB_FILE, JSON.stringify(imagesDb, null, 2));

    res.json({
      message: 'Image updated',
      image: imagesDb[id],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE: Remove image from disk & remove entry from images.json
app.delete('/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const imagesDb = JSON.parse(await fs.readFile(IMAGES_DB_FILE, 'utf-8'));
    const existing = imagesDb[id];

    if (!existing) {
      return res.status(404).json({ error: 'Image ID not found' });
    }

    const filePath = path.join(UPLOAD_DIR, existing.storedFilename);
    await fs.unlink(filePath).catch(() => {});

    delete imagesDb[id];
    await fs.writeFile(IMAGES_DB_FILE, JSON.stringify(imagesDb, null, 2));

    res.json({ message: 'Image deleted', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/os", (req, res) => {
    //get all os info
    
    res.json({
        platform: os.platform(),       // e.g., 'darwin', 'linux', 'win32'
        type: os.type(),               // e.g., 'Darwin', 'Linux', 'Windows_NT'
        release: os.release(),         // e.g., '23.4.0' or '10.0.22631'
        arch: os.arch(),               // e.g., 'arm64', 'x64'
        hostname: os.hostname(),       // Machine network name
        uptimeHours: (os.uptime() / 3600).toFixed(2),
        totalMemGB: (os.totalmem() / 1e9).toFixed(2),
        freeMemGB: (os.freemem() / 1e9).toFixed(2),
        cpuCores: os.cpus().length,
        homeDir: os.homedir(),
        tempDir: os.tmpdir()
    });
});

app.get('/headers', (req, res) => {
  res.json(req.headers);
});

// Global Multer Error Handler
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

// Start Server
initStorage().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
