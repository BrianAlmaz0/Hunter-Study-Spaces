import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/hunter-study-spaces';
const JWT_SECRET = process.env.JWT_SECRET || 'hunter-study-spaces-dev-secret';

let db;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Auth helpers ──────────────────────────────────────────────────────────────

const ALLOWED_DOMAINS = ['login.cuny.edu', 'hunter.cuny.edu', 'myhunter.cuny.edu'];
const isValidCunyEmail = (email) =>
  ALLOWED_DOMAINS.some(d => email.toLowerCase().trim().endsWith(`@${d}`));
const generateCode = () => String(Math.floor(100000 + Math.random() * 900000));

// ── Email transporter ─────────────────────────────────────────────────────────
// Requires in backend/.env:
//   EMAIL_USER=you@gmail.com
//   EMAIL_PASS=xxxx xxxx xxxx xxxx   (Gmail App Password — NOT your normal password)
//   EMAIL_FROM=Hunter Study Spaces <you@gmail.com>  (optional)
//
// Gmail App Passwords: https://myaccount.google.com/apppasswords
// (Requires 2-Step Verification to be enabled on the sending Gmail account)

const emailTransporter = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      connectionTimeout: 8_000,
      greetingTimeout:   8_000,
      socketTimeout:     12_000,
    })
  : null;

if (emailTransporter) {
  console.log(`[EMAIL] Transporter created for ${process.env.EMAIL_USER}`);
  emailTransporter.verify((err) => {
    if (err) console.error('[EMAIL] SMTP connection failed:', err.message);
    else     console.log('[EMAIL] SMTP connection verified — ready to send');
  });
} else {
  console.warn('[EMAIL] EMAIL_USER / EMAIL_PASS not set — running in dev/console mode');
}

