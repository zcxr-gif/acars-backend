// tracker.js (Enhanced for Resilience & Performance)
import fetch from 'node-fetch';
import express from 'express';

// --- Configuration ---
const IF_API_KEY = process.env.IF_API_KEY;
const MAIN_APP_URL = process.env.MAIN_APP_URL; // e.g., 'https://indgo-va.onrender.com'
const ACARS_API_KEY = process.env.ACARS_API_KEY; // The shared secret key
const API_BASE_URL = 'https://api.infiniteflight.com/public/v2';
const PORT = process.env.TRACKER_PORT || 3000;
const TRACK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CYCLES_BEFORE_COMPLETION = 2; // A flight must be missing for this many cycles to be marked as complete

const app = express();

// This Map will hold our state.
// Key: flightPlanId, Value: { flightData, missingCycles }
let trackedFlightsState = new Map();

// --- Main Tracker Function ---
async function runTracker() {
    console.log(`--- [${new Date().toISOString()}] Starting ACARS Tracker Run ---`);
    if (!IF_API_KEY || !MAIN_APP_URL || !ACARS_API_KEY) {
        console.error('FATAL: One or more required environment variables are missing (IF_API_KEY, MAIN_APP_URL, ACARS_API_KEY).');
        return;
    }

    // 1. Fetch which flights we SHOULD be tracking from our main VA backend
    const flightsToTrack = await getFlightsToTrackFromMainApp();
    if (!flightsToTrack) {
        console.log('Could not fetch flights to track from main app. Ending run.');
        return;
    }

    // 2. Synchronize our state with the main backend's source of truth
    updateTrackerState(flightsToTrack);
    
    if (trackedFlightsState.size === 0) {
        console.log('No active flights to track. Ending run.');
        return;
    }

    console.log(`Currently tracking ${trackedFlightsState.size} flight(s).`);

    // 3. Fetch all live flight data from the Infinite Flight API
    const liveFlights = await getAllLiveFlights();
    if (!liveFlights) {
        console.error('Could not fetch live flight data from Infinite Flight API. Ending run.');
        return;
    }
    
    // Use a Set for highly efficient lookups (O(1) average time complexity)
    const liveUserIds = new Set(liveFlights.map(f => f.userId));

    // 4. Process each tracked flight to check its status
    const endedFlightPlanIds = [];

    for (const [flightPlanId, flightState] of trackedFlightsState.entries()) {
        const isStillLive = liveUserIds.has(flightState.flightData.userId);

        if (isStillLive) {
            // Flight is active, reset its missing counter if it was missing before.
            if (flightState.missingCycles > 0) {
                console.log(`Flight ${flightState.flightData.callsign} (${flightPlanId}) has reappeared. Resetting grace period.`);
                flightState.missingCycles = 0;
            }
        } else {
            // Flight is NOT live. Increment the missing counter.
            flightState.missingCycles++;
            console.log(`Flight ${flightState.flightData.callsign} (${flightPlanId}) is missing. Grace period cycle: ${flightState.missingCycles}/${CYCLES_BEFORE_COMPLETION}.`);
            
            if (flightState.missingCycles >= CYCLES_BEFORE_COMPLETION) {
                endedFlightPlanIds.push(flightPlanId);
            }
        }
    }

    // 5. Report completed flights to the main backend
    if (endedFlightPlanIds.length > 0) {
        console.log(`Detected ${endedFlightPlanIds.length} ended flight(s) after grace period. Reporting to main backend...`);
        for (const flightPlanId of endedFlightPlanIds) {
            await completeFlightInMainApp(flightPlanId);
            // Remove from our state map immediately after reporting
            trackedFlightsState.delete(flightPlanId);
        }
    } else {
        console.log('No flights have passed the grace period in this cycle.');
    }
    
    console.log(`--- ACARS Tracker Run Complete. Next run in ${TRACK_INTERVAL_MS / 60000} minutes. ---`);
}

// --- Helper Functions ---

