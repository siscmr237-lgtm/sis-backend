const express = require('express');
const multer = require('multer');
const { supabase, BUCKET } = require('../utils/storage');

const router = express.Router();

// Accepted MIME types mapped to their file extension
const ALLOWED_MIMES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_SIZE_LIMIT = 5 * 1024 * 1024;  // 5 MB for images
const PDF_SIZE_LIMIT   = 10 * 1024 * 1024; // 10 MB for PDFs (also the multer hard cap)

// Maps the client-supplied `type` value to its storage folder segment
const TYPE_TO_FOLDER = {
  'logo':              'logos',
  'student-headshot':  'students',
  'staff-headshot':    'staff',
  'expense-receipt':   'expenses',
  'event-flyer':       'events',
};

// Base filename (without extension) for each type
const TYPE_TO_FILENAME = {
  'logo':              'logo',
  'student-headshot':  'headshot',
  'staff-headshot':    'headshot',
  'expense-receipt':   'receipt',
  'event-flyer':       'flyer',
};

// Multer: in-memory storage only — never written to disk.
// Hard cap is the PDF limit; per-MIME enforcement happens in the route handler.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PDF_SIZE_LIMIT },
});

function buildStoragePath(schoolId, type, entityId, ext) {
  const folder   = TYPE_TO_FOLDER[type];
  const filename = `${TYPE_TO_FILENAME[type]}.${ext}`;
  // Logos are school-level — no entityId sub-folder
  if (type === 'logo') {
    return `schools/${schoolId}/logos/${filename}`;
  }
  return `schools/${schoolId}/${folder}/${entityId}/${filename}`;
}

// CRITICAL security check — used identically on both GET routes.
// A path is only valid if it begins with the requesting school's prefix.
function pathBelongsToSchool(storagePath, schoolId) {
  return typeof storagePath === 'string' &&
    storagePath.startsWith(`schools/${schoolId}/`);
}

// ─── POST /upload ─────────────────────────────────────────────────────────────
// Accepts multipart/form-data: file, type, entityId (optional for logo)
// Returns: { path }
router.post(
  '/',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File exceeds the maximum allowed size (10 MB).' });
        }
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'File storage is not configured on this server.' });
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { type, entityId } = req.body;
    const { mimetype, buffer, size } = req.file;

    // Validate type
    if (!TYPE_TO_FOLDER[type]) {
      return res.status(400).json({
        error: `Invalid type. Must be one of: ${Object.keys(TYPE_TO_FOLDER).join(', ')}.`,
      });
    }

    // Validate MIME type against whitelist
    const ext = ALLOWED_MIMES[mimetype];
    if (!ext) {
      return res.status(400).json({
        error: 'File type not allowed. Accepted formats: JPEG, PNG, WebP, PDF.',
      });
    }

    // Enforce the tighter image size limit
    if (IMAGE_MIMES.has(mimetype) && size > IMAGE_SIZE_LIMIT) {
      return res.status(400).json({ error: 'Image files must be 5 MB or smaller.' });
    }

    // entityId required for every type except logo
    if (type !== 'logo' && !entityId) {
      return res.status(400).json({ error: 'entityId is required for this file type.' });
    }

    const schoolId = req.user.schoolId;
    const storagePath = buildStoragePath(schoolId, type, entityId, ext);

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType: mimetype, upsert: true });

    if (error) {
      return res.status(500).json({ error: `Storage upload failed: ${error.message}` });
    }

    res.json({ path: storagePath });
  }
);

// ─── GET /upload/signed-url ───────────────────────────────────────────────────
// Query params: path (required), expiresIn (seconds, optional, default 3600, max 86400)
// Returns: { url }
router.get('/signed-url', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'File storage is not configured on this server.' });
  const storagePath = req.query.path;
  const schoolId    = req.user.schoolId;

  if (!storagePath) {
    return res.status(400).json({ error: 'path query parameter is required.' });
  }

  // CRITICAL: reject any path that does not belong to the requesting school
  if (!pathBelongsToSchool(storagePath, schoolId)) {
    return res.status(403).json({ error: 'Forbidden: path does not belong to your school.' });
  }

  const expiresIn = Math.min(parseInt(req.query.expiresIn) || 3600, 86400);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (error || !data?.signedUrl) {
    return res.status(500).json({ error: `Could not generate signed URL: ${error?.message}` });
  }

  res.json({ url: data.signedUrl });
});

// ─── GET /upload/image-data ───────────────────────────────────────────────────
// Returns the file as a base64 data URL for PDF embedding (bypasses browser CORS).
// Query params: path (required)
// Returns: { dataUrl }
router.get('/image-data', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'File storage is not configured on this server.' });
  const storagePath = req.query.path;
  const schoolId    = req.user.schoolId;

  if (!storagePath) {
    return res.status(400).json({ error: 'path query parameter is required.' });
  }

  // CRITICAL: identical path-scoping check as /signed-url
  if (!pathBelongsToSchool(storagePath, schoolId)) {
    return res.status(403).json({ error: 'Forbidden: path does not belong to your school.' });
  }

  const { data: blob, error } = await supabase.storage.from(BUCKET).download(storagePath);

  if (error || !blob) {
    return res.status(500).json({ error: `Could not fetch file: ${error?.message}` });
  }

  const arrayBuffer = await blob.arrayBuffer();
  const buffer      = Buffer.from(arrayBuffer);
  const contentType = blob.type || 'application/octet-stream';
  const dataUrl     = `data:${contentType};base64,${buffer.toString('base64')}`;

  res.json({ dataUrl });
});

module.exports = router;
