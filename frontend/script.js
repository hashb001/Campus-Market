// The backend serves this page, so the API lives on the same origin.
// If you host the frontend elsewhere, set window.CAMPUS_MARKET_API before this script loads.
const API_ORIGIN = window.CAMPUS_MARKET_API || '';
const API = `${API_ORIGIN}/api`;

let currentFilter = 'All';
let currentCategory = 'All';
let showMine = false;
let searchQuery = '';
let currentUser = null;
let pendingVerifyEmail = null;
let listingsCache = new Map();

const form = document.getElementById('listingForm');
const listingsContainer = document.getElementById('marketplace-listings');
const searchInput = document.getElementById('searchInput');
const filterButtons = document.querySelectorAll('.filter-btn');
const noResultsDiv = document.getElementById('noResults');

// ======================
//   HELPERS
// ======================

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, { credentials: 'include', ...options });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data: data || {} };
}

function jsonBody(obj) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function imageUrl(path) {
    if (!path) return null;
    return path.startsWith('http') ? path : `${API_ORIGIN}${path}`;
}

function formatPrice(n) {
    return `৳${Number(n).toLocaleString('en-US')}`;
}

function timeAgo(dateStr) {
    const s = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (s < 60) return 'just now';
    const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [name, secs] of units) {
        const v = Math.floor(s / secs);
        if (v >= 1) return `${v} ${name}${v > 1 ? 's' : ''} ago`;
    }
    return 'just now';
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function hideModal(id) {
    const m = bootstrap.Modal.getInstance(document.getElementById(id));
    if (m) m.hide();
}

// ======================
//   TOAST
// ======================

