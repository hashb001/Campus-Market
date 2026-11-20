require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { User, Image, Listing, Contact, CATEGORIES, LISTING_TYPES } = require('./models');
const { sendVerificationCode } = require('./mailer');

// ======================
//   CONFIG
// ======================

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'northsouth.edu').toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
// Optional: only needed if the frontend is hosted on a different origin than this server.
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || '')
    .split(',').map(o => o.trim()).filter(Boolean);

const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

if (!MONGO_URI) {
    console.error('MONGO_URI is not set. Copy backend/.env.example to backend/.env and fill it in.');
    process.exit(1);
}
if (!SESSION_SECRET) {
    if (IS_PROD) {
        console.error('SESSION_SECRET must be set in production.');
        process.exit(1);
    }
    console.warn('SESSION_SECRET not set, using an insecure development secret.');
}

// ======================
//   APP SETUP
// ======================

const app = express();
const server = http.createServer(app);
const io = new Server(server, CLIENT_ORIGINS.length ? { cors: { origin: CLIENT_ORIGINS, credentials: true } } : {});

app.set('trust proxy', 1); // Render / most hosts sit behind a proxy

if (CLIENT_ORIGINS.length) {
    app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));
}
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

const sessionMiddleware = session({
    name: 'cm.sid',
    secret: SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI, ttl: 60 * 60 * 24 * 7 }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7,
        httpOnly: true,
        secure: IS_PROD,
        // Cross-site cookies are only needed when the frontend lives on another origin
        sameSite: CLIENT_ORIGINS.length && IS_PROD ? 'none' : 'lax'
    }
});
app.use(sessionMiddleware);

// Serve the frontend from the same origin so cookies, sockets and images all just work
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ======================
//   HELPERS
// ======================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(null, true);
        cb(new Error('Only JPEG, PNG, WEBP or GIF images are allowed'));
    }
});

// Wrap multer so its errors come back as JSON 400s
const uploadImage = (req, res, next) => upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : err.message;
    res.status(400).json({ error: msg });
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const isAdminEmail = (email) => ADMIN_EMAILS.includes(email.toLowerCase());
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

function isAllowedEmail(email) {
    const at = email.lastIndexOf('@');
    return at > 0 && email.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}

function sessionUser(user) {
    return { id: user._id.toString(), name: user.name, email: user.email, isAdmin: isAdminEmail(user.email) };
}

function asyncRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function issueVerificationCode(user) {
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    user.verifyCodeHash = hashCode(code);
    user.verifyCodeExpires = new Date(Date.now() + CODE_TTL_MS);
    user.verifyAttempts = 0;
    user.verifyLastSent = new Date();
    await user.save();
    await sendVerificationCode(user.email, user.name, code);
}

function requireLogin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Login required' });
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Login required' });
    if (!req.session.user.isAdmin) return res.status(403).json({ error: 'Admins only' });
    next();
}

function canModify(listing, user) {
    return user.isAdmin || (listing.owner && listing.owner.toString() === user.id);
}

// Pick and validate the editable listing fields from a request body
function parseListingFields(body, { partial = false } = {}) {
    const fields = {};
    const str = (k) => (typeof body[k] === 'string' ? body[k].trim() : undefined);

    for (const k of ['productName', 'itemInfo', 'sellerNumber', 'category', 'listingType']) {
        const v = str(k);
        if (v !== undefined && v !== '') fields[k] = v;
        else if (!partial) throw new Error(`${k} is required`);
    }
    if (fields.category && !CATEGORIES.includes(fields.category)) throw new Error('Invalid category');
    if (fields.listingType && !LISTING_TYPES.includes(fields.listingType)) throw new Error('Invalid listing type');
    if (fields.sellerNumber && !/^\+?[0-9\s-]{7,20}$/.test(fields.sellerNumber)) throw new Error('Invalid contact number');

    if (body.price !== undefined && body.price !== '') {
        const price = Number(body.price);
        if (!Number.isFinite(price) || price < 0) throw new Error('Price must be a positive number');
        fields.price = Math.round(price);
    }
    return fields;
}

