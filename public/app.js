document.addEventListener('DOMContentLoaded', () => {
    const API_BASE_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run';
    const trackersContainer = document.getElementById('trackers-container');
    const startTrackerForm = document.getElementById('start-tracker-form');
    const errorMessage = document.getElementById('error-message');

    // Modal elements
    const modal = document.getElementById('details-modal');
    const modalContent = document.getElementById('modal-details-content');
    const closeModal = document.querySelector('.close-button');

    // --- NEW: Live Log Elements ---
    const logContainer = document.getElementById('live-log-container');
    const logList = document.getElementById('live-log-list');
    const MAX_LOG_ENTRIES = 100; // Prevents the DOM from getting too large

    // --- NEW: Live Log Function ---
    /**
     * Adds a message to the on-screen live log.
     * @param {string} message The message to display.
     * @param {'info' | 'success' | 'warn' | 'error'} level The log level for styling.
     */
    const logToConsole = (message, level = 'info') => {
        try {
            // 1. Create the log entry
            const li = document.createElement('li');
            const time = new Date().toLocaleTimeString();
            
            // Sanitize message to prevent HTML injection
            const messageText = document.createTextNode(message);
            
            li.className = `log-${level}`;
            li.innerHTML = `<span class="log-time">[${time}]</span> `;
            li.appendChild(messageText); // Append sanitized text

            // 2. Add to list
            logList.appendChild(li);

            // 3. Auto-scroll to bottom
            logContainer.scrollTop = logContainer.scrollHeight;

            // 4. Prune old log entries
            if (logList.children.length > MAX_LOG_ENTRIES) {
                logList.removeChild(logList.firstElementChild);
            }
        } catch (error) {
            console.error("Failed to write to live log:", error);
        }
    };


    // --- Core Functions (Updated with Logging) ---

    const fetchActiveTrackers = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/track/active`);
            if (!response.ok) {
                logToConsole(`Failed to fetch from backend (Status: ${response.status}).`, 'error');
                throw new Error('Failed to fetch from backend.');
            }
            const data = await response.json();
            renderTrackers(data.trackers);
            errorMessage.textContent = '';
            
            // Only log success on refresh, not on initial load (handled below)
            if (document.readyState === 'complete') { // Check if page is already loaded
                 logToConsole(`Refreshed tracker list. ${data.trackers.length} active.`, 'info');
            }
        } catch (error) {
            console.error('Error fetching trackers:', error);
            logToConsole(`Connection Error: ${error.message}. Is the backend running?`, 'error');
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

    // --- API Call Handlers (Updated with Logging) ---

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
            
            // Log success *before* refreshing the list
            const action = url.split('/').pop();
            const targetId = url.split('/')[4] || (body ? body.username : '');
            logToConsole(`Action '${action}' on '${targetId}' was successful.`, 'success');

            fetchActiveTrackers(); // Refresh list on success
        } catch (error) {
            console.error(`Error with ${method} ${url}:`, error);
            logToConsole(error.message, 'error'); // Log the error to our new console
            errorMessage.textContent = error.message; // Also keep updating the old error message
        }
    };

    // --- Event Listeners (Updated with Logging) ---

    startTrackerForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const server = document.getElementById('server').value;
        
        logToConsole(`Sending START request for ${username} on ${server}...`, 'warn');
        
        handleApiAction(`${API_BASE_URL}/track/start`, 'POST', { username, server });
        startTrackerForm.reset();
        document.getElementById('server').value = "Expert Server"; // Restore default
    });

    trackersContainer.addEventListener('click', (e) => {
        const trackerId = e.target.dataset.id;
        if (!trackerId) return;

        if (e.target.classList.contains('btn-stop')) {
            logToConsole(`Sending STOP request for tracker ${trackerId}...`, 'warn');
            handleApiAction(`${API_BASE_URL}/track/${trackerId}/stop`, 'POST');
        } else if (e.target.classList.contains('btn-delay')) {
            logToConsole(`Sending DELAY request for tracker ${trackerId}...`, 'warn');
            handleApiAction(`${API_BASE_URL}/track/${trackerId}/delay`, 'POST');
        } else if (e.target.classList.contents('btn-details')) {
            logToConsole(`Fetching details for tracker ${trackerId}...`, 'info');
            showDetailsModal(trackerId);
        }
    });

    const showDetailsModal = async (trackerId) => {
        try {
            const response = await fetch(`${API_BASE_URL}/track/${trackerId}`);
            if (!response.ok) throw new Error(`Server returned status ${response.status}`);
            const data = await response.json();
            
            logToConsole(`Successfully fetched details for ${trackerId}.`, 'success');
            modalContent.textContent = JSON.stringify(data.tracker, null, 2);
            modal.style.display = 'block';
        } catch (error) {
            logToConsole(`Could not fetch details for ${trackerId}: ${error.message}`, 'error');
            errorMessage.textContent = 'Could not fetch tracker details.';
        }
    };
    
    closeModal.onclick = () => { modal.style.display = 'none'; };
    window.onclick = (event) => {
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    };

    // --- Initial Load & Interval (Updated with Logging) ---
    logToConsole('Dashboard online. Performing initial tracker fetch...', 'info');
    fetchActiveTrackers(); // Initial fetch
    
    // The 5-second interval will now log its own refreshes via the updated fetchActiveTrackers
    setInterval(fetchActiveTrackers, 5000); 
});