function showToast(message, type = 'success') {
    const colors = { success: '#198754', warning: '#ffc107', danger: '#dc3545', info: '#0dcaf0' };
    const toast = document.createElement('div');
    toast.className = 'cm-toast';
    toast.setAttribute('role', 'status');
    toast.style.background = colors[type] || colors.success;
    toast.style.color = type === 'warning' || type === 'info' ? '#000' : '#fff';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

// ======================
//   SOCKET.IO (live updates)
// ======================

const socket = typeof io === 'function' ? io(API_ORIGIN || undefined, { withCredentials: true }) : null;

if (socket) {
    socket.on('newListing', (listing) => {
        if (!currentUser || listing.owner !== currentUser.id) {
            showToast(`New listing: "${listing.productName}" just posted!`, 'success');
        }
        displayItems();
    });
    socket.on('updatedListing', () => displayItems());
    socket.on('deletedListing', () => displayItems());
    socket.on('newContact', () => {
        showToast('New message in the admin inbox.', 'info');
        refreshInboxBadge();
    });
}

// Reconnect so the server sees the new session (admins join their room)
function refreshSocket() {
    if (socket) { socket.disconnect(); socket.connect(); }
}

// ======================
//   AUTH
// ======================

async function checkAuth() {
    try {
        const { ok, data } = await api('/me');
        currentUser = ok && data.id ? data : null;
    } catch { currentUser = null; }
}

async function loadConfig() {
    try {
        const { ok, data } = await api('/config');
        if (ok && data.allowedEmailDomain) {
            document.querySelectorAll('.email-domain').forEach(el => { el.textContent = `@${data.allowedEmailDomain}`; });
            ['loginEmail', 'regEmail'].forEach(id => {
                document.getElementById(id).placeholder = `firstname.lastname@${data.allowedEmailDomain}`;
            });
        }
    } catch { /* keep defaults */ }
}

function updateNavAuth() {
    const loggedOut = document.getElementById('navLoggedOut');
    const loggedIn = document.getElementById('navLoggedIn');
    const loginPrompt = document.getElementById('loginPrompt');
    const mineWrap = document.getElementById('mineToggleWrap');
    const inboxBtn = document.getElementById('adminInboxBtn');
    const contactEmail = document.getElementById('contactEmail');

    if (currentUser) {
        loggedOut.classList.add('d-none');
        loggedIn.classList.remove('d-none');
        document.getElementById('navUserName').textContent = currentUser.name;
        loginPrompt.classList.add('d-none');
        form.classList.remove('form-disabled');
        mineWrap.classList.remove('d-none');
        inboxBtn.classList.toggle('d-none', !currentUser.isAdmin);
        if (!contactEmail.value) contactEmail.value = currentUser.email;
        if (currentUser.isAdmin) refreshInboxBadge();
    } else {
        loggedOut.classList.remove('d-none');
        loggedIn.classList.add('d-none');
        loginPrompt.classList.remove('d-none');
        form.classList.add('form-disabled');
        mineWrap.classList.add('d-none');
        inboxBtn.classList.add('d-none');
        document.getElementById('mineToggle').checked = false;
        showMine = false;
    }
}

function setAuthMessage(kind, text) {
    const err = document.getElementById('authError');
    const info = document.getElementById('authInfo');
    err.classList.add('d-none');
    info.classList.add('d-none');
    if (kind === 'error') { err.textContent = text; err.classList.remove('d-none'); }
    if (kind === 'info') { info.textContent = text; info.classList.remove('d-none'); }
}

function showTab(tab) {
    const forms = { login: 'loginForm', register: 'registerForm', verify: 'verifyForm', forgot: 'forgotForm', reset: 'resetForm' };
    Object.entries(forms).forEach(([name, id]) => {
        document.getElementById(id).classList.toggle('d-none', name !== tab);
    });
    document.getElementById('authTabs').classList.toggle('d-none', !['login', 'register'].includes(tab));
    if (tab === 'forgot') {
        const loginEmail = document.getElementById('loginEmail').value.trim();
        if (loginEmail) document.getElementById('forgotEmail').value = loginEmail;
    }
    document.getElementById('loginTab').classList.toggle('active', tab === 'login');
    document.getElementById('registerTab').classList.toggle('active', tab === 'register');
    if (tab !== 'verify') setAuthMessage(null);
}

function showVerifyStep(email, message) {
    pendingVerifyEmail = email;
    document.getElementById('verifyEmailLabel').textContent = email;
    document.getElementById('verifyCode').value = '';
    showTab('verify');
    setAuthMessage('info', message || `We sent a 6-digit code to ${email}.`);
    setTimeout(() => document.getElementById('verifyCode').focus(), 100);
}

function onLoggedIn(user, greeting) {
    currentUser = user;
    updateNavAuth();
    hideModal('authModal');
    document.getElementById('loginForm').reset();
    document.getElementById('registerForm').reset();
    showToast(greeting, 'success');
    refreshSocket();
    displayItems();
}

async function withButton(formEl, busyText, fn) {
    const btn = formEl.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = original; }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    await withButton(e.target, 'Logging in...', async () => {
        try {
            const { ok, status, data } = await api('/login', jsonBody({ email, password }));
            if (ok) return onLoggedIn(data.user, `Welcome back, ${data.user.name}!`);
            if (status === 403 && data.needsVerification) {
                // Send a fresh code so they can finish verifying
                const resend = await api('/resend-code', jsonBody({ email }));
                if (!resend.ok && resend.status !== 429) {
                    return setAuthMessage('error', resend.data.error || 'Could not send a verification code.');
                }
                return showVerifyStep(email, resend.ok
                    ? 'Your email isn\'t verified yet. We sent you a new code.'
                    : 'Your email isn\'t verified yet. Enter the code we sent you recently.');
            }
            setAuthMessage('error', data.error || 'Login failed.');
        } catch {
            setAuthMessage('error', 'Could not reach server.');
        }
    });
}

async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;

    await withButton(e.target, 'Creating account...', async () => {
        try {
            const { ok, data } = await api('/register', jsonBody({ name, email, password }));
            if (!ok) return setAuthMessage('error', data.error || 'Registration failed.');
            showVerifyStep(data.email || email, data.message);
        } catch {
            setAuthMessage('error', 'Could not reach server.');
        }
    });
}

async function handleVerify(e) {
    e.preventDefault();
    const code = document.getElementById('verifyCode').value.trim();

    await withButton(e.target, 'Verifying...', async () => {
        try {
            const { ok, data } = await api('/verify', jsonBody({ email: pendingVerifyEmail, code }));
            if (!ok) return setAuthMessage('error', data.error || 'Verification failed.');
            onLoggedIn(data.user, `Welcome, ${data.user.name}! Your NSU email is verified.`);
        } catch {
            setAuthMessage('error', 'Could not reach server.');
        }
    });
}

async function resendCode() {
    if (!pendingVerifyEmail) return;
    const btn = document.getElementById('resendBtn');
    btn.disabled = true;
    try {
        const { ok, data } = await api('/resend-code', jsonBody({ email: pendingVerifyEmail }));
        setAuthMessage(ok ? 'info' : 'error', ok ? `A new code was sent to ${pendingVerifyEmail}.` : data.error);
    } catch {
        setAuthMessage('error', 'Could not reach server.');
    }
    setTimeout(() => { btn.disabled = false; }, 60000);
}

