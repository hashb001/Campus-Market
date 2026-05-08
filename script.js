const API = 'http://localhost:5000/api';

let currentFilter = 'All';
let searchQuery = '';

const form = document.getElementById('listingForm');
const listingsContainer = document.getElementById('marketplace-listings');
const searchInput = document.getElementById('searchInput');
const filterButtons = document.querySelectorAll('.filter-btn');
const noResultsDiv = document.getElementById('noResults');

// --- Fetch & Display Listings ---
async function displayItems() {
    try {
        const params = new URLSearchParams();
        if (currentFilter !== 'All') params.set('type', currentFilter);
        if (searchQuery) params.set('search', searchQuery);

        const res = await fetch(`${API}/listings?${params}`);
        const items = await res.json();

        listingsContainer.innerHTML = '';

        if (items.length === 0) {
            noResultsDiv.classList.remove('d-none');
            return;
        }
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
                        <button class="btn btn-sm btn-outline-danger mt-3 rounded-pill" onclick="deleteListing('${item._id}')">
                            <i class="bi bi-trash me-1"></i>Remove
                        </button>
                    </div>
                </div>
            `;
            listingsContainer.appendChild(colDiv);
        });
    } catch (err) {
        console.error('Failed to load listings:', err);
        noResultsDiv.classList.remove('d-none');
    }
}

// --- Post New Listing ---
form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting...';

    try {
        const formData = new FormData();
        formData.append('productName', document.getElementById('productName').value);
        formData.append('itemInfo', document.getElementById('itemInfo').value);
        formData.append('sellerName', document.getElementById('sellerName').value);
        formData.append('sellerNumber', document.getElementById('sellerNumber').value);
        formData.append('category', document.getElementById('category').value);
        formData.append('listingType', document.getElementById('listingType').value);
        const file = document.getElementById('imageInput').files[0];
        if (file) formData.append('image', file);

        const res = await fetch(`${API}/listings`, { method: 'POST', body: formData });
        if (res.ok) {
            form.reset();
            displayItems();
        } else {
            alert('Failed to post listing. Please try again.');
        }
    } catch (err) {
        alert('Could not reach server. Make sure the backend is running.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post Listing';
    }
});

// --- Delete Listing ---
async function deleteListing(id) {
    if (!confirm('Remove this listing?')) return;
    try {
        const res = await fetch(`${API}/listings/${id}`, { method: 'DELETE' });
        if (res.ok) displayItems();
    } catch (err) {
        alert('Could not delete. Make sure the backend is running.');
    }
}

// --- Admin Contact Form ---
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
    } catch (err) {
        console.error('Contact send failed:', err);
    }

    alert('Message sent to admins!');
    this.reset();
    bootstrap.Modal.getInstance(document.getElementById('adminModal')).hide();
});

// --- Search ---
searchInput.addEventListener('input', function (e) {
    searchQuery = e.target.value;
    displayItems();
});

// --- Filter Tabs ---
filterButtons.forEach(button => {
    button.addEventListener('click', function () {
        filterButtons.forEach(btn => btn.classList.remove('active', 'text-white'));
        this.classList.add('active', 'text-white');
        currentFilter = this.getAttribute('data-filter');
        displayItems();
    });
});

// --- Init ---
displayItems();

function scrollToMarket() {
    document.getElementById('main-content').scrollIntoView({ behavior: 'smooth' });
}