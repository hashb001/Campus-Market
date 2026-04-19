
let items = [
    { id: 1, productName: 'Calculus Early Transcendentals',itemInfo: '8th Edition. Like new, no highlights.', sellerName: 'Niloy', sellerNumber: '01773474655', image: 'https://images2.pangobooks.com/images/f4ca6d30-f21e-4d93-aa11-a0eac5a1433a?auto=webp&format=webp&height=300&quality=85&crop=5%3A6', category: 'Book', listingType: 'Sell' },
    { id: 2, productName: 'Arduino Uno R3 Kit', itemInfo: 'Used for one semester. All cables included.',sellerName: 'Shuaib', sellerNumber: '01878063947', image: 'https://img.drz.lazcdn.com/static/bd/p/2153f33e9d0a7ec5f713515a22b24758.jpg_720x720q80.jpg', category: 'Hardware', listingType: 'Exchange' },
    { id: 3, productName: 'Physics 101 Lecture Notes',itemInfo: 'All lectures noted down.', sellerName: 'Nahrin', sellerNumber: '01306319937', image: 'https://specials-images.forbesimg.com/imageserve/693c99ccd62c62e207a66649/Various-writing-tablets-on-a-table-with-an-illustrative-blue-background/960x0.png?fit=scale', category: 'Notes', listingType: 'Sell' },
    { id: 4, productName: 'Raspberry Pi 4', itemInfo: 'Used for one semester. All cables included.',sellerName: 'Nibir', sellerNumber: '01773474655', image: 'https://picockpit.com/raspberry-pi/wp-content/uploads/2023/09/rpi41-1024x768.jpg', category: 'Hardware', listingType: 'Sell' }
];


let currentFilter = 'All'; 
let searchQuery = '';


const form = document.getElementById('listingForm');
const listingsContainer = document.getElementById('marketplace-listings');
const searchInput = document.getElementById('searchInput');
const filterButtons = document.querySelectorAll('.filter-btn');
const noResultsDiv = document.getElementById('noResults');


function displayItems() {
    listingsContainer.innerHTML = ''; 
    
    
    let filteredItems = items.filter(item => {
        
        let matchesType = (currentFilter === 'All') || (item.listingType === currentFilter);
        
        
        let query = searchQuery.toLowerCase();
        let matchesSearch = item.productName.toLowerCase().includes(query) || 
                            item.category.toLowerCase().includes(query);
        
        return matchesType && matchesSearch;
    });

    
    if (filteredItems.length === 0) {
        noResultsDiv.classList.remove('d-none');
    } else {
        noResultsDiv.classList.add('d-none');
    }

    
    filteredItems.forEach(item => {
        let isSell = item.listingType === 'Sell';
        let badgeClass = isSell ? 'bg-secondary' : 'bg-warning text-dark';
        let iconClass = isSell ? 'bi-currency-dollar' : 'bi-arrow-left-right';

        let colDiv = document.createElement('div');
        colDiv.className = 'col-md-6 mb-4';
        
        colDiv.innerHTML = `
            <div class="card shadow-sm h-100 border-0 rounded-4">
                <img src="${item.image}" class="card-img-top img-fluid marketplace-img" alt="${item.productName}">
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
                </div>
            </div>
        `;
        listingsContainer.appendChild(colDiv);
    });
}


// Handle Form Submission with Local Image Upload
form.addEventListener('submit', function(event) {
    event.preventDefault(); 

    
    const fileInput = document.getElementById('imageInput');
    const file = fileInput.files[0];

   
    if (file) {
        
        const reader = new FileReader();
        
        reader.onload = function(e) {
            
            let imageDataUrl = e.target.result;

            let newItem = {
                id: Date.now(),
                productName: document.getElementById('productName').value,
                itemInfo: document.getElementById('itemInfo').value,
                sellerName: document.getElementById('sellerName').value,
                sellerNumber: document.getElementById('sellerNumber').value,
                category: document.getElementById('category').value,
                listingType: document.getElementById('listingType').value
            };

            items.unshift(newItem); 
            displayItems();         
            form.reset();           
        };

        
        reader.readAsDataURL(file);
    }
});


searchInput.addEventListener('input', function(e) {
    searchQuery = e.target.value;
    displayItems();
});


filterButtons.forEach(button => {
    button.addEventListener('click', function(e) {
     
        filterButtons.forEach(btn => btn.classList.remove('active', 'text-white'));
        
        
        this.classList.add('active', 'text-white');
        
       
        currentFilter = this.getAttribute('data-filter');
        displayItems();
    });
});


displayItems();

function scrollToMarket() {
    document.getElementById('main-content').scrollIntoView({ 
        behavior: 'smooth' 
    });
}