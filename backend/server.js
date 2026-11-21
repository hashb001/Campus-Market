require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { User, Image, Listing, Contact, CATEGORIES, LISTING_TYPES } = require('./models');
const { sendCode } = require('./mailer');

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
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;   // accepted from the browser
const IMAGE_MAX_DIMENSION = 1200;            // stored images are resized to fit this box

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

// One shared MongoDB connection for both Mongoose and the session store
const mongoReady = mongoose.connect(MONGO_URI);

const sessionMiddleware = session({
    name: 'cm.sid',
    secret: SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        clientPromise: mongoReady.then(m => m.connection.getClient()).catch(() => new Promise(() => {})),
        ttl: 60 * 60 * 24 * 7
    }),
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
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(file.mimetype)) return cb(null, true);
        cb(new Error('Please upload a photo (JPEG, PNG, WEBP, GIF or HEIC)'));
    }
});

// Wrap multer so its errors come back as JSON 400s
const uploadImage = (req, res, next) => upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 10 MB or smaller' : err.message;
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

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

// --- One-time email codes (sign-up verification and password reset) ---

const CODE_FIELDS = {
    verify: { hash: 'verifyCodeHash', expires: 'verifyCodeExpires', attempts: 'verifyAttempts', sent: 'verifyLastSent' },
    reset: { hash: 'resetCodeHash', expires: 'resetCodeExpires', attempts: 'resetAttempts', sent: 'resetLastSent' }
};

function onCooldown(user, purpose) {
    const sent = user[CODE_FIELDS[purpose].sent];
    return sent && Date.now() - sent < CODE_RESEND_COOLDOWN_MS;
}

async function issueCode(user, purpose) {
    const f = CODE_FIELDS[purpose];
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    user[f.hash] = hashCode(code);
    user[f.expires] = new Date(Date.now() + CODE_TTL_MS);
    user[f.attempts] = 0;
    user[f.sent] = new Date();
    await user.save();
    try {
        await sendCode(user.email, user.name, code, purpose);
    } catch (err) {
        console.error(`Failed to send ${purpose} email to ${user.email}:`, err.message);
        // Don't make them wait out the resend cooldown for an email that never went out
        user[f.sent] = null;
        await user.save();
        throw httpError(502, 'We couldn\'t send the email right now. Please try again in a few minutes.');
    }
}

// Throws an httpError if the code is wrong/expired; clears the code on success
async function consumeCode(user, purpose, code) {
    const f = CODE_FIELDS[purpose];
    if (!user[f.hash]) throw httpError(400, 'Invalid or expired code');
    if (user[f.attempts] >= MAX_CODE_ATTEMPTS) throw httpError(429, 'Too many wrong attempts. Request a new code.');
    if (user[f.expires] < new Date()) throw httpError(400, 'Code expired. Request a new one.');
    if (hashCode(code) !== user[f.hash]) {
        user[f.attempts] += 1;
        await user.save();
        throw httpError(400, 'Incorrect code');
    }
    user[f.hash] = null;
    user[f.expires] = null;
    user[f.attempts] = 0;
}

// --- Access control ---

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

// --- Listings ---

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

// Shrink every upload (phones produce 3-8 MB photos) so the free 512 MB database lasts.
// Re-encoding also strips EXIF data such as GPS location, and rejects files that aren't real images.
async function saveImage(file, ownerId) {
    let data;
    try {
        data = await sharp(file.buffer, { failOn: 'error', limitInputPixels: 100e6 })
            .rotate() // respect phone orientation before EXIF is dropped
            .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer();
    } catch {
        throw httpError(400, 'That file doesn\'t look like a valid image. Please try another photo.');
    }
    const img = await Image.create({ data, contentType: 'image/webp', owner: ownerId });
    return { imageId: img._id, image: `/api/images/${img._id}` };
}

// Never leak internal fields; phone numbers are only shown to logged-in students
function publicListing(l, viewer) {
    const o = l.toObject ? l.toObject() : l;
    return {
        _id: o._id, productName: o.productName, itemInfo: o.itemInfo,
        sellerName: o.sellerName,
        sellerNumber: viewer ? o.sellerNumber : null,
        category: o.category, listingType: o.listingType, price: o.price,
        sold: Boolean(o.sold), soldAt: o.soldAt || null,
        image: o.image, owner: o.owner ? o.owner.toString() : null,
        createdAt: o.createdAt, updatedAt: o.updatedAt
    };
}

