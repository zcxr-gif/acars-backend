document.addEventListener('DOMContentLoaded', () => {
    const API_BASE_URL = 'https://acars-backend-uxln.onrender.com';
    const trackersContainer = document.getElementById('trackers-container');
    const startTrackerForm = document.getElementById('start-tracker-form');
    const errorMessage = document.getElementById('error-message');

    // Modal elements
    const modal = document.getElementById('details-modal');
    const modalContent = document.getElementById('modal-details-content');
    const closeModal = document.querySelector('.close-button');

    // --- Core Functions ---

    const fetchActiveTrackers = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/track/active`);
            if (!response.ok) throw new Error('Failed to fetch from backend.');
            const data = await response.json();
            renderTrackers(data.trackers);
            errorMessage.textContent = '';
        } catch (error) {
            console.error('Error fetching trackers:', error);
            trackersContainer.innerHTML = `<p class="error-text">Could not connect to the backend at ${API_BASE_URL}. Is it running?</p>`;
        }
    };

    const renderTrackers = (trackers) => {
        if (!trackers || trackers.length === 0) {
            trackersContainer.innerHTML = '<p>No active trackers found.</p>';
            return;
        }

        trackersContainer.innerHTML = ''; // Clear previous content
        trackers.forEach(tracker => {
            const card = document.createElement('div');
            card.className = 'tracker-card';
            card.innerHTML = `
                <div class="tracker-header">
                    <span class="tracker-title">${tracker.username}</span>
                    <span class="tracker-status status-${tracker.status.toLowerCase()}">${tracker.status}</span>
                </div>
                <div class="tracker-info">
                    <p><strong>Server:</strong> ${tracker.server}</p>
                    <p><strong>Next Poll:</strong> ${new Date(tracker.nextPollAt).toLocaleTimeString()}</p>
                    <p><strong>ID:</strong> ${tracker.id}</p>
                </div>
                <div class="tracker-actions">
                    <button class="btn-details" data-id="${tracker.id}">Details</button>
                    <button class="btn-delay" data-id="${tracker.id}">Delay Next Poll (5m)</button>
                    <button class="btn-stop" data-id="${tracker.id}">Stop</button>
                </div>
            `;
            trackersContainer.appendChild(card);
        });
    };

    // --- API Call Handlers ---

    const handleApiAction = async (url, method, body = null) => {
        try {
            const options = {
                method,
                headers: { 'Content-Type': 'application/json' },
            };
            if (body) options.body = JSON.stringify(body);

            const response = await fetch(url, options);
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error?.message || 'API action failed');
            }
            fetchActiveTrackers(); // Refresh list on success
        } catch (error) {
            console.error(`Error with ${method} ${url}:`, error);
            errorMessage.textContent = error.message;
        }
    };

    // --- Event Listeners ---

    startTrackerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const server = document.getElementById('server').value;
        handleApiAction(`${API_BASE_URL}/track/start`, 'POST', { username, server });
        startTrackerForm.reset();
        document.getElementById('server').value = "Expert Server"; // Restore default
    });

    trackersContainer.addEventListener('click', (e) => {
        const trackerId = e.target.dataset.id;
        if (!trackerId) return;

        if (e.target.classList.contains('btn-stop')) {
            handleApiAction(`${API_BASE_URL}/track/${trackerId}/stop`, 'POST');
        } else if (e.target.classList.contains('btn-delay')) {
            handleApiAction(`${API_BASE_URL}/track/${trackerId}/delay`, 'POST');
        } else if (e.target.classList.contains('btn-details')) {
            showDetailsModal(trackerId);
        }
    });

    const showDetailsModal = async (trackerId) => {
        try {
            const response = await fetch(`${API_BASE_URL}/track/${trackerId}`);
            const data = await response.json();
            modalContent.textContent = JSON.stringify(data.tracker, null, 2);
            modal.style.display = 'block';
        } catch (error) {
            errorMessage.textContent = 'Could not fetch tracker details.';
        }
    };
    
    closeModal.onclick = () => { modal.style.display = 'none'; };
    window.onclick = (event) => {
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    };

    // --- Initial Load & Interval ---
    fetchActiveTrackers(); // Initial fetch
    setInterval(fetchActiveTrackers, 5000); // Refresh every 5 seconds
});