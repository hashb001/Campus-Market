const API = 'http://localhost:5000/api';

let currentFilter = 'All';
let searchQuery = '';
let currentUser = null;

const form = document.getElementById('listingForm');
const listingsContainer = document.getElementById('marketplace-listings');
const searchInput = document.getElementById('searchInput');
const filterButtons = document.querySelectorAll('.filter-btn');
const noResultsDiv = document.getElementById('noResults');

// --- Socket.io ---
const socket = io('http://localhost:5000');

socket.on('newListing', (listing) => {
    showToast(`New listing: "${listing.productName}" just posted!`, 'success');
    displayItems();
});

socket.on('deletedListing', () => {
    showToast('A listing was just removed.', 'warning');
    displayItems();
});

// ======================
//   AUTH
// ======================

// Check if already logged in on page load
async function checkAuth() {
    try {
        const res = await fetch(`${API}/me`, { credentials: 'include' });
        if (res.ok) {
            currentUser = await res.json();
            updateNavAuth();
        }
    } catch (err) { /* not logged in */ }
}

function updateNavAuth() {
    const loggedOut = document.getElementById('navLoggedOut');
    const loggedIn = document.getElementById('navLoggedIn');
    const navUserName = document.getElementById('navUserName');
    const loginPrompt = document.getElementById('loginPrompt');

    if (currentUser) {
        loggedOut.classList.add('d-none');
        loggedIn.classList.remove('d-none');
        navUserName.textContent = currentUser.name;
        loginPrompt.classList.add('d-none');
        form.style.opacity = '1';
        form.style.pointerEvents = 'auto';
    } else {
        loggedOut.classList.remove('d-none');
        loggedIn.classList.add('d-none');
        loginPrompt.classList.remove('d-none');
        form.style.opacity = '0.4';
        form.style.pointerEvents = 'none';
    }
}

function showTab(tab) {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const loginTab = document.getElementById('loginTab');
    const registerTab = document.getElementById('registerTab');
    document.getElementById('authError').classList.add('d-none');

    if (tab === 'login') {
        loginForm.classList.remove('d-none');
        registerForm.classList.add('d-none');
        loginTab.classList.add('active');
        registerTab.classList.remove('active');
    } else {
        loginForm.classList.add('d-none');
        registerForm.classList.remove('d-none');
        loginTab.classList.remove('active');
        registerTab.classList.add('active');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('authError');

    try {
        const res = await fetch(`${API}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) {
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('d-none');
            return;
        }
        currentUser = data.user;
        updateNavAuth();
        bootstrap.Modal.getInstance(document.getElementById('authModal')).hide();
        showToast(`Welcome back, ${currentUser.name}!`, 'success');
    } catch (err) {
        errorDiv.textContent = 'Could not reach server.';
        errorDiv.classList.remove('d-none');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('regName').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;
    const errorDiv = document.getElementById('authError');

    try {
        const res = await fetch(`${API}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name, email, password })
        });
        const data = await res.json();
        if (!res.ok) {
            errorDiv.textContent = data.error;
            errorDiv.classList.remove('d-none');
            return;
        }
        currentUser = data.user;
        updateNavAuth();
        bootstrap.Modal.getInstance(document.getElementById('authModal')).hide();
        showToast(`Welcome, ${currentUser.name}! Account created.`, 'success');
    } catch (err) {
        errorDiv.textContent = 'Could not reach server.';
        errorDiv.classList.remove('d-none');
    }
}

async function logout() {
    await fetch(`${API}/logout`, { method: 'POST', credentials: 'include' });
    currentUser = null;
    updateNavAuth();
    showToast('Logged out successfully.', 'warning');
}

// ======================
//   TOAST
// ======================

function showToast(message, type = 'success') {
    const colors = { success: '#198754', warning: '#ffc107', danger: '#dc3545' };
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed; bottom: 30px; right: 30px;
        background: ${colors[type]};
        color: ${type === 'warning' ? '#000' : '#fff'};
        padding: 14px 22px; border-radius: 12px;
        font-weight: 600; font-size: 14px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.15);
        z-index: 9999; opacity: 0; transition: opacity 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.style.opacity = '1', 10);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
}

// ======================
//   LISTINGS
// ======================

