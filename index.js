require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const hpp          = require('hpp');
const crypto       = require('crypto');
const { sanitizeRequest } = require('./middleware/sanitize');

// Route modules
const authRouter      = require('./routes/auth');
const schoolsRouter   = require('./routes/schools');
const studentsRouter  = require('./routes/students');
const staffRouter     = require('./routes/staff');
const classesRouter   = require('./routes/classes');
const timetableRouter = require('./routes/timetable');
const attendanceRouter= require('./routes/attendance');
const financeRouter   = require('./routes/finance');
const libraryRouter   = require('./routes/library');
const dashboardRouter = require('./routes/dashboard');
const teacherRouter   = require('./routes/teacher');
const studentRouter   = require('./routes/student');
const parentRouter    = require('./routes/parent');
const subjectsRouter  = require('./routes/subjects');
const gradesRouter    = require('./routes/grades');
const reportsRouter   = require('./routes/reports');
const alumniRouter    = require('./routes/alumni');
const uploadRouter    = require('./routes/upload');
const syncLogRouter   = require('./routes/syncLog');

const app  = express();
const PORT = process.env.PORT || 5000;
const isDev = process.env.NODE_ENV !== 'production';

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Auth endpoints: 20 attempts per 15 minutes per IP (brute-force protection)
const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              20,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// General API: 300 requests per minute. Keyed by the caller's token when present
// so users on a shared school network don't consume each other's quota.
const { ipKeyGenerator } = require('express-rate-limit');
const apiLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              300,
  standardHeaders:  true,
  legacyHeaders:    false,
  keyGenerator:     (req) => {
    const auth = req.headers.authorization;
    if (auth) return crypto.createHash('sha256').update(auth).digest('hex').slice(0, 32);
    return ipKeyGenerator(req);
  },
  skip:             (req) => req.path === '/health',
  message:          { error: 'Too many requests. Please slow down.' },
});

// Bulk operations (grade sync, attendance save): 30 per minute
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:  { error: 'Bulk operation limit reached. Please wait a moment.' },
});

// ── Middleware ────────────────────────────────────────────────────────────────

// Gzip compress all responses — reduces bandwidth 70-80% for JSON payloads
// Critical for Ghana where mobile data is expensive and connections are slow
app.use(compression({ level: 6, threshold: 1024 }));

// Helmet: sets 14 security-related HTTP headers in one call
// Covers: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy etc.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", process.env.SUPABASE_URL || ''],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // allow PDF iframe previews
}));

// Supports a comma-separated list so the API can be reached from multiple
// client origins (e.g. desktop + mobile browsers hitting different domains).
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser tools (no Origin header) and any whitelisted origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Prevent HTTP Parameter Pollution — strips duplicate query params
// e.g. ?school_id=abc&school_id=xyz → only keeps last value
app.use(hpp());

// Apply general rate limit to all API routes
app.use('/api/', apiLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/grades/bulk', bulkLimiter);
app.use('/api/grades/sync', bulkLimiter);
app.use('/api/attendance',  bulkLimiter);

// Paystack webhook needs raw body for signature verification
app.use('/api/finance/webhook', express.raw({ type: 'application/json' }));

// 5MB body limit for photo uploads (base64 encoded images)
// Photo uploads go through /api/upload with larger limit
app.use('/api/upload', express.json({ limit: '5mb' }));

// 10MB body limit for Excel bulk imports (base64 encoded spreadsheets)
const excelImportPaths = [
  '/api/students/import-excel',
  '/api/staff/import-excel',
  '/api/classes/import-excel',
  '/api/subjects/import-excel',
];
app.use(excelImportPaths, express.json({ limit: '10mb' }));

// 50kb body limit for regular API requests
app.use(express.json({ limit: '50kb' }));

// Global XSS sanitization — strips HTML/script tags from ALL string inputs
// in req.body, req.query, and req.params on every request.
// This runs AFTER JSON parsing so the body is already an object.
// Skip /api/upload: its payloads contain large base64 image/receipt data
// that must not be length-truncated or tag-stripped; the upload controller
// validates format, MIME type, and size itself.
// Skip Excel import endpoints: the base64 spreadsheet payload must not be
// truncated or altered; the import controllers validate the file themselves.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/upload')) return next();
  if (req.path.endsWith('/import-excel')) return next();
  sanitizeRequest(req, res, next);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Request logging — development only (production logging should go to a log service)
if (isDev) {
  app.use((req, _res, next) => { console.log(`→ ${req.method} ${req.path}`); next(); });
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/schools',    schoolsRouter);
app.use('/api/students',   studentsRouter);
app.use('/api/staff',      staffRouter);
app.use('/api/classes',    classesRouter);
app.use('/api/timetable',  timetableRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/finance',    financeRouter);
app.use('/api/library',    libraryRouter);
app.use('/api/dashboard',  dashboardRouter);
app.use('/api/teacher',    teacherRouter);
app.use('/api/student',    studentRouter);
app.use('/api/parent',     parentRouter);
app.use('/api/subjects',   subjectsRouter);
app.use('/api/grades',     gradesRouter);
app.use('/api/reports',    reportsRouter);
app.use('/api/alumni',     alumniRouter);
app.use('/api/upload',     uploadRouter);
app.use('/api/sync-log',   syncLogRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  // Only log full stack in dev — in production log to external service
  if (isDev) {
    console.error(`[500] ${req.method} ${req.path}`, err.message, err.stack?.split('\n')[1]);
  } else {
    console.error(`[500] ${req.method} ${req.path}`, err.message);
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large. Please reduce the file size and try again.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request payload.' });
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error.' });
});

app.listen(PORT, () => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`\u{1F7E2} Skoolstak API running on ${publicUrl} [${isDev ? 'development' : 'production'}]`);
});