// --- Forgot password ---
let pendingResetEmail = null;

async function requestResetCode(email) {
    const { ok, data } = await api('/forgot-password', jsonBody({ email }));
    if (!ok) throw new Error(data.error || 'Could not send a reset code.');
    return data.message;
}

async function handleForgot(e) {
    e.preventDefault();
    const email = document.getElementById('forgotEmail').value.trim();
    await withButton(e.target, 'Sending...', async () => {
        try {
            const message = await requestResetCode(email);
            pendingResetEmail = email;
            document.getElementById('resetEmailLabel').textContent = email;
            document.getElementById('resetForm').reset();
            showTab('reset');
            setAuthMessage('info', message);
            setTimeout(() => document.getElementById('resetCode').focus(), 100);
        } catch (err) {
            setAuthMessage('error', err.message === 'Failed to fetch' ? 'Could not reach server.' : err.message);
        }
    });
}

async function handleReset(e) {
    e.preventDefault();
    const code = document.getElementById('resetCode').value.trim();
    const password = document.getElementById('resetPassword').value;
    await withButton(e.target, 'Saving...', async () => {
        try {
            const { ok, data } = await api('/reset-password', jsonBody({ email: pendingResetEmail, code, password }));
            if (!ok) return setAuthMessage('error', data.error || 'Could not reset password.');
            document.getElementById('resetForm').reset();
            onLoggedIn(data.user, 'Password updated. You\'re logged in.');
        } catch {
            setAuthMessage('error', 'Could not reach server.');
        }
    });
}

async function resendResetCode() {
    if (!pendingResetEmail) return;
    const btn = document.getElementById('resendResetBtn');
    btn.disabled = true;
    try {
        await requestResetCode(pendingResetEmail);
        setAuthMessage('info', `A new code was sent to ${pendingResetEmail}.`);
    } catch (err) {
        setAuthMessage('error', err.message === 'Failed to fetch' ? 'Could not reach server.' : err.message);
    }
    setTimeout(() => { btn.disabled = false; }, 60000);
}

async function logout() {
    try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
    currentUser = null;
    updateNavAuth();
    refreshSocket();
    showToast('Logged out successfully.', 'warning');
    displayItems();
}

// ======================
//   LISTINGS
// ======================