async function saveImage(file, ownerId) {
    const img = await Image.create({ data: file.buffer, contentType: file.mimetype, owner: ownerId });
    return { imageId: img._id, image: `/api/images/${img._id}` };
}

// Never leak internal fields to clients
function publicListing(l) {
    const o = l.toObject ? l.toObject() : l;
    return {
        _id: o._id, productName: o.productName, itemInfo: o.itemInfo,
        sellerName: o.sellerName, sellerNumber: o.sellerNumber,
        category: o.category, listingType: o.listingType, price: o.price,
        image: o.image, owner: o.owner ? o.owner.toString() : null,
        createdAt: o.createdAt, updatedAt: o.updatedAt
    };
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later.' } });
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many messages, please try again later.' } });

// ======================
//   AUTH ROUTES
// ======================

app.get('/api/config', (req, res) => {
    res.json({ allowedEmailDomain: ALLOWED_EMAIL_DOMAIN, categories: CATEGORIES });
});

app.post('/api/register', authLimiter, asyncRoute(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (!isAllowedEmail(email)) return res.status(400).json({ error: `Please use your @${ALLOWED_EMAIL_DOMAIN} email address` });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (name.length > 80) return res.status(400).json({ error: 'Name is too long' });

    let user = await User.findOne({ email });
    if (user && user.verified) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    if (user) {
        // Unverified account: let the person restart sign-up (e.g. they mistyped earlier)
        user.name = name;
        user.password = hashed;
    } else {
        user = new User({ name, email, password: hashed });
    }
    await issueVerificationCode(user);
    res.status(201).json({ message: `We sent a 6-digit code to ${email}`, needsVerification: true, email });
}));

app.post('/api/verify', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const user = await User.findOne({ email });

    if (!user || user.verified || !user.verifyCodeHash) return res.status(400).json({ error: 'Invalid or expired code' });
    if (user.verifyAttempts >= MAX_CODE_ATTEMPTS) return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
    if (user.verifyCodeExpires < new Date()) return res.status(400).json({ error: 'Code expired. Request a new one.' });

    if (hashCode(code) !== user.verifyCodeHash) {
        user.verifyAttempts += 1;
        await user.save();
        return res.status(400).json({ error: 'Incorrect code' });
    }

    user.verified = true;
    user.verifyCodeHash = null;
    user.verifyCodeExpires = null;
    user.verifyAttempts = 0;
    await user.save();

    req.session.user = sessionUser(user);
    res.json({ message: 'Email verified', user: req.session.user });
}));

app.post('/api/resend-code', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    // Same response whether or not the account exists
    if (user && !user.verified) {
        if (user.verifyLastSent && Date.now() - user.verifyLastSent < CODE_RESEND_COOLDOWN_MS) {
            return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
        }
        await issueVerificationCode(user);
    }
    res.json({ message: 'If that account is awaiting verification, a new code was sent.' });
}));

app.post('/api/login', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'Invalid email or password' });
    }
    if (!user.verified) {
        return res.status(403).json({ error: 'Please verify your email first.', needsVerification: true, email });
    }
    req.session.user = sessionUser(user);
    res.json({ message: 'Logged in', user: req.session.user });
}));

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('cm.sid');
        res.json({ message: 'Logged out' });
    });
});

app.get('/api/me', (req, res) => {
    // 200 with null when logged out, so browsers don't log an error on every page load
    res.json(req.session.user || null);
});

// ======================
//   IMAGES
// ======================

app.get('/api/images/:id', asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).end();
    const img = await Image.findById(req.params.id);
    if (!img) return res.status(404).end();
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(img.data);
}));

// ======================
//   LISTING ROUTES
// ======================

