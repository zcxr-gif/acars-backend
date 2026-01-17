import Redis from 'ioredis';

// Connect to Redis using the Environment Variable
const redis = new Redis(process.env.REDIS_URI);

/**
 * Saves a single point for a flight and manages the 3-flight limit.
 */
export async function updateFlightPath(flight) {
  if (!flight.flightId || !flight.position.lat) return;

  const key = `path:${flight.flightId}`;
  const registryKey = `recent_flights_list`; // Registry to track the 3 most recent flights
  
  // Compact string format: "lat,lon,alt,gs,hdg,timestamp"
  const point = [
    flight.position.lat,
    flight.position.lon,
    flight.position.alt_ft,
    flight.position.gs_kt,
    flight.position.heading_deg,
    Date.now()
  ].join(',');

  const pipeline = redis.pipeline();
  
  // 1. Add point to the flight path and keep the "tail" length at 500 points
  pipeline.rpush(key, point);
  pipeline.ltrim(key, -500, -1);
  
  // 2. Set expiry to 86400 seconds (24 hours)
  pipeline.expire(key, 86400); 

  // 3. Update the registry of the 3 most recent flights
  pipeline.lrem(registryKey, 0, flight.flightId);
  pipeline.lpush(registryKey, flight.flightId);
  
  // 4. Cap the registry at 3 items.
  pipeline.ltrim(registryKey, 0, 2);
  
  await pipeline.exec().catch(err => console.error(`[redis] Update failed for ${flight.flightId}:`, err.message));
}

/**
 * Retrieves the full path for a specific flight
 */
export async function getFlightPath(flightId) {
  const rawPoints = await redis.lrange(`path:${flightId}`, 0, -1);
  return rawPoints.map(p => {
    const [lat, lon, alt, gs, hdg, time] = p.split(',');
    return {
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      alt: parseInt(alt),
      gs: parseInt(gs),
      hdg: parseInt(hdg),
      timestamp: parseInt(time)
    };
  });
}

/**
 * Optional: Helper to get the IDs of the 3 most recent flights
 */
export async function getRecentFlightIds() {
  return await redis.lrange(`recent_flights_list`, 0, -1);
}