function renderCard(item) {
    const isSell = item.listingType === 'Sell';
    const badgeClass = isSell ? 'bg-secondary' : 'bg-warning text-dark';
    const iconClass = isSell ? 'bi-tag-fill' : 'bi-arrow-left-right';
    const img = imageUrl(item.image);
    const canEdit = currentUser && (currentUser.isAdmin || item.owner === currentUser.id);
    const isMine = currentUser && item.owner === currentUser.id;
    const phone = String(item.sellerNumber || '').replace(/[^\d+]/g, '');
    const doneLabel = isSell ? 'Sold' : 'Traded';

    // Phone numbers only come from the server for logged-in students
    const contactHtml = item.sellerNumber
        ? `<a class="card-text text-info fw-bold mb-0 d-inline-block text-decoration-none" href="tel:${escapeHtml(phone)}">
               <i class="bi bi-telephone-fill me-2"></i>${escapeHtml(item.sellerNumber)}
           </a>`
        : `<a href="#" class="card-text small fw-semibold mb-0 d-inline-block text-decoration-none" data-bs-toggle="modal"
              data-bs-target="#authModal" onclick="showTab('login')">
               <i class="bi bi-lock-fill me-1"></i>Log in with your NSU email to see contact
           </a>`;

    const col = document.createElement('div');
    col.className = 'col-md-6 mb-4';
    col.innerHTML = `
        <div class="card shadow-sm h-100 border-0 rounded-4 position-relative ${item.sold ? 'card-sold' : ''}">
            ${item.sold ? `<span class="sold-ribbon badge bg-dark px-3 py-2 rounded-pill"><i class="bi bi-check2-circle me-1"></i>${doneLabel}</span>` : ''}
            ${img
                ? `<img src="${escapeHtml(img)}" class="card-img-top img-fluid marketplace-img" alt="${escapeHtml(item.productName)}" loading="lazy">`
                : `<div class="marketplace-img placeholder-img d-flex align-items-center justify-content-center"><i class="bi bi-image text-muted fs-1"></i></div>`}
            <div class="card-body d-flex flex-column">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <span class="badge ${badgeClass} px-3 py-2 rounded-pill"><i class="bi ${iconClass} me-1"></i>${escapeHtml(item.listingType)}</span>
                    <span class="badge bg-light text-secondary border px-3 py-2 rounded-pill">${escapeHtml(item.category)}</span>
                </div>
                <h5 class="card-title fw-bold text-dark mb-1">${escapeHtml(item.productName)}</h5>
                ${isSell && item.price != null ? `<p class="fs-5 fw-bold text-success mb-2">${formatPrice(item.price)}</p>` : '<p class="small text-warning fw-semibold mb-2">Open to exchange</p>'}
                <p class="card-text text-muted small mb-3 item-info">${escapeHtml(item.itemInfo)}</p>
                <div class="mt-auto">
                    <hr class="text-muted">
                    <p class="card-text mb-1 text-muted small">
                        <i class="bi bi-person-circle me-2"></i>${escapeHtml(item.sellerName)}${isMine ? ' <span class="badge bg-info text-dark ms-1">You</span>' : ''}
                        <span class="float-end">${escapeHtml(timeAgo(item.createdAt))}</span>
                    </p>
                    ${contactHtml}
                </div>
                ${canEdit ? `
                <button class="btn btn-sm ${item.sold ? 'btn-outline-success' : 'btn-success'} rounded-pill mt-3" data-action="sold"
                    data-id="${escapeHtml(item._id)}" data-sold="${item.sold ? 'true' : 'false'}">
                    ${item.sold
                        ? '<i class="bi bi-arrow-counterclockwise me-1"></i>Mark as available again'
                        : `<i class="bi bi-check2-circle me-1"></i>Mark as ${doneLabel.toLowerCase()}`}
                </button>
                <div class="d-flex gap-2 mt-2">
                    <button class="btn btn-sm btn-outline-secondary rounded-pill flex-fill" data-action="edit" data-id="${escapeHtml(item._id)}">
                        <i class="bi bi-pencil me-1"></i>Edit
                    </button>
                    <button class="btn btn-sm btn-outline-danger rounded-pill flex-fill" data-action="delete" data-id="${escapeHtml(item._id)}">
                        <i class="bi bi-trash me-1"></i>Remove
                    </button>
                </div>` : ''}
            </div>
        </div>`;

    // Fall back to a placeholder if an image fails to load (e.g. old local uploads)
    const imgEl = col.querySelector('img');
    if (imgEl) imgEl.addEventListener('error', () => {
        imgEl.outerHTML = '<div class="marketplace-img placeholder-img d-flex align-items-center justify-content-center"><i class="bi bi-image text-muted fs-1"></i></div>';
    }, { once: true });
    return col;
}

let displayRequestId = 0;
async function displayItems() {
    const requestId = ++displayRequestId;
    try {
        const params = new URLSearchParams();
        if (currentFilter !== 'All') params.set('type', currentFilter);
        if (currentCategory !== 'All') params.set('category', currentCategory);
        if (searchQuery) params.set('search', searchQuery);
        if (showMine && currentUser) params.set('mine', '1');

        const { ok, data } = await api(`/listings?${params}`);
        if (requestId !== displayRequestId) return; // a newer request superseded this one
        if (!ok) throw new Error(data.error || 'Failed to load');

        const items = Array.isArray(data) ? data : [];
        listingsContainer.innerHTML = '';
        listingsCache = new Map(items.map(i => [i._id, i]));

        if (items.length === 0) {
            document.getElementById('noResultsTitle').textContent = showMine ? 'You have no listings yet' : 'No items found';
            document.getElementById('noResultsText').textContent = showMine
                ? 'Use the form to post your first item.'
                : 'Try adjusting your search or filters.';
            noResultsDiv.classList.remove('d-none');
            return;
        }
        noResultsDiv.classList.add('d-none');
        items.forEach(item => listingsContainer.appendChild(renderCard(item)));
    } catch (err) {
        if (requestId !== displayRequestId) return;
        console.error('Failed to load listings:', err);
        listingsContainer.innerHTML = '';
        document.getElementById('noResultsTitle').textContent = 'Could not load listings';
        document.getElementById('noResultsText').textContent = 'Please check your connection and refresh.';
        noResultsDiv.classList.remove('d-none');
    }
}

function togglePriceField(typeSelectId, groupId, inputId) {
    const isSell = document.getElementById(typeSelectId).value === 'Sell';
    document.getElementById(groupId).classList.toggle('d-none', !isSell);
    document.getElementById(inputId).required = isSell;
}

