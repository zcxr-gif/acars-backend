// live_flights.js
// Description: A dedicated microservice to fetch live flights for a specific
// Virtual Airline from the Infinite Flight Live API.

// 1. IMPORT DEPENDENCIES
const express = require('express');
const axios = require('axios'); // To make requests to the IF API
const cors = require('cors');
require('dotenv').config();

// 2. INITIALIZE EXPRESS APP & CONSTANTS
const app = express();
// Use a different port than your main backend to avoid conflicts if you run them locally
const PORT = process.env.PORT || 5001; 

// --- Configuration ---
// IMPORTANT: You MUST get an API key from https://api.infiniteflight.com/
const IF_API_KEY = process.env.INFINITE_FLIGHT_API_KEY;
const IF_API_BASE_URL = 'https://api.infiniteflight.com/v2';

// We now only need the callsign prefix for filtering
const VA_CALLSIGN_PREFIX = 'GO';
const TARGET_SERVER_NAME = 'Expert Server';

// 3. MIDDLEWARE
// Allow requests from your front-end application
const corsOptions = {
    origin: 'https://indgo-va.netlify.app', // Your frontend URL
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());


// 4. API ROUTE
app.get('/api/live-flights', async (req, res) => {
    // First, validate that the API key is configured on the server
    if (!IF_API_KEY) {
        console.error('CRITICAL: INFINITE_FLIGHT_API_KEY is not configured in environment variables.');
        return res.status(500).json({ message: 'Server configuration error. Cannot connect to the flight service.' });
    }

    try {
        // --- Step 1: Get all available servers (called "sessions") to find the Expert Server's ID ---
        console.log('Fetching server list from Infinite Flight API...');
        const sessionsResponse = await axios.get(`${IF_API_BASE_URL}/sessions`, {
            headers: { 'Authorization': `Bearer ${IF_API_KEY}` }
        });

        const expertServer = sessionsResponse.data.result.find(s => s.name === TARGET_SERVER_NAME);

        if (!expertServer) {
            console.log(`'${TARGET_SERVER_NAME}' is not currently active.`);
            // Return an empty array if the server isn't up, which is a normal state.
            return res.json([]);
        }
        
        const expertServerId = expertServer.id;
        console.log(`Found '${TARGET_SERVER_NAME}' with ID: ${expertServerId}`);

        // --- Step 2: Get all flights currently on the Expert Server ---
        console.log(`Fetching all flights for server ID: ${expertServerId}`);
        const flightsResponse = await axios.get(`${IF_API_BASE_URL}/flights/${expertServerId}`, {
            headers: { 'Authorization': `Bearer ${IF_API_KEY}` }
        });

        const allFlights = flightsResponse.data.result;
        console.log(`Found a total of ${allFlights.length} flights on the server.`);

        // --- Step 3: Filter the flights to find only those with the VA callsign ---
        const vaFlights = allFlights.filter(flight => {
            // **MODIFIED LOGIC**: We now only check if the callsign starts with the VA prefix.
            return flight.callsign && flight.callsign.trim().toUpperCase().startsWith(VA_CALLSIGN_PREFIX);
        });

        console.log(`Filtered down to ${vaFlights.length} flights with callsign prefix '${VA_CALLSIGN_PREFIX}'.`);
        
        // --- Step 4: Send the filtered list back to the client ---
        res.status(200).json(vaFlights);

    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error(`Error from Infinite Flight API: Status ${error.response.status}`, error.response.data);
            if (error.response.status === 401) {
                 return res.status(500).json({ message: 'Authentication error with the flight API. Check the server API key.' });
            }
            return res.status(500).json({ message: `Error fetching flight data: ${error.response.statusText}` });
        } else if (error.request) {
            // The request was made but no response was received
            console.error('Error: No response received from Infinite Flight API.', error.request);
            return res.status(503).json({ message: 'The flight data service is currently unavailable.' });
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error('An unexpected error occurred:', error.message);
            return res.status(500).json({ message: 'An internal server error occurred.' });
        }
    }
});


// 5. START THE SERVER
app.listen(PORT, () => {
    console.log(`IndGo Air Virtual Live Flight Tracker is running on http://localhost:${PORT}`);
});