/**
 * Synchronizes the local tracker state with the list of active flights from the main app.
 * This ensures the tracker always reflects the backend's "source of truth".
 * @param {Array} currentActiveFlights - The array of flights from the main app's API.
 */
function updateTrackerState(currentActiveFlights) {
    const activeFlightPlanIds = new Set(currentActiveFlights.map(f => f.flightPlanId));

    // Remove flights from state that are no longer active on the backend
    for (const flightPlanId of trackedFlightsState.keys()) {
        if (!activeFlightPlanIds.has(flightPlanId)) {
            console.log(`Flight ${flightPlanId} is no longer active in the backend. Removing from tracker state.`);
            trackedFlightsState.delete(flightPlanId);
        }
    }

    // Add new flights to state that were not tracked before
    for (const flight of currentActiveFlights) {
        if (!trackedFlightsState.has(flight.flightPlanId)) {
            console.log(`New active flight detected: ${flight.callsign} (${flight.flightPlanId}). Adding to tracker state.`);
            trackedFlightsState.set(flight.flightPlanId, {
                flightData: flight,
                missingCycles: 0 // Start with zero missing cycles
            });
        }
    }
}


async function getFlightsToTrackFromMainApp() {
    try {
        const response = await fetch(`${MAIN_APP_URL}/api/acars/tracked-flights`, {
            headers: { 'X-ACARS-API-Key': ACARS_API_KEY }
        });
        if (!response.ok) {
            console.error(`Error fetching tracked flights: ${response.status} ${response.statusText}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('API Error (getFlightsToTrackFromMainApp):', error.message);
        return null;
    }
}

async function completeFlightInMainApp(flightPlanId) {
    try {
        const flightInfo = trackedFlightsState.get(flightPlanId)?.flightData;
        const callsign = flightInfo ? flightInfo.callsign : 'Unknown';

        console.log(`Reporting completion for Flight Plan ID: ${flightPlanId} (Callsign: ${callsign})...`);
        const response = await fetch(`${MAIN_APP_URL}/api/acars/complete-flight`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-ACARS-API-Key': ACARS_API_KEY
            },
            body: JSON.stringify({ flightPlanId })
        });

        if (response.ok) {
            console.log(`Successfully reported completion for ${callsign}.`);
        } else {
            const errorBody = await response.json();
            console.error(`Failed to report completion for ${callsign}. Status: ${response.status}. Reason: ${errorBody.message}`);
        }
    } catch (error) {
        console.error('API Error (completeFlightInMainApp):', error.message);
    }
}

async function getAllLiveFlights() {
    try {
        const sessionsResponse = await fetch(`${API_BASE_URL}/sessions?apikey=${IF_API_KEY}`);
        if (!sessionsResponse.ok) {
            console.error(`Infinite Flight API Error (Sessions): ${sessionsResponse.status}`);
            return null;
        }
        const sessions = await sessionsResponse.json();
        
        // Find any server that is a "Live" server (Expert or Training)
        const liveServer = sessions.result.find(s => s.type === "Live");
        if (!liveServer) {
            console.log("No live server (Expert/Training) found.");
            return []; // Return empty array, not null
        }

        const flightsResponse = await fetch(`${API_BASE_URL}/sessions/${liveServer.id}/flights?apikey=${IF_API_KEY}`);
        if (!flightsResponse.ok) {
             console.error(`Infinite Flight API Error (Flights): ${flightsResponse.status}`);
            return null;
        }
        const flights = await flightsResponse.json();
        return flights.result;
    } catch (error) {
        console.error('Infinite Flight API Fetch Error:', error);
        return null;
    }
}


// --- Express Server and Scheduled Execution ---
app.get('/', (req, res) => {
  res.send('IndGo VA ACARS Tracker is running.');
});

// Set the tracker to run on its defined interval
setInterval(runTracker, TRACK_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`Tracker server is running on port ${PORT}`);
    // Run the tracker once on startup after a short delay
    console.log('Running initial tracker sync on startup...');
    setTimeout(runTracker, 5000); // 5-second delay to allow services to settle
});