// Broadcasts go to everyone, including logged-out visitors, so never include contact details
const broadcastListing = (event, listing) => io.emit(event, publicListing(listing, null));

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
    if (user && user.verified) return res.status(400).json({ error: 'Email already registered. Try logging in, or use "Forgot password?".' });

    const hashed = await bcrypt.hash(password, 10);
    if (user) {
        // Unverified account: let the person restart sign-up (e.g. they mistyped earlier)
        user.name = name;
        user.password = hashed;
    } else {
        user = new User({ name, email, password: hashed });
    }
    await issueCode(user, 'verify');
    res.status(201).json({ message: `We sent a 6-digit code to ${email}`, needsVerification: true, email });
}));

app.post('/api/verify', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const user = await User.findOne({ email });
    if (!user || user.verified) return res.status(400).json({ error: 'Invalid or expired code' });

    await consumeCode(user, 'verify', code);
    user.verified = true;
    await user.save();

    req.session.user = sessionUser(user);
    res.json({ message: 'Email verified', user: req.session.user });
}));

app.post('/api/resend-code', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await User.findOne({ email });
    // Same response whether or not the account exists
    if (user && !user.verified) {
        if (onCooldown(user, 'verify')) {
            return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
        }
        await issueCode(user, 'verify');
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

// --- Forgot password ---

app.post('/api/forgot-password', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await User.findOne({ email });
    // Same response whether or not the account exists, so this can't be used to discover accounts
    if (user) {
        if (onCooldown(user, 'reset')) {
            return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
        }
        await issueCode(user, 'reset');
    }
    res.json({ message: `If an account exists for ${email}, we sent it a 6-digit reset code.` });
}));

app.post('/api/reset-password', authLimiter, asyncRoute(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid or expired code' });

    await consumeCode(user, 'reset', code);
    user.password = await bcrypt.hash(password, 10);
    // Receiving the code proves they own the inbox, so this also completes verification
    user.verified = true;
    user.verifyCodeHash = null;
    user.verifyCodeExpires = null;
    await user.save();

    req.session.user = sessionUser(user);
    res.json({ message: 'Password updated', user: req.session.user });
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
        query.owner = req.session.user.id;   // your own listings, sold ones included
    } else {
        query.sold = { $ne: true };          // the marketplace only shows what's still available
    }
    if (typeof search === 'string' && search.trim()) {
        const rx = { $regex: escapeRegex(search.trim().slice(0, 100)), $options: 'i' };
        query.$or = [{ productName: rx }, { itemInfo: rx }, { category: rx }];
    }
    const listings = await Listing.find(query).sort({ createdAt: -1 }).limit(200);
    res.json(listings.map(l => publicListing(l, req.session.user)));
}));

app.get('/api/listings/:id', asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    res.json(publicListing(listing, req.session.user));
}));

app.post('/api/listings', requireLogin, uploadImage, asyncRoute(async (req, res) => {
    let fields;
    try { fields = parseListingFields(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (fields.listingType === 'Exchange') delete fields.price;
    else if (fields.price === undefined) return res.status(400).json({ error: 'Price is required for items you sell' });

    const listing = new Listing({ ...fields, sellerName: req.session.user.name, owner: req.session.user.id });
    if (req.file) Object.assign(listing, await saveImage(req.file, req.session.user.id));
    await listing.save();

    broadcastListing('newListing', listing);
    res.status(201).json(publicListing(listing, req.session.user));
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

    broadcastListing('updatedListing', listing);
    res.json(publicListing(listing, req.session.user));
}));

// Mark a listing as sold/traded (hides it from the marketplace) or available again
app.patch('/api/listings/:id/sold', requireLogin, asyncRoute(async (req, res) => {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    if (!canModify(listing, req.session.user)) return res.status(403).json({ error: 'You can only update your own listings' });

    listing.sold = Boolean(req.body.sold);
    listing.soldAt = listing.sold ? new Date() : null;
    await listing.save();

    broadcastListing('updatedListing', listing);
    res.json(publicListing(listing, req.session.user));
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
    if (err.status && err.status < 600) return res.status(err.status).json({ error: err.message });
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

mongoReady
    .then(() => {
        console.log('MongoDB connected');
        server.listen(PORT, () => console.log(`Campus Market running on http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error('MongoDB connection error:', err.message);
        if (/auth/i.test(err.message)) {
            console.error('-> Check the username and password in MONGO_URI (no < > around the password).');
        } else if (/ENOTFOUND|querySrv/i.test(err.message)) {
            console.error('-> Check the cluster address in MONGO_URI.');
        } else if (/timed out|ECONNREFUSED|Server selection/i.test(err.message)) {
            console.error('-> In Atlas, check Network Access allows your IP (or 0.0.0.0/0) and the cluster is not paused.');
        }
        process.exit(1);
    });