async function displayItems() {
    try {
        const params = new URLSearchParams();
        if (currentFilter !== 'All') params.set('type', currentFilter);
        if (searchQuery) params.set('search', searchQuery);

        const res = await fetch(`${API}/listings?${params}`);
        const items = await res.json();
        listingsContainer.innerHTML = '';

        if (items.length === 0) { noResultsDiv.classList.remove('d-none'); return; }
        noResultsDiv.classList.add('d-none');

        items.forEach(item => {
            const isSell = item.listingType === 'Sell';
            const badgeClass = isSell ? 'bg-secondary' : 'bg-warning text-dark';
            const iconClass = isSell ? 'bi-currency-dollar' : 'bi-arrow-left-right';
            const imgSrc = item.image
                ? (item.image.startsWith('http') ? item.image : `http://localhost:5000${item.image}`)
                : 'https://placehold.co/400x220?text=No+Image';

            const colDiv = document.createElement('div');
            colDiv.className = 'col-md-6 mb-4';
            colDiv.innerHTML = `
                <div class="card shadow-sm h-100 border-0 rounded-4">
                    <img src="${imgSrc}" class="card-img-top img-fluid marketplace-img" alt="${item.productName}">
                    <div class="card-body d-flex flex-column">
                        <div class="d-flex justify-content-between align-items-center mb-3">
                            <span class="badge ${badgeClass} px-3 py-2 rounded-pill"><i class="bi ${iconClass} me-1"></i>${item.listingType}</span>
                            <span class="badge bg-light text-secondary border px-3 py-2 rounded-pill">${item.category}</span>
                        </div>
                        <h5 class="card-title fw-bold text-dark">${item.productName}</h5>
                        <p class="card-text text-muted small mb-3">${item.itemInfo}</p>
                        <div class="mt-auto">
                            <hr class="text-muted">
                            <p class="card-text mb-1 text-muted small"><i class="bi bi-person-circle me-2"></i>${item.sellerName}</p>
                            <p class="card-text text-info fw-bold mb-0"><i class="bi bi-telephone-fill me-2"></i>${item.sellerNumber}</p>
                        </div>
                        ${currentUser ? `
                        <button class="btn btn-sm btn-outline-danger mt-3 rounded-pill" onclick="deleteListing('${item._id}')">
                            <i class="bi bi-trash me-1"></i>Remove
                        </button>` : ''}
                    </div>
                </div>`;
            listingsContainer.appendChild(colDiv);
        });
    } catch (err) {
        console.error('Failed to load listings:', err);
        noResultsDiv.classList.remove('d-none');
    }
}

form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!currentUser) { showToast('Please login first.', 'danger'); return; }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting...';

    try {
        const formData = new FormData();
        formData.append('productName', document.getElementById('productName').value);
        formData.append('itemInfo', document.getElementById('itemInfo').value);
        formData.append('sellerNumber', document.getElementById('sellerNumber').value);
        formData.append('category', document.getElementById('category').value);
        formData.append('listingType', document.getElementById('listingType').value);
        const file = document.getElementById('imageInput').files[0];
        if (file) formData.append('image', file);

        const res = await fetch(`${API}/listings`, {
            method: 'POST',
            credentials: 'include',
            body: formData
        });
        if (res.ok) { form.reset(); }
        else {
            const data = await res.json();
            if (res.status === 401) showToast('Please login first.', 'danger');
            else alert(data.error || 'Failed to post listing.');
        }
    } catch (err) {
        alert('Could not reach server.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post Listing';
    }
});

async function deleteListing(id) {
    if (!confirm('Remove this listing?')) return;
    try {
        const res = await fetch(`${API}/listings/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        if (!res.ok) alert('Could not delete listing.');
    } catch (err) {
        alert('Could not reach server.');
    }
}

document.getElementById('adminForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = this.querySelector('input[type="email"]').value;
    const message = this.querySelector('textarea').value;
    try {
        await fetch(`${API}/contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, message })
        });
    } catch (err) { console.error(err); }
    alert('Message sent to admins!');
    this.reset();
    bootstrap.Modal.getInstance(document.getElementById('adminModal')).hide();
});

searchInput.addEventListener('input', function (e) { searchQuery = e.target.value; displayItems(); });

filterButtons.forEach(button => {
    button.addEventListener('click', function () {
        filterButtons.forEach(btn => btn.classList.remove('active', 'text-white'));
        this.classList.add('active', 'text-white');
        currentFilter = this.getAttribute('data-filter');
        displayItems();
    });
});

// --- Init ---
checkAuth().then(() => {
    updateNavAuth();
    displayItems();
});

function scrollToMarket() {
    document.getElementById('main-content').scrollIntoView({ behavior: 'smooth' });
}