const mongoose = require('mongoose');

// --- User ---
const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    verified: { type: Boolean, default: false },
    // Email verification (stored as a SHA-256 hash, never in plain text)
    verifyCodeHash: { type: String, default: null },
    verifyCodeExpires: { type: Date, default: null },
    verifyAttempts: { type: Number, default: 0 },
    verifyLastSent: { type: Date, default: null },
    // Password reset (same scheme as verification)
    resetCodeHash: { type: String, default: null },
    resetCodeExpires: { type: Date, default: null },
    resetAttempts: { type: Number, default: 0 },
    resetLastSent: { type: Date, default: null }
}, { timestamps: true });

// --- Image (stored in MongoDB so uploads survive redeploys on hosts like Render) ---
const imageSchema = new mongoose.Schema({
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// --- Listing ---
const CATEGORIES = ['Hardware', 'Book', 'Notes'];
const LISTING_TYPES = ['Sell', 'Exchange'];

const listingSchema = new mongoose.Schema({
    productName: { type: String, required: true, trim: true, maxlength: 100 },
    itemInfo: { type: String, required: true, trim: true, maxlength: 1000 },
    sellerName: { type: String, required: true },
    sellerNumber: { type: String, required: true, trim: true, maxlength: 20 },
    category: { type: String, enum: CATEGORIES, required: true },
    listingType: { type: String, enum: LISTING_TYPES, required: true },
    price: {
        type: Number,
        min: 0,
        max: 10000000,
        required: function () { return this.listingType === 'Sell'; }
    },
    sold: { type: Boolean, default: false },
    soldAt: { type: Date, default: null },
    image: { type: String, default: '' },
    imageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Image', default: null },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// --- Contact message to admins ---
const contactSchema = new mongoose.Schema({
    email: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    read: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = {
    User: mongoose.model('User', userSchema),
    Image: mongoose.model('Image', imageSchema),
    Listing: mongoose.model('Listing', listingSchema),
    Contact: mongoose.model('Contact', contactSchema),
    CATEGORIES,
    LISTING_TYPES
};