document.getElementById('listingType').addEventListener('change', () => togglePriceField('listingType', 'priceGroup', 'price'));
document.getElementById('editListingType').addEventListener('change', () => togglePriceField('editListingType', 'editPriceGroup', 'editPrice'));

form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentUser) { showToast('Please login with your NSU email first.', 'danger'); return; }

    await withButton(form, 'Posting...', async () => {
        try {
            const formData = new FormData();
            ['productName', 'itemInfo', 'sellerNumber', 'category', 'listingType'].forEach(id => {
                formData.append(id, document.getElementById(id).value);
            });
            if (document.getElementById('listingType').value === 'Sell') {
                formData.append('price', document.getElementById('price').value);
            }
            const file = document.getElementById('imageInput').files[0];
            if (file) formData.append('image', file);

            const { ok, status, data } = await api('/listings', { method: 'POST', body: formData });
            if (ok) {
                form.reset();
                togglePriceField('listingType', 'priceGroup', 'price');
                showToast('Your listing is live!', 'success');
                displayItems();
            } else if (status === 401) {
                currentUser = null;
                updateNavAuth();
                showToast('Your session expired. Please login again.', 'danger');
            } else {
                showToast(data.error || 'Failed to post listing.', 'danger');
            }
        } catch {
            showToast('Could not reach server.', 'danger');
        }
    });
});

// Edit / delete buttons on cards
listingsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'delete') deleteListing(id);
    if (btn.dataset.action === 'edit') openEdit(id);
    if (btn.dataset.action === 'sold') setSold(id, btn.dataset.sold !== 'true');
});

async function setSold(id, sold) {
    try {
        const { ok, data } = await api(`/listings/${encodeURIComponent(id)}/sold`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sold })
        });
        if (!ok) return showToast(data.error || 'Could not update listing.', 'danger');
        showToast(sold
            ? 'Marked as done. It\'s hidden from the marketplace but still under "My listings".'
            : 'Listing is available again.', 'success');
        displayItems();
    } catch {
        showToast('Could not reach server.', 'danger');
    }
}

