import fetch from 'node-fetch';
import fs from 'fs/promises';

// --- Configuration ---
const IF_API_KEY = process.env.IF_API_KEY; // Your API key from environment variables
const TRACKING_FILE = 'flights_to_track.json';
const LOG_FILE = 'flight_logs.json';
const API_BASE_URL = 'https://api.infiniteflight.com/public/v2';

// --- Main Function ---
async function runTracker() {
    if (!IF_API_KEY) {
        console.error('ERROR: Infinite Flight API key is not set in environment variables.');
        return;
    }

    // 1. Read which flights we need to track
    let activeFlights;
    try {
        const trackingData = await fs.readFile(TRACKING_FILE);
        activeFlights = JSON.parse(trackingData);
    } catch (error) {
        console.log('No active flights to track or file not found. Exiting.');
        return;
    }

    if (activeFlights.length === 0) {
        console.log('No flights in the tracking list.');
        return;
    }

    console.log(`Searching for ${activeFlights.length} active flight(s)...`);

    // 2. Fetch live flight data from the API
    const liveFlights = await getAllLiveFlights();
    if (!liveFlights) {
        console.error('Could not fetch live flight data.');
        return;
    }

    // 3. Process each flight we're tracking
    const remainingFlights = [];
    const flightLogs = await getFlightLogs();

    for (const flight of activeFlights) {
        const liveData = liveFlights.find(f => f.userId === flight.userId && f.callsign === flight.callsign);

        if (liveData) {
            // Flight is active and found!
            console.log(`Tracking ${flight.callsign}...`);
            logPosition(flightLogs, flight, liveData);
            remainingFlights.push(flight); // Keep it in the list for the next run
        } else {
            // Flight has landed or disconnected
            console.log(`Flight ${flight.callsign} has ended. Stopping tracking.`);
            // We simply don't add it back to the `remainingFlights` array.
        }
    }

    // 4. Save the updated flight logs and the list of flights that are still active
    await fs.writeFile(LOG_FILE, JSON.stringify(flightLogs, null, 2));
    await fs.writeFile(TRACKING_FILE, JSON.stringify(remainingFlights, null, 2));
    console.log('Tracker run complete.');
}

// --- Helper Functions ---

async function getAllLiveFlights() {
    try {
        const sessionsResponse = await fetch(`${API_BASE_URL}/sessions?apikey=${IF_API_KEY}`);
        const sessions = await sessionsResponse.json();
        const expertServerId = sessions.result.find(s => s.name === "Expert Server")?.id;

        if (!expertServerId) {
            console.log("Expert Server not found.");
            return null;
        }

        const flightsResponse = await fetch(`${API_BASE_URL}/sessions/${expertServerId}/flights?apikey=${IF_API_KEY}`);
        const flights = await flightsResponse.json();
        return flights.result;
    } catch (error) {
        console.error('API Fetch Error:', error);
        return null;
    }
}

async function getFlightLogs() {
    try {
        const data = await fs.readFile(LOG_FILE);
        return JSON.parse(data);
    } catch (error) {
        return {}; // Return an empty object if the file doesn't exist
    }
}

function logPosition(logs, trackedFlight, liveData) {
    const flightId = trackedFlight.flightId; // Use a unique ID you assign
    if (!logs[flightId]) {
        logs[flightId] = {
            callsign: liveData.callsign,
            userId: liveData.userId,
            positions: []
        };
    }

    const positionReport = {
        timestamp: new Date().toISOString(),
        latitude: liveData.latitude,
        longitude: liveData.longitude,
        altitude: liveData.altitude,
        speed: liveData.speed,
        track: liveData.track
    };
    logs[flightId].positions.push(positionReport);
}

// --- Start the process ---
runTracker();