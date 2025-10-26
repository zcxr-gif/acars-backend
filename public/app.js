document.addEventListener('DOMContentLoaded', () => {
    const API_BASE_URL = 'https://site--acars-backend--6dmjph8ltlhv.code.run';
    const trackersContainer = document.getElementById('trackers-container');
    const startTrackerForm = document.getElementById('start-tracker-form');
    const errorMessage = document.getElementById('error-message');

    // Modal elements
    const modal = document.getElementById('details-modal');
    const modalContent = document.getElementById('modal-details-content');
    const closeModal = document.querySelector('.close-button');
    
    // --- NEW: Interval timer for the details modal poll ---
    let detailsPollInterval = null;

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
        } else if (e.target.classList.contains('btn-details')) {
            logToConsole(`Fetching details for tracker ${trackerId}...`, 'info');
            showDetailsModal(trackerId);
        }
    });


    // --- ⬇️ NEW: Modal Rendering Functions ---

    /**
     * Renders the detailed tracker data into the modal.
     * @param {object} tracker The full tracker object from the API.
     */
    const renderTrackerDetails = (tracker) => {
        // Clear old content
        modalContent.innerHTML = '';

        // --- 1. State Summary ---
        const stateDiv = document.createElement('div');
        stateDiv.className = 'modal-section';
        stateDiv.innerHTML = `
            <h3>Current State</h3>
            <div class="state-grid">
                <p><strong>Username:</strong> ${tracker.username}</p>
                <p><strong>Server:</strong> ${tracker.server}</p>
                <p><strong>Status:</strong> <span class="status-${tracker.status.toLowerCase()}">${tracker.status}</span></p>
                <p><strong>Tracker ID:</strong> ${tracker.id}</p>
                <p><strong>Last Seen:</strong> ${tracker.lastSeenAt ? new Date(tracker.lastSeenAt).toLocaleString() : 'N/A'}</p>
                <p><strong>Next Poll:</strong> ${tracker.nextPollAt ? new Date(tracker.nextPollAt).toLocaleString() : 'N/A'}</p>
            </div>
        `;
        modalContent.appendChild(stateDiv);

        // --- 2. Event Log ---
        const logDiv = document.createElement('div');
        logDiv.className = 'modal-section';
        logDiv.innerHTML = '<h3>Event Log (Newest First)</h3>';
        
        const logList = document.createElement('ul');
        logList.className = 'modal-log-list';

        if (tracker.history && tracker.history.length > 0) {
            // Backend already sorts newest first
            tracker.history.forEach(entry => {
                const li = document.createElement('li');
                // Use event type for color coding
                li.className = `log-${entry.event.toLowerCase()}`;
                
                // Sanitize message
                const messageText = document.createTextNode(entry.message || entry.event);
                const timeSpan = document.createElement('span');
                timeSpan.className = 'log-time';
                timeSpan.textContent = `[${new Date(entry.timestamp).toLocaleString()}]`;
                
                li.appendChild(timeSpan);
                li.appendChild(document.createTextNode(' ')); // space
                li.appendChild(messageText);

                // Add extra details if they exist
                if (entry.airport) {
                    const detailSpan = document.createElement('span');
                    detailSpan.className = 'log-detail';
                    detailSpan.textContent = ` (Airport: ${entry.airport})`;
                    li.appendChild(detailSpan);
                }
                
                logList.appendChild(li);
            });
        } else {
            logList.innerHTML = '<li>No history events found.</li>';
        }
        
        logDiv.appendChild(logList);
        modalContent.appendChild(logDiv);

        // --- 3. Raw Flight Data (for debugging) ---
        const flightDiv = document.createElement('div');
        flightDiv.className = 'modal-section';
        flightDiv.innerHTML = '<h3>Raw Flight Data (Last Known)</h3>';
        
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(tracker.flight || tracker.lastKnownFlight || { info: "No flight data available." }, null, 2);
        flightDiv.appendChild(pre);
        modalContent.appendChild(flightDiv);
    };

    /**
     * Fetches and renders tracker details. This is separated
     * to be called by an interval.
     */
    const fetchAndRenderDetails = async (trackerId) => {
        try {
            const response = await fetch(`${API_BASE_URL}/track/${trackerId}`);
            if (!response.ok) throw new Error(`Server returned status ${response.status}`);
            const data = await response.json();
            
            renderTrackerDetails(data.tracker);
        } catch (error) {
            logToConsole(`Could not fetch details for ${trackerId}: ${error.message}`, 'error');
            // Show error in modal instead of just console
            modalContent.innerHTML = `<p class="error-text">Could not fetch tracker details: ${error.message}</p>`;
            // Stop polling if it fails
            if (detailsPollInterval) clearInterval(detailsPollInterval);
        }
    };

    /**
     * ⬇️ MODIFIED: This function now opens the modal and starts a 3-second
     * polling interval to keep the data live.
     */
    const showDetailsModal = async (trackerId) => {
        // Clear any previous interval
        if (detailsPollInterval) {
            clearInterval(detailsPollInterval);
        }

        // Set loading state
        modalContent.innerHTML = '<p>Loading tracker details...</p>';
        modal.style.display = 'block';

        // Fetch and render immediately
        await fetchAndRenderDetails(trackerId);

        // Start polling for live updates
        detailsPollInterval = setInterval(() => fetchAndRenderDetails(trackerId), 3000);
    };
    
    // ⬇️ MODIFIED: Must clear interval when modal is closed
    closeModal.onclick = () => { 
        modal.style.display = 'none'; 
        if (detailsPollInterval) clearInterval(detailsPollInterval);
    };
    
    // ⬇️ MODIFIED: Must clear interval when modal is closed
    window.onclick = (event) => {
        if (event.target === modal) {
            modal.style.display = 'none';
            if (detailsPollInterval) clearInterval(detailsPollInterval);
        }
    };

    // --- Initial Load & Interval (Updated with Logging) ---
    logToConsole('Dashboard online. Performing initial tracker fetch...', 'info');
    fetchActiveTrackers(); // Initial fetch
    
    // The 5-second interval will now log its own refreshes via the updated fetchActiveTrackers
    setInterval(fetchActiveTrackers, 5000); 
});