async function deleteListing(id) {
    if (!confirm('Remove this listing? This cannot be undone.')) return;
    try {
        const { ok, data } = await api(`/listings/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (ok) { showToast('Listing removed.', 'warning'); displayItems(); }
        else showToast(data.error || 'Could not delete listing.', 'danger');
    } catch {
        showToast('Could not reach server.', 'danger');
    }
}

function openEdit(id) {
    const item = listingsCache.get(id);
    if (!item) return;
    document.getElementById('editError').classList.add('d-none');
    document.getElementById('editForm').reset();
    document.getElementById('editId').value = id;
    document.getElementById('editProductName').value = item.productName;
    document.getElementById('editItemInfo').value = item.itemInfo;
    document.getElementById('editSellerNumber').value = item.sellerNumber;
    document.getElementById('editCategory').value = item.category;
    document.getElementById('editListingType').value = item.listingType;
    document.getElementById('editPrice').value = item.price ?? '';
    togglePriceField('editListingType', 'editPriceGroup', 'editPrice');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('editModal')).show();
}

document.getElementById('editForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const id = document.getElementById('editId').value;
    const errorDiv = document.getElementById('editError');

    await withButton(this, 'Saving...', async () => {
        try {
            const formData = new FormData();
            formData.append('productName', document.getElementById('editProductName').value);
            formData.append('itemInfo', document.getElementById('editItemInfo').value);
            formData.append('sellerNumber', document.getElementById('editSellerNumber').value);
            formData.append('category', document.getElementById('editCategory').value);
            formData.append('listingType', document.getElementById('editListingType').value);
            if (document.getElementById('editListingType').value === 'Sell') {
                formData.append('price', document.getElementById('editPrice').value);
            }
            const file = document.getElementById('editImage').files[0];
            if (file) formData.append('image', file);

            const { ok, data } = await api(`/listings/${encodeURIComponent(id)}`, { method: 'PUT', body: formData });
            if (!ok) {
                errorDiv.textContent = data.error || 'Could not save changes.';
                errorDiv.classList.remove('d-none');
                return;
            }
            hideModal('editModal');
            showToast('Listing updated.', 'success');
            displayItems();
        } catch {
            errorDiv.textContent = 'Could not reach server.';
            errorDiv.classList.remove('d-none');
        }
    });
});

// ======================
//   CONTACT ADMIN
// ======================

document.getElementById('adminForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = document.getElementById('contactEmail').value.trim();
    const message = document.getElementById('contactMessage').value.trim();

    await withButton(this, 'Sending...', async () => {
        try {
            const { ok, data } = await api('/contact', jsonBody({ email, message }));
            if (!ok) return showToast(data.error || 'Message could not be sent.', 'danger');
            showToast('Message sent to admins. We\'ll get back to you by email.', 'success');
            document.getElementById('contactMessage').value = '';
            hideModal('adminModal');
        } catch {
            showToast('Could not reach server. Message not sent.', 'danger');
        }
    });
});

// ======================
//   ADMIN INBOX
// ======================

async function refreshInboxBadge() {
    if (!currentUser || !currentUser.isAdmin) return;
    try {
        const { ok, data } = await api('/contact');
        if (!ok) return;
        const unread = data.filter(m => !m.read).length;
        const badge = document.getElementById('inboxBadge');
        badge.textContent = unread;
        badge.classList.toggle('d-none', unread === 0);
    } catch { /* ignore */ }
}

async function loadInbox() {
    const list = document.getElementById('inboxList');
    const empty = document.getElementById('inboxEmpty');
    list.innerHTML = '<p class="text-muted text-center">Loading...</p>';
    try {
        const { ok, data } = await api('/contact');
        if (!ok) { list.innerHTML = `<p class="text-danger">${escapeHtml(data.error || 'Could not load messages.')}</p>`; return; }
        list.innerHTML = '';
        empty.classList.toggle('d-none', data.length > 0);
        data.forEach(m => {
            const div = document.createElement('div');
            div.className = `inbox-item p-3 mb-3 rounded-3 border ${m.read ? 'bg-light' : 'bg-white border-warning'}`;
            div.innerHTML = `
                <div class="d-flex justify-content-between flex-wrap gap-2 mb-2">
                    <a class="fw-bold text-decoration-none" href="mailto:${escapeHtml(m.email)}">${escapeHtml(m.email)}</a>
                    <span class="small text-muted">${escapeHtml(new Date(m.createdAt).toLocaleString())}</span>
                </div>
                <p class="mb-3 inbox-message">${escapeHtml(m.message)}</p>
                <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-outline-secondary rounded-pill" data-inbox="toggle" data-id="${escapeHtml(m._id)}" data-read="${m.read}">
                        ${m.read ? 'Mark unread' : 'Mark read'}
                    </button>
                    <button class="btn btn-sm btn-outline-danger rounded-pill" data-inbox="delete" data-id="${escapeHtml(m._id)}">Delete</button>
                </div>`;
            list.appendChild(div);
        });
    } catch {
        list.innerHTML = '<p class="text-danger">Could not reach server.</p>';
    }
}

document.getElementById('inboxModal').addEventListener('show.bs.modal', loadInbox);
document.getElementById('inboxList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-inbox]');
    if (!btn) return;
    const id = encodeURIComponent(btn.dataset.id);
    try {
        if (btn.dataset.inbox === 'toggle') {
            await api(`/contact/${id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ read: btn.dataset.read !== 'true' })
            });
        } else if (confirm('Delete this message?')) {
            await api(`/contact/${id}`, { method: 'DELETE' });
        } else {
            return;
        }
        loadInbox();
        refreshInboxBadge();
    } catch {
        showToast('Could not reach server.', 'danger');
    }
});

// ======================
//   FILTERS & SEARCH
// ======================

const debouncedDisplay = debounce(displayItems, 250);
searchInput.addEventListener('input', (e) => { searchQuery = e.target.value.trim(); debouncedDisplay(); });

filterButtons.forEach(button => {
    button.addEventListener('click', function () {
        filterButtons.forEach(btn => btn.classList.remove('active', 'text-white'));
        this.classList.add('active', 'text-white');
        currentFilter = this.getAttribute('data-filter');
        displayItems();
    });
});

document.getElementById('categoryFilter').addEventListener('change', (e) => { currentCategory = e.target.value; displayItems(); });
document.getElementById('mineToggle').addEventListener('change', (e) => { showMine = e.target.checked; displayItems(); });

function scrollToMarket() {
    document.getElementById('main-content').scrollIntoView({ behavior: 'smooth' });
}

// ======================
//   INIT
// ======================

togglePriceField('listingType', 'priceGroup', 'price');
loadConfig();
checkAuth().then(() => {
    updateNavAuth();
    displayItems();
});