// Returns true if email was sent, false if console fallback was used.
async function sendVerificationEmail(email, code) {
  if (!emailTransporter) {
    console.log(`\n[DEV] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[DEV] Verification code for ${email}`);
    console.log(`[DEV] Code: ${code}`);
    console.log(`[DEV] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    return false;
  }
  console.log(`[EMAIL] Sending verification email to ${email}...`);
  const info = await emailTransporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: 'Hunter Study Spaces – Your Verification Code',
    text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#1d4ed8">Hunter Study Spaces</h2>
        <p>Use the code below to verify your email address.</p>
        <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
          <span style="font-size:36px;letter-spacing:8px;font-weight:700;color:#0f172a">${code}</span>
        </div>
        <p style="color:#64748b;font-size:14px">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`,
  });
  console.log(`[EMAIL] Sent successfully to ${email} — messageId: ${info.messageId}`);
  return true;
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

// GET /api/auth/test-email
// Tests the SMTP connection and optionally sends a real email.
// Usage: GET /api/auth/test-email            → connection test only
//        GET /api/auth/test-email?to=you@x   → also sends a test message
app.get('/api/auth/test-email', async (req, res) => {
  if (!emailTransporter) {
    return res.json({
      ok: false,
      mode: 'dev-console',
      message: 'EMAIL_USER / EMAIL_PASS not configured — codes are printed to the server console.',
    });
  }
  try {
    await new Promise((resolve, reject) =>
      emailTransporter.verify((err, ok) => (err ? reject(err) : resolve(ok)))
    );
    const result = { ok: true, mode: 'smtp', smtpUser: process.env.EMAIL_USER, message: 'SMTP connection OK.' };

    const to = req.query.to;
    if (to) {
      const info = await emailTransporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to,
        subject: 'Hunter Study Spaces — Email Test',
        text: 'This is a test email from the Hunter Study Spaces backend.',
      });
      result.testEmailSent = true;
      result.testEmailTo = to;
      result.messageId = info.messageId;
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, code: err.code });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });

  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email, and password are required.' });

  const normalizedEmail = email.toLowerCase().trim();
  if (!isValidCunyEmail(normalizedEmail))
    return res.status(400).json({ error: 'Email must be a Hunter/CUNY address (@login.cuny.edu, @hunter.cuny.edu, or @myhunter.cuny.edu).' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const existing = await db.collection('students').findOne({ email: normalizedEmail });
    if (existing?.isVerified)
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateCode();
    const verificationCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    if (existing) {
      await db.collection('students').updateOne(
        { email: normalizedEmail },
        { $set: { name: name.trim(), passwordHash, verificationCode: code, verificationCodeExpiresAt } }
      );
    } else {
      await db.collection('students').insertOne({
        name: name.trim(), email: normalizedEmail, passwordHash,
        isVerified: false, verificationCode: code, verificationCodeExpiresAt,
        favorites: [], createdAt: new Date(),
      });
    }

    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(normalizedEmail, code);
    } catch (emailErr) {
      console.error('[EMAIL] Failed to send verification email:', emailErr.message);
      console.log(`[DEV FALLBACK] Verification code for ${normalizedEmail}: ${code}`);
    }

    return res.status(200).json({
      message: emailSent
        ? 'Verification code sent to your email.'
        : 'Account created. Check the server console for your verification code (email unavailable).',
      email: normalizedEmail,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });

  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

  const normalizedEmail = email.toLowerCase().trim();
  try {
    const student = await db.collection('students').findOne({ email: normalizedEmail });
    if (!student) return res.status(404).json({ error: 'No account found for this email.' });
    if (student.isVerified) return res.status(400).json({ error: 'Account already verified. Please log in.' });
    if (!student.verificationCode || !student.verificationCodeExpiresAt)
      return res.status(400).json({ error: 'No pending verification. Please request a new code.' });
    if (new Date() > student.verificationCodeExpiresAt)
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    if (student.verificationCode !== code.trim())
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });

    await db.collection('students').updateOne(
      { email: normalizedEmail },
      { $set: { isVerified: true }, $unset: { verificationCode: '', verificationCodeExpiresAt: '' } }
    );

    const token = jwt.sign({ email: normalizedEmail, userId: student._id.toString() }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(200).json({ student: { name: student.name, email: normalizedEmail }, token });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/resend-code', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const normalizedEmail = email.toLowerCase().trim();
  try {
    const student = await db.collection('students').findOne({ email: normalizedEmail });
    if (!student) return res.status(404).json({ error: 'No account found for this email.' });
    if (student.isVerified) return res.status(400).json({ error: 'Account already verified.' });

    const code = generateCode();
    const verificationCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await db.collection('students').updateOne(
      { email: normalizedEmail },
      { $set: { verificationCode: code, verificationCodeExpiresAt } }
    );

    let emailSent = false;
    try {
      emailSent = await sendVerificationEmail(normalizedEmail, code);
    } catch (emailErr) {
      console.error('[EMAIL] Failed to resend verification email:', emailErr.message);
      console.log(`[DEV FALLBACK] New verification code for ${normalizedEmail}: ${code}`);
    }

    return res.status(200).json({
      message: emailSent
        ? 'New code sent! Check your email.'
        : 'New code generated. Check the server console (email unavailable).',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const normalizedEmail = email.toLowerCase().trim();
  if (!isValidCunyEmail(normalizedEmail))
    return res.status(400).json({ error: 'Email must be a Hunter/CUNY address.' });

  try {
    const student = await db.collection('students').findOne({ email: normalizedEmail });
    if (!student) return res.status(404).json({ error: 'No account found. Please sign up first.' });

    const passwordMatch = await bcrypt.compare(password, student.passwordHash);
    if (!passwordMatch) return res.status(401).json({ error: 'Incorrect password.' });

    if (!student.isVerified) {
      const code = generateCode();
      const verificationCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await db.collection('students').updateOne(
        { email: normalizedEmail },
        { $set: { verificationCode: code, verificationCodeExpiresAt } }
      );
      await sendVerificationEmail(normalizedEmail, code);
      return res.status(403).json({ error: 'Email not verified.', needsVerification: true, email: normalizedEmail });
    }

    const token = jwt.sign({ email: normalizedEmail, userId: student._id.toString() }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(200).json({ student: { name: student.name, email: normalizedEmail }, token });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided.' });

  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload.email) return res.status(401).json({ error: 'Invalid token.' });

    let name = 'Hunter Student';
    if (db) {
      const student = await db.collection('students').findOne({ email: payload.email });
      if (student) name = student.name;
    }
    return res.status(200).json({ student: { name, email: payload.email } });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
});

// ── Favorites endpoints ───────────────────────────────────────────────────────

app.get('/api/favorites', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  try {
    const student = await db.collection('students').findOne({ email: req.user.email });
    return res.json(student?.favorites || []);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/favorites', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ error: 'roomId is required.' });
  try {
    await db.collection('students').updateOne(
      { email: req.user.email },
      { $addToSet: { favorites: roomId } }
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete('/api/favorites/:roomId', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  try {
    await db.collection('students').updateOne(
      { email: req.user.email },
      { $pull: { favorites: req.params.roomId } }
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── Occupancy endpoints ───────────────────────────────────────────────────────
// Inspired by teammate's V2server.js check-in concept, rebuilt with JWT auth
// and time-bounded expiry instead of the old EMPLID + 2-hour cutoff approach.

// GET /api/occupancy/me  →  the logged-in user's current active room report
app.get('/api/occupancy/me', requireAuth, async (req, res) => {
  if (!db) return res.json(null);
  try {
    const report = await db.collection('occupancy_reports').findOne({
      userId: req.user.userId,
      expiresAt: { $gt: new Date() },
    });
    if (!report) return res.json(null);
    return res.json({
      room:      report.room,
      building:  report.building,
      expiresAt: report.expiresAt,
      createdAt: report.createdAt,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/occupancy/me  →  clear the logged-in user's active report (any room)
app.delete('/api/occupancy/me', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  try {
    await db.collection('occupancy_reports').deleteMany({ userId: req.user.userId });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/occupancy/:room  →  active student reports (optional auth to get myReport)
app.get('/api/occupancy/:room', async (req, res) => {
  if (!db) return res.json({ count: 0, myReport: null, reports: [] });
  try {
    const room = decodeURIComponent(req.params.room);
    const reports = await db.collection('occupancy_reports').find({
      room, expiresAt: { $gt: new Date() },
    }).toArray();

    let myReport = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        const mine = reports.find(r => r.userId === payload.userId);
        if (mine) myReport = { expiresAt: mine.expiresAt };
      } catch { /* invalid token — ignore */ }
    }

    return res.json({
      count: reports.length,
      myReport,
      reports: reports.map(r => ({ userName: r.userName, expiresAt: r.expiresAt })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/occupancy  →  create or update the current user's report (upsert by userId+room)
app.post('/api/occupancy', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  const { room, building, duration, extend } = req.body;
  if (!room || !duration) return res.status(400).json({ error: 'room and duration are required.' });

  const now = new Date();
  // When extend=true, add duration to the existing report's expiresAt (not from now)
  let baseTime = now;
  if (extend && duration !== 'next_class') {
    try {
      const existing = await db.collection('occupancy_reports').findOne({
        userId: req.user.userId, room, expiresAt: { $gt: now },
      });
      if (existing) baseTime = existing.expiresAt;
    } catch { /* fall back to now */ }
  }

  let expiresAt;
  if (duration === '1hour') {
    expiresAt = new Date(baseTime.getTime() + 60 * 60 * 1000);
  } else if (duration === '2hours') {
    expiresAt = new Date(baseTime.getTime() + 2 * 60 * 60 * 1000);
  } else if (duration === 'next_class') {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayAbbrev = DAY_NAME_TO_ABBREV[dayNames[now.getDay()]] ?? 'Mo';
    const timeMinutes = now.getHours() * 60 + now.getMinutes();
    const { availableFor } = computeAvailability(room, dayAbbrev, timeMinutes, todayDateStr());
    expiresAt = availableFor !== null
      ? new Date(now.getTime() + availableFor * 60 * 1000)
      : (() => { const d = new Date(now); d.setHours(23, 59, 59, 0); return d; })();
  } else {
    return res.status(400).json({ error: 'duration must be 1hour, 2hours, or next_class.' });
  }

  try {
    const student = await db.collection('students').findOne({ email: req.user.email });
    const userName = student?.name || req.user.email;

    // Enforce one active report per user — remove any reports for other rooms
    await db.collection('occupancy_reports').deleteMany({
      userId: req.user.userId, room: { $ne: room },
    });

    await db.collection('occupancy_reports').updateOne(
      { userId: req.user.userId, room },
      { $set: { userId: req.user.userId, userName, room, building: building || null, expiresAt, createdAt: now } },
      { upsert: true }
    );
    return res.json({ success: true, expiresAt });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/occupancy/:room  →  clear the current user's report for a specific room
app.delete('/api/occupancy/:room', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable.' });
  try {
    const room = decodeURIComponent(req.params.room);
    await db.collection('occupancy_reports').deleteOne({ userId: req.user.userId, room });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── Schedule date/room helpers ────────────────────────────────────────────────

// Parse "MM/DD/YYYY - MM/DD/YYYY" → { meetingStartDate: "YYYY-MM-DD", meetingEndDate: "YYYY-MM-DD" }
function parseMeetingDates(meetingDates) {
  if (!meetingDates) return { meetingStartDate: null, meetingEndDate: null };
  const m = meetingDates.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return { meetingStartDate: null, meetingEndDate: null };
  return {
    meetingStartDate: `${m[3]}-${m[1]}-${m[2]}`,
    meetingEndDate:   `${m[6]}-${m[4]}-${m[5]}`,
  };
}

// Returns false for purely online rooms (Online-Synchronous, Online-Asynchronous) and Off Campus.
// Hybrid modes that have a physical room are kept — the building filter handles them.
// Also rejects corrupt scraper entries where two room strings were concatenated
// (e.g. "West Bldg W522North Bldg C115" contains two building names).
const BUILDING_NAME_RE = /\b(North|West|East)\s+Bldg\b|ThomHunter|Silberman|Baker|Roosevelt/gi;
function isPhysicalRoom(doc) {
  const room = (doc.room || '').trim();
  const mode = (doc.instructionMode || '').trim();
  if (!room || /\bTBA\b/i.test(room)) return false;
  if (/^online/i.test(room)) return false;
  if (/^online\s+(synchronous|asynchronous|mix)/i.test(mode)) return false;
  if ((room.match(BUILDING_NAME_RE) || []).length > 1) return false;
  return true;
}

// YYYY-MM-DD string comparison (ISO lexicographic order works for date-only strings).
// If either boundary is missing we assume the class is always in-range.
function isDateInRange(selectedDate, meetingStartDate, meetingEndDate) {
  if (!selectedDate || !meetingStartDate || !meetingEndDate) return true;
  return selectedDate >= meetingStartDate && selectedDate <= meetingEndDate;
}

// Today's date as YYYY-MM-DD in local time (avoids UTC-shift bugs).
function todayDateStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── JSON schedule helpers ─────────────────────────────────────────────────────

function getBuildingFromRoom(room) {
  if (!room) return null;
  const r = room.trim();
  if (/^North\s+Bldg/i.test(r))  return 'North Building';
  if (/^West\s+Bldg/i.test(r))   return 'West Building';
  if (/^East\s+Bldg/i.test(r))   return 'East Building';
  if (/^ThomHunter/i.test(r))    return 'Thomas Hunter Hall';
  if (/^Baker/i.test(r))         return 'Baker Building';
  if (/^Silberman/i.test(r))     return 'Silberman';
  if (/^Roosevelt/i.test(r))     return 'Roosevelt House';
  return null;
}

function parseTimeToMinutes(timeStr) {
  const m = timeStr.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

const DAY_ABBREVS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function parseDaysAndTime(str) {
  const spIdx = str.indexOf(' ');
  if (spIdx === -1) return null;
  const daysStr = str.slice(0, spIdx);
  const timePart = str.slice(spIdx + 1);

  const days = [];
  for (let i = 0; i < daysStr.length; i += 2) {
    const ab = daysStr.slice(i, i + 2);
    if (DAY_ABBREVS.includes(ab)) days.push(ab);
  }
  if (!days.length) return null;

  const parts = timePart.split(' - ');
  if (parts.length < 2) return null;
  const startMinutes = parseTimeToMinutes(parts[0].trim());
  const endMinutes   = parseTimeToMinutes(parts[1].trim());
  if (startMinutes === null || endMinutes === null) return null;

  return { days, startMinutes, endMinutes };
}

function getRoomNumber(room) {
  const parts = room.trim().split(/\s+/);
  return parts[parts.length - 1];
}

// inferFloor(roomNumber, building)
//
// Returns a floor value ('C', 'B', or a number) from the room code.
// Must be called with the *last word* of the full room string (getRoomNumber output).
//
// Special cases:
//   'C' prefix  → Cellar  (North Bldg C002, Silberman C-05)
//   West Bldg B/WB prefix → Basement ('B') e.g. B301, WB126
//   East Bldg B1/B2 → Library basement stacks ('B')
//
// Standard digit rule (prevents the old 5-digit bug where "11003" → floor 110):
//   ≤3 digits → first digit is floor:  "714" → 7,  "118" → 1
//   ≥4 digits → first TWO digits:      "1130" → 11, "11003" → 11
function inferFloor(roomNumber, building) {
  const trimmed = roomNumber.trim();

  if (/^C/i.test(trimmed)) return 'C';

  // West Building basement rooms: B301, B401, WB126
  if (building === 'West Building' && (/^WB\d/i.test(trimmed) || /^B\d/i.test(trimmed))) return 'B';

  // East Building library basement stacks: B1, B2
  if (building === 'East Building' && /^B[12]$/i.test(trimmed)) return 'B';

  const m = trimmed.match(/\d+/);
  if (!m) return 1;
  const digits = m[0];
  if (digits.length <= 3) return parseInt(digits[0]) || 1;
  return parseInt(digits.slice(0, 2)) || 1;
}

// Kept for call sites that don't have building context (schedule processing).
const getFloor = (roomNumber) => inferFloor(roomNumber, null);

function minutesToTimeStr(minutes) {
  const h    = Math.floor(minutes / 60);
  const min  = minutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${min.toString().padStart(2, '0')} ${ampm}`;
}

// ── Load + preprocess schedule ─────────────────────────────────────────────────

let schedule     = []; // Summer 2026 — used only for current-term occupancy
let roomInventory = []; // Spring 2026 + supplemented — source of truth for all known rooms

function processRaw(raw) {
  return raw
    .filter(s => isPhysicalRoom(s))
    .map(s => {
      const { meetingStartDate, meetingEndDate } = parseMeetingDates(s.meetingDates);
      return {
        ...s,
        building: getBuildingFromRoom(s.room),
        meetingStartDate,
        meetingEndDate,
        timeBlocks: (s.daysAndTimes || []).map(parseDaysAndTime).filter(Boolean),
      };
    })
    .filter(s => s.building !== null);
}

async function loadSchedule() {
  if (db) {
    try {
      const raw = await db.collection('schedules').find({}, { projection: { _id: 0 } }).toArray();
      if (raw.length > 0) {
        schedule = processRaw(raw);
        console.log(`Loaded ${schedule.length} sections from MongoDB (${raw.length - schedule.length} skipped)`);
        return;
      }
    } catch (err) {
      console.warn('Could not load schedule from MongoDB:', err.message);
    }
  }

  try {
    const raw = JSON.parse(
      readFileSync(path.join(__dirname, 'data', 'hunter-all-subjects-schedule.json'), 'utf8')
    );
    schedule = processRaw(raw);
    console.log(`Loaded ${schedule.length} sections from JSON (${raw.length - schedule.length} skipped)`);
  } catch (err) {
    console.warn('Could not load schedule JSON:', err.message);
  }
}

// Adds any Summer-schedule rooms that aren't already in the inventory.
// Ensures rooms that exist only in the current term are still tracked.
function supplementInventoryFromSchedule() {
  const known = new Set(roomInventory.map(r => r.room));
  let added = 0;
  for (const s of schedule) {
    if (!known.has(s.room)) {
      const roomNumber = getRoomNumber(s.room);
      roomInventory.push({
        room:               s.room,
        building:           s.building,
        floor:              inferFloor(roomNumber, s.building),
        normalizedRoomName: s.room.toLowerCase().replace(/\s+/g, '-'),
      });
      known.add(s.room);
      added++;
    }
  }
  if (added > 0) console.log(`  + ${added} Summer-only rooms added to inventory`);
}

async function loadRoomInventory() {
  // 1. Try MongoDB room_inventory collection (populated by npm run seed:rooms)
  if (db) {
    try {
      const raw = await db.collection('room_inventory').find({}, { projection: { _id: 0 } }).toArray();
      if (raw.length > 0) {
        const clean = raw.filter(r => (r.room?.match(BUILDING_NAME_RE) || []).length <= 1);
        const term  = raw[0]?.sourceTerm ?? 'unknown';
        // Always recompute floor from the room name — do NOT trust stored values,
        // which may have been generated by an older buggy version of inferFloor.
        roomInventory = clean.map(r => {
          const building = r.building || getBuildingFromRoom(r.room);
          return { ...r, building, floor: inferFloor(getRoomNumber(r.room), building) };
        });
        console.log(`Loaded ${roomInventory.length} rooms from MongoDB room_inventory (${raw.length - clean.length} corrupt rejected, source: ${term})`);
        supplementInventoryFromSchedule();
        return;
      }
    } catch (err) {
      console.warn('Could not load room_inventory from MongoDB:', err.message);
    }
  }

  // 2. Try inventory JSON file (generated by npm run scrape:inventory)
  try {
    const raw = JSON.parse(
      readFileSync(path.join(__dirname, 'data', 'hunter-room-inventory-spring-2026.json'), 'utf8')
    );
    if (raw.length > 0) {
      const clean = raw.filter(r => (r.room?.match(BUILDING_NAME_RE) || []).length <= 1);
      // Recompute floor from room name — do NOT trust what was stored in the JSON.
      roomInventory = clean.map(r => {
        const building = r.building || getBuildingFromRoom(r.room);
        return { ...r, building, floor: inferFloor(getRoomNumber(r.room), building) };
      });
      console.log(`Loaded ${roomInventory.length} rooms from inventory JSON (${raw.length - clean.length} corrupt rejected)`);
      supplementInventoryFromSchedule();
      return;
    }
  } catch { /* fall through */ }

  // 3. Fall back to deriving rooms from the current Summer schedule only
  console.warn('No room inventory found — deriving rooms from Summer schedule (limited coverage)');
  const seen = new Set();
  for (const s of schedule) {
    if (!seen.has(s.room)) {
      seen.add(s.room);
      const roomNumber = getRoomNumber(s.room);
      roomInventory.push({
        room:               s.room,
        building:           s.building,
        floor:              inferFloor(roomNumber, s.building),
        normalizedRoomName: s.room.toLowerCase().replace(/\s+/g, '-'),
      });
    }
  }
  console.log(`Derived ${roomInventory.length} rooms from current schedule`);
}

const DAY_NAME_TO_ABBREV = {
  Monday: 'Mo', Tuesday: 'Tu', Wednesday: 'We', Thursday: 'Th',
  Friday: 'Fr', Saturday: 'Sa', Sunday: 'Su',
};

function computeAvailability(room, dayAbbrev, timeMinutes, selectedDate) {
  let nextStart = Infinity;
  let nextTopic = null;
  for (const s of schedule) {
    if (s.room !== room) continue;
    if (!isDateInRange(selectedDate, s.meetingStartDate, s.meetingEndDate)) continue;
    for (const b of s.timeBlocks) {
      if (b.days.includes(dayAbbrev) && b.startMinutes > timeMinutes) {
        if (b.startMinutes < nextStart) {
          nextStart = b.startMinutes;
          nextTopic = s.courseTopic || s.subjectCode || null;
        }
      }
    }
  }
  if (nextStart === Infinity) {
    return { nextClass: null, availableFor: null, nextTopic: null };
  }
  return {
    nextClass:    minutesToTimeStr(nextStart),
    availableFor: nextStart - timeMinutes,
    nextTopic,
  };
}

// ── JSON-based API routes ─────────────────────────────────────────────────────

// GET /api/rooms/schedule?room=...&day=Monday&time=14:30&date=2026-06-10  →  upcoming classes for a room
app.get('/api/rooms/schedule', (req, res) => {
  const { room, day, time, date } = req.query;
  if (!room || !day || !time) {
    return res.status(400).json({ error: 'room, day, and time are required' });
  }
  const dayAbbrev   = DAY_NAME_TO_ABBREV[day] ?? day;
  const [hStr, mStr] = time.split(':');
  const timeMinutes  = parseInt(hStr) * 60 + parseInt(mStr || '0');
  const selectedDate = date || todayDateStr();

  const upcoming = [];
  const seenTimes   = new Set();
  const seenCourses = new Set();

  for (const s of schedule) {
    if (s.room !== room) continue;
    if (!isDateInRange(selectedDate, s.meetingStartDate, s.meetingEndDate)) continue;
    for (const b of s.timeBlocks) {
      if (b.days.includes(dayAbbrev) && b.endMinutes > timeMinutes) {
        const courseName = s.courseTopic || s.subjectCode;
        if (seenTimes.has(b.startMinutes) || seenCourses.has(courseName)) continue;
        seenTimes.add(b.startMinutes);
        seenCourses.add(courseName);
        upcoming.push({
          courseTopic:  courseName,
          subjectCode:  s.subjectCode,
          section:      s.section,
          instructor:   s.instructor,
          startTime:    minutesToTimeStr(b.startMinutes),
          endTime:      minutesToTimeStr(b.endMinutes),
          startMinutes: b.startMinutes,
          isCurrent:    b.startMinutes <= timeMinutes,
        });
      }
    }
  }

  upcoming.sort((a, b) => a.startMinutes - b.startMinutes);
  res.json(upcoming.map(({ startMinutes, ...rest }) => rest));
});

// GET /api/rooms/buildings  →  ["Baker Building", "East Building", ...]  (from full inventory)
app.get('/api/rooms/buildings', (req, res) => {
  const buildings = [...new Set(roomInventory.map(r => r.building).filter(Boolean))].sort();
  res.json(buildings);
});

// GET /api/rooms/available?building=West%20Building&day=Tuesday&time=14:30&floor=3&date=2026-06-10
app.get('/api/rooms/available', async (req, res) => {
  const { building, day, time, floor, date } = req.query;
  if (!day || !time) {
    return res.status(400).json({ error: 'day and time query params are required' });
  }

  const dayAbbrev    = DAY_NAME_TO_ABBREV[day] ?? day;
  const [hStr, mStr] = time.split(':');
  const timeMinutes  = parseInt(hStr) * 60 + parseInt(mStr || '0');
  const floorFilter  = floor ? floor.toString().toUpperCase() : null;
  const selectedDate = date || todayDateStr();

  const occupied = new Set();
  for (const s of schedule) {
    if (building && s.building !== building) continue;
    if (!isDateInRange(selectedDate, s.meetingStartDate, s.meetingEndDate)) continue;
    for (const b of s.timeBlocks) {
      if (b.days.includes(dayAbbrev) && timeMinutes >= b.startMinutes && timeMinutes < b.endMinutes) {
        occupied.add(s.room);
      }
    }
  }

  // Room list comes from inventory (Spring + supplemented) — not Summer schedule
  const results = [];
  for (const r of roomInventory) {
    if (building && r.building !== building) continue;
    if (occupied.has(r.room)) continue;
    const roomNumber = getRoomNumber(r.room);
    const roomFloor  = r.floor;
    if (floorFilter !== null && String(roomFloor).toUpperCase() !== floorFilter) continue;
    const { nextClass, availableFor } = computeAvailability(r.room, dayAbbrev, timeMinutes, selectedDate);
    results.push({
      id:                        r.room,
      building:                  r.building,
      roomNumber,
      floor:                     roomFloor,
      availableFor,
      availableForMinutes:       availableFor,
      nextClass,
      nextClassStart:            nextClass,
      noMoreClassesToday:        nextClass === null,
      type:                      'Classroom',
      isAvailable:               true,
      studentOccupancyCount:     0,
      isStudentReportedOccupied: false,
    });
  }

  // Enrich with live student occupancy counts
  if (db && results.length > 0) {
    try {
      const roomIds = results.map(r => r.id);
      const docs = await db.collection('occupancy_reports').find({
        room: { $in: roomIds }, expiresAt: { $gt: new Date() },
      }).toArray();
      const byRoom = new Map();
      for (const d of docs) byRoom.set(d.room, (byRoom.get(d.room) || 0) + 1);
      for (const r of results) {
        r.studentOccupancyCount     = byRoom.get(r.id) || 0;
        r.isStudentReportedOccupied = r.studentOccupancyCount > 0;
      }
    } catch { /* non-fatal: occupancy data unavailable */ }
  }

  results.sort((a, b) => (b.availableFor ?? Infinity) - (a.availableFor ?? Infinity));
  res.json(results);
});

// GET /api/debug/summary
app.get('/api/debug/summary', (_req, res) => {
  const now      = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayAbbrev    = DAY_NAME_TO_ABBREV[dayNames[now.getDay()]] ?? 'Mo';
  const timeMinutes  = now.getHours() * 60 + now.getMinutes();
  const today        = todayDateStr();

  const occupied = new Set();
  for (const s of schedule) {
    if (!isDateInRange(today, s.meetingStartDate, s.meetingEndDate)) continue;
    for (const b of s.timeBlocks) {
      if (b.days.includes(dayAbbrev) && timeMinutes >= b.startMinutes && timeMinutes < b.endMinutes) {
        occupied.add(s.room);
      }
    }
  }

  const buildings   = [...new Set(roomInventory.map(r => r.building).filter(Boolean))].sort();
  const codes       = [...new Set(schedule.map(s => s.subjectCode))].sort();
  const inventorySource = roomInventory[0]?.sourceTerm ?? 'derived from schedule';

  res.json({
    currentScheduleTerm:     'Summer 2026',
    totalScheduleSections:   schedule.length,
    roomInventorySource:     inventorySource,
    totalInventoryRooms:     roomInventory.length,
    uniqueBuildings:         buildings,
    currentlyOccupiedRooms:  [...occupied].sort(),
    sampleInventoryRooms:    roomInventory.slice(0, 10).map(r => r.room),
    scheduleSubjectCodes:    codes,
  });
});

// GET /api/debug/room/:room?day=Monday&time=17:30&date=2026-06-10
app.get('/api/debug/room/:room', (req, res) => {
  const roomId  = req.params.room;
  const day     = req.query.day  || 'Monday';
  const time    = req.query.time || '12:00';
  const date    = req.query.date || todayDateStr();

  const dayAbbrev    = DAY_NAME_TO_ABBREV[day] ?? day;
  const [hStr, mStr] = time.split(':');
  const timeMinutes  = parseInt(hStr) * 60 + parseInt(mStr || '0');

  const sections = schedule.filter(s => s.room === roomId);
  const blocks   = sections.flatMap(s =>
    s.timeBlocks.map(b => ({
      courseTopic:      s.courseTopic,
      subjectCode:      s.subjectCode,
      meetingDates:     s.meetingDates,
      meetingStartDate: s.meetingStartDate,
      meetingEndDate:   s.meetingEndDate,
      dateInRange:      isDateInRange(date, s.meetingStartDate, s.meetingEndDate),
      days:             b.days,
      startTime:        minutesToTimeStr(b.startMinutes),
      endTime:          minutesToTimeStr(b.endMinutes),
      startMinutes:     b.startMinutes,
      endMinutes:       b.endMinutes,
    }))
  );

  const isOccupied = blocks.some(b =>
    b.dateInRange &&
    b.days.includes(dayAbbrev) &&
    timeMinutes >= b.startMinutes &&
    timeMinutes < b.endMinutes
  );
  const avail = computeAvailability(roomId, dayAbbrev, timeMinutes, date);

  const upcomingOnDate = blocks
    .filter(b => b.dateInRange && b.days.includes(dayAbbrev) && b.endMinutes > timeMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  res.json({
    room:           roomId,
    queriedDay:     day,
    queriedTime:    time,
    queriedDate:    date,
    totalSections:  sections.length,
    allBlocks:      blocks,
    isOccupiedAt:   isOccupied,
    availability:   avail,
    upcomingOnDate,
  });
});

// GET /api/rooms/all  →  all unique rooms with availability (favorites display + live stats)
app.get('/api/rooms/all', async (req, res) => {
  const { day, time, date } = req.query;
  let dayAbbrev, timeMinutes, selectedDate;
  if (day && time) {
    dayAbbrev = DAY_NAME_TO_ABBREV[day] ?? day;
    const [hStr, mStr] = time.split(':');
    timeMinutes = parseInt(hStr) * 60 + parseInt(mStr || '0');
    selectedDate = date || todayDateStr();
  } else {
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dayAbbrev    = DAY_NAME_TO_ABBREV[dayNames[now.getDay()]] ?? 'Mo';
    timeMinutes  = now.getHours() * 60 + now.getMinutes();
    selectedDate = todayDateStr();
  }

  // Track which rooms have a class happening right now on the selected date
  const occupied = new Set();
  for (const s of schedule) {
    if (!isDateInRange(selectedDate, s.meetingStartDate, s.meetingEndDate)) continue;
    for (const b of s.timeBlocks) {
      if (b.days.includes(dayAbbrev) && timeMinutes >= b.startMinutes && timeMinutes < b.endMinutes) {
        occupied.add(s.room);
      }
    }
  }

  // Room list from inventory — includes Spring rooms with no Summer classes
  const roomMap = new Map();
  for (const r of roomInventory) {
    if (!roomMap.has(r.room)) {
      const roomNumber = getRoomNumber(r.room);
      const { nextClass, availableFor } = computeAvailability(r.room, dayAbbrev, timeMinutes, selectedDate);
      roomMap.set(r.room, {
        id:                        r.room,
        building:                  r.building,
        roomNumber,
        floor:                     r.floor,
        availableFor,
        availableForMinutes:       availableFor,
        nextClass,
        nextClassStart:            nextClass,
        noMoreClassesToday:        nextClass === null,
        type:                      'Classroom',
        isAvailable:               !occupied.has(r.room),
        studentOccupancyCount:     0,
        isStudentReportedOccupied: false,
      });
    }
  }

  const rooms = [...roomMap.values()].sort((a, b) =>
    a.building.localeCompare(b.building) || a.roomNumber.localeCompare(b.roomNumber)
  );

  // Enrich with live student occupancy counts
  if (db && rooms.length > 0) {
    try {
      const roomIds = rooms.map(r => r.id);
      const docs = await db.collection('occupancy_reports').find({
        room: { $in: roomIds }, expiresAt: { $gt: new Date() },
      }).toArray();
      const byRoom = new Map();
      for (const d of docs) byRoom.set(d.room, (byRoom.get(d.room) || 0) + 1);
      for (const r of rooms) {
        r.studentOccupancyCount     = byRoom.get(r.id) || 0;
        r.isStudentReportedOccupied = r.studentOccupancyCount > 0;
      }
    } catch { /* non-fatal */ }
  }

  res.json(rooms);
});

// ── MongoDB connection ────────────────────────────────────────────────────────

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log('Connected to MongoDB');
  } catch (error) {
    console.warn('MongoDB unavailable — running without database:', error.message);
  }
}

// ── MongoDB-based routes (legacy) ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ message: 'Hunter Study Space Finder API is running' });
});

app.get('/api/available-rooms', async (req, res) => {
  try {
    const { day, time } = req.query;
    if (!day || !time) return res.status(400).json({ error: 'day and time are required' });
    const busyClasses = await db.collection('classes').find({
      days: day, startTime: { $lte: time }, endTime: { $gt: time },
    }).toArray();
    const busyRoomIds = busyClasses.map(c => c.roomId);
    const available = await db.collection('rooms').find({ _id: { $nin: busyRoomIds } }).toArray();
    res.json(available);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await db.collection('rooms').find({}).toArray();
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const room = {
      floor: req.body.floor, building: req.body.building,
      capacity: req.body.capacity, room_type: req.body.room_type, room_number: req.body.room_number,
    };
    const result = await db.collection('rooms').insertOne(room);
    res.status(201).json({ _id: result.insertedId, ...room });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/rooms/:roomId/classes', async (req, res) => {
  try {
    const classes = await db.collection('classes').find({
      roomId: new ObjectId(req.params.roomId),
    }).toArray();
    res.json(classes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/classes', async (req, res) => {
  try {
    const classes = await db.collection('classes').find({}).toArray();
    res.json(classes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/classes', async (req, res) => {
  try {
    let roomId = req.body.roomId;
    if (!roomId && req.body.roomNumber) {
      const room = await db.collection('rooms').findOne({ room_number: req.body.roomNumber });
      if (room) {
        roomId = room._id;
      } else {
        const newRoom = {
          floor: req.body.floor || 1, building: req.body.building || 'Unknown',
          capacity: req.body.capacity || 30, room_type: req.body.roomType || 'Unknown',
          room_number: req.body.roomNumber,
        };
        const r = await db.collection('rooms').insertOne(newRoom);
        roomId = r.insertedId;
      }
    }
    if (!roomId) return res.status(400).json({ error: 'roomId or roomNumber is required' });
    const classObj = {
      roomId: new ObjectId(roomId), className: req.body.className,
      days: req.body.days, startTime: req.body.startTime, endTime: req.body.endTime,
    };
    const result = await db.collection('classes').insertOne(classObj);
    res.status(201).json({ _id: result.insertedId, ...classObj });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/filter-rooms', async (req, res) => {
  try {
    const { day, time, room_type, building } = req.query;
    if (!day || !time) return res.status(400).json({ error: 'day and time are required' });
    const busyClasses = await db.collection('classes').find({
      days: day, startTime: { $lte: time }, endTime: { $gt: time },
    }).toArray();
    const busyRoomIds = busyClasses.map(c => c.roomId);
    const filter = { _id: { $nin: busyRoomIds } };
    if (room_type) filter.room_type = room_type;
    if (building) filter.building = building;
    const rooms = await db.collection('rooms').find(filter).toArray();
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await connectDB();
  await loadSchedule();
  await loadRoomInventory(); // must run after loadSchedule (supplements from schedule)
  // TTL index: MongoDB auto-deletes expired occupancy reports
  if (db) {
    try {
      await db.collection('occupancy_reports').createIndex(
        { expiresAt: 1 }, { expireAfterSeconds: 0 }
      );
    } catch { /* index may already exist */ }
  }
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

start();