app.get('/api/listings', asyncRoute(async (req, res) => {
    const { search, type, category, mine } = req.query;
    const query = {};
    if (type && type !== 'All' && LISTING_TYPES.includes(type)) query.listingType = type;
    if (category && category !== 'All' && CATEGORIES.includes(category)) query.category = category;
    if (mine === '1') {
        if (!req.session.user) return res.status(401).json({ error: 'Login required' });
        query.owner = req.session.user.id;
    }
    if (typeof search === 'string' && search.trim()) {
        const rx = { $regex: escapeRegex(search.trim().slice(0, 100)), $options: 'i' };
        query.$or = [{ productName: rx }, { itemInfo: rx }, { category: rx }];
    }
    const listings = await Listing.find(query).sort({ createdAt: -1 }).limit(200);
    res.json(listings.map(publicListing));
}));

app.get('/api/listings/:id', asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    res.json(publicListing(listing));
}));

app.post('/api/listings', requireLogin, uploadImage, asyncRoute(async (req, res) => {
    let fields;
    try { fields = parseListingFields(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (fields.listingType === 'Exchange') delete fields.price;
    else if (fields.price === undefined) return res.status(400).json({ error: 'Price is required for items you sell' });

    const listing = new Listing({ ...fields, sellerName: req.session.user.name, owner: req.session.user.id });
    if (req.file) Object.assign(listing, await saveImage(req.file, req.session.user.id));
    await listing.save();

    const out = publicListing(listing);
    io.emit('newListing', out);
    res.status(201).json(out);
}));

app.put('/api/listings/:id', requireLogin, uploadImage, asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (!canModify(listing, req.session.user)) return res.status(403).json({ error: 'You can only edit your own listings' });

    let fields;
    try { fields = parseListingFields(req.body, { partial: true }); } catch (e) { return res.status(400).json({ error: e.message }); }
    Object.assign(listing, fields);
    if (listing.listingType === 'Exchange') listing.price = undefined;
    else if (listing.price === undefined || listing.price === null) return res.status(400).json({ error: 'Price is required for items you sell' });

    const oldImageId = listing.imageId;
    if (req.file) Object.assign(listing, await saveImage(req.file, req.session.user.id));
    await listing.save();
    if (req.file && oldImageId) await Image.findByIdAndDelete(oldImageId);

    const out = publicListing(listing);
    io.emit('updatedListing', out);
    res.json(out);
}));

app.delete('/api/listings/:id', requireLogin, asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (!canModify(listing, req.session.user)) return res.status(403).json({ error: 'You can only remove your own listings' });

    await listing.deleteOne();
    if (listing.imageId) await Image.findByIdAndDelete(listing.imageId);
    io.emit('deletedListing', req.params.id);
    res.json({ message: 'Deleted successfully' });
}));

// ======================
//   CONTACT ADMIN
// ======================

app.post('/api/contact', contactLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const message = String(req.body.message || '').trim();
    if (!email || !message) return res.status(400).json({ error: 'Email and message required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters)' });

    await Contact.create({ email, message, user: req.session.user ? req.session.user.id : null });
    io.to('admins').emit('newContact');
    res.json({ success: true, message: 'Message received by admins.' });
}));

app.get('/api/contact', requireAdmin, asyncRoute(async (req, res) => {
    const messages = await Contact.find().sort({ createdAt: -1 }).limit(500);
    res.json(messages);
}));

app.patch('/api/contact/:id', requireAdmin, asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const msg = await Contact.findByIdAndUpdate(req.params.id, { read: Boolean(req.body.read) }, { new: true });
    if (!msg) return res.status(404).json({ error: 'Not found' });
    res.json(msg);
}));

app.delete('/api/contact/:id', requireAdmin, asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const msg = await Contact.findByIdAndDelete(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
}));

// ======================
//   ERRORS
// ======================

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ======================
//   SOCKET.IO
// ======================

// Admins join an "admins" room so they get notified about new contact messages.
// The session is shared with socket.io so we know who is connecting.
io.engine.use(sessionMiddleware);
io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;
    if (user && user.isAdmin) socket.join('admins');
});

// ======================
//   START
// ======================

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('MongoDB connected');
        server.listen(PORT, () => console.log(`Campus Market running on http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error('MongoDB connection error:', err.message);
        process.exit(1);
    });
