const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Middleware ---
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Session ---
app.use(session({
    secret: 'campus-market-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// --- MongoDB ---
mongoose.connect('mongodb://niloy202:niloy1234@ac-ywhxfgr-shard-00-00.eixdu5m.mongodb.net:27017,ac-ywhxfgr-shard-00-01.eixdu5m.mongodb.net:27017,ac-ywhxfgr-shard-00-02.eixdu5m.mongodb.net:27017/?ssl=true&replicaSet=atlas-5vu86q-shard-0&authSource=admin&appName=Cluster0')
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB error:', err));

// --- User Schema ---
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

// --- Listing Schema ---
const listingSchema = new mongoose.Schema({
    productName: { type: String, required: true },
    itemInfo: { type: String, required: true },
    sellerName: { type: String, required: true },
    sellerNumber: { type: String, required: true },
    category: { type: String, enum: ['Hardware', 'Book', 'Notes'], required: true },
    listingType: { type: String, enum: ['Sell', 'Exchange'], required: true },
    image: { type: String, default: '' }
}, { timestamps: true });
const Listing = mongoose.model('Listing', listingSchema);

// --- File Upload ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// --- Auth Middleware ---
function requireLogin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Login required' });
    next();
}

// --- Socket.io ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});

// ======================
//   AUTH ROUTES
// ======================

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
        const exists = await User.findOne({ email });
        if (exists) return res.status(400).json({ error: 'Email already registered' });
        const hashed = await bcrypt.hash(password, 10);
        const user = new User({ name, email, password: hashed });
        await user.save();
        req.session.user = { id: user._id, name: user.name, email: user.email };
        res.status(201).json({ message: 'Registered successfully', user: req.session.user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: 'Invalid email or password' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Invalid email or password' });
        req.session.user = { id: user._id, name: user.name, email: user.email };
        res.json({ message: 'Logged in', user: req.session.user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out' });
});

app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    res.json(req.session.user);
});

// ======================
//   LISTING ROUTES
// ======================

app.get('/api/listings', async (req, res) => {
    try {
        const { search, type } = req.query;
        const query = {};
        if (type && type !== 'All') query.listingType = type;
        if (search) query.$or = [
            { productName: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } }
        ];
        const listings = await Listing.find(query).sort({ createdAt: -1 });
        res.json(listings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/listings/:id', async (req, res) => {
    try {
        const listing = await Listing.findById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Not found' });
        res.json(listing);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/listings', requireLogin, upload.single('image'), async (req, res) => {
    try {
        const { productName, itemInfo, sellerNumber, category, listingType } = req.body;
        const sellerName = req.session.user.name;
        const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
        const listing = new Listing({ productName, itemInfo, sellerName, sellerNumber, category, listingType, image: imageUrl });
        await listing.save();
        io.emit('newListing', listing);
        res.status(201).json(listing);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/listings/:id', requireLogin, upload.single('image'), async (req, res) => {
    try {
        const updates = { ...req.body };
        if (req.file) updates.image = `/uploads/${req.file.filename}`;
        const listing = await Listing.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
        if (!listing) return res.status(404).json({ error: 'Not found' });
        res.json(listing);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/listings/:id', requireLogin, async (req, res) => {
    try {
        const listing = await Listing.findByIdAndDelete(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Not found' });
        io.emit('deletedListing', req.params.id);
        res.json({ message: 'Deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/contact', (req, res) => {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).json({ error: 'Email and message required' });
    req.session.lastContact = { email, sentAt: new Date() };
    console.log(`[Admin Message] From: ${email} | Message: ${message}`);
    res.json({ success: true, message: 'Message received by admins.' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));