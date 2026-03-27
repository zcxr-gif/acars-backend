/* =========================
 * Premium Telemetry Engine
 * ========================= */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure the data directory exists
const dbPath = path.join(__dirname, 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

// Initialize SQLite Database
const db = new Database(path.join(dbPath, 'telemetry.db'));

// Create the time-series table optimized for interval snapshots
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    active_sockets INTEGER,
    api_requests INTEGER,
    unique_ips INTEGER
  );
  
  CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_stats(timestamp);
`);

// In-Memory Accumulators (Reset after each snapshot)
let currentIntervalRequests = 0;
const activeIps = new Set();

/**
 * Records an incoming HTTP request and tracks unique IP addresses.
 * Call this via Express middleware.
 */
function recordApiHit(ip) {
    currentIntervalRequests++;
    if (ip) {
        // Strip IPv6 mapping for cleaner IP tracking if necessary
        const cleanIp = ip.replace(/^.*:/, '');
        activeIps.add(cleanIp);
    }
}

/**
 * Takes a snapshot of the current traffic and writes it to the database.
 * Call this via a setInterval loop.
 */
function saveSnapshot(activeSocketsCount) {
    const stmt = db.prepare(`
        INSERT INTO usage_stats (active_sockets, api_requests, unique_ips) 
        VALUES (?, ?, ?)
    `);
    
    stmt.run(activeSocketsCount, currentIntervalRequests, activeIps.size);

    // Reset accumulators for the next time window
    currentIntervalRequests = 0;
    activeIps.clear();
}

/**
 * Retrieves aggregated analytical data for the frontend dashboard.
 * Groups data by Date and Hour to show trends and peak times.
 */
function getAnalytics(daysBack = 7) {
    const stmt = db.prepare(`
        SELECT 
            date(timestamp) as record_date,
            strftime('%H:00', timestamp) as record_hour,
            MAX(active_sockets) as peak_concurrent_users,
            SUM(api_requests) as total_api_requests,
            MAX(unique_ips) as peak_unique_ips
        FROM usage_stats
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY record_date, record_hour
        ORDER BY record_date DESC, record_hour DESC
    `);

    const rawData = stmt.all(daysBack);
    
    // Process the data into an easily graphable format
    const summary = {
        totalDaysTracked: 0,
        highestPeakUsers: 0,
        totalRequestsWindow: 0, // FIXED: Added missing property expected by frontend
        busiestDay: null,
        busiestHour: null,
        hourlyBreakdown: []
    };

    const dayMap = new Map();

    rawData.forEach(row => {
        // Find highest peak concurrent users
        if (row.peak_concurrent_users > summary.highestPeakUsers) {
            summary.highestPeakUsers = row.peak_concurrent_users;
            summary.busiestHour = `${row.record_date} @ ${row.record_hour}`;
        }
        
        // FIXED: Accumulate total requests for the dashboard KPI
        summary.totalRequestsWindow += row.total_api_requests;

        // Track daily totals for "Busiest Day" metric
        const currentDayTotal = dayMap.get(row.record_date) || 0;
        dayMap.set(row.record_date, currentDayTotal + row.total_api_requests);
    });

    summary.totalDaysTracked = dayMap.size;
    
    if (dayMap.size > 0) {
        // Find the day with the highest API request volume
        const sortedDays = [...dayMap.entries()].sort((a, b) => b[1] - a[1]);
        summary.busiestDay = {
            date: sortedDays[0][0],
            requests: sortedDays[0][1]
        };
    }

    // FIXED: Reverse the data so Chart.js plots left-to-right chronologically (oldest -> newest)
    summary.hourlyBreakdown = rawData.reverse();

    return summary;
}

module.exports = {
    recordApiHit,
    saveSnapshot,
    getAnalytics
};