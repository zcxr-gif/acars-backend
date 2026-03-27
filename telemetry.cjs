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

// Premium Database Optimizations for Space, Safety, and Concurrency
db.pragma('journal_mode = WAL'); 
db.pragma('synchronous = NORMAL');
db.pragma('auto_vacuum = FULL');

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
 * * @param {string} ip - The incoming request IP
 */
function recordApiHit(ip) {
    currentIntervalRequests++;
    
    if (ip) {
        // Accurately strip IPv4-mapped IPv6 prefix without breaking pure IPv6
        const cleanIp = ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip;
        activeIps.add(cleanIp);
    }
}

/**
 * Takes a snapshot of the current traffic, writes it to the database,
 * and purges data older than 7 days to keep disk space tightly managed.
 * * @param {number} activeSocketsCount - Current number of active WebSockets/connections
 */
function saveSnapshot(activeSocketsCount) {
    const insertStmt = db.prepare(`
        INSERT INTO usage_stats (active_sockets, api_requests, unique_ips) 
        VALUES (?, ?, ?)
    `);

    const cleanupStmt = db.prepare(`
        DELETE FROM usage_stats 
        WHERE timestamp < datetime('now', '-7 days')
    `);

    // Wrap both operations in a single transaction for maximum I/O efficiency
    const processSnapshot = db.transaction((sockets, requests, ips) => {
        insertStmt.run(sockets, requests, ips);
        cleanupStmt.run();
    });

    // Execute the transaction
    processSnapshot(activeSocketsCount, currentIntervalRequests, activeIps.size);

    // Reset accumulators for the next time window
    currentIntervalRequests = 0;
    activeIps.clear();
}

/**
 * Retrieves aggregated analytical data for the frontend dashboard.
 * Groups data by Date and Hour to show trends and peak times.
 * * @param {number} daysBack - Number of days to look back (default: 7)
 * @returns {Object} Processed dashboard summary metrics
 */
function getAnalytics(daysBack = 7) {
    const stmt = db.prepare(`
        SELECT 
            date(timestamp) as record_date,
            strftime('%H:00', timestamp) as record_hour,
            MAX(active_sockets) as peak_concurrent_users,
            SUM(api_requests) as total_api_requests,
            MAX(unique_ips) as peak_unique_ips
        FROM 
            usage_stats 
        WHERE timestamp >= datetime('now', ?)
        GROUP BY record_date, record_hour
        ORDER BY record_date DESC, record_hour DESC
    `);
    
    // Safely cast and bind the parameter to prevent injection and quoting issues
    const timeModifier = `-${Number(daysBack)} days`;
    const rawData = stmt.all(timeModifier);
    
    const summary = {
        totalDaysTracked: 0,
        highestPeakUsers: 0,
        totalRequestsWindow: 0, 
        busiestDay: null,
        busiestHour: null,
        hourlyBreakdown: []
    };

    if (!rawData || rawData.length === 0) {
        return summary;
    }

    const dayMap = new Map();

    rawData.forEach(row => {
        // Find highest peak concurrent users
        if (row.peak_concurrent_users > summary.highestPeakUsers) {
            summary.highestPeakUsers = row.peak_concurrent_users;
            summary.busiestHour = `${row.record_date} @ ${row.record_hour}`;
        }
        
        // Accumulate total requests for the dashboard KPI
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

    // Reverse the data so charting libraries plot left-to-right chronologically
    summary.hourlyBreakdown = rawData.reverse();

    return summary;
}

// Graceful Shutdown: Ensure WAL data is cleanly flushed to disk on exit
const closeDatabase = () => {
    if (db.open) db.close();
};

process.on('exit', closeDatabase);
process.on('SIGHUP', () => process.exit(128 + 1));
process.on('SIGINT', () => process.exit(128 + 2));
process.on('SIGTERM', () => process.exit(128 + 15));

module.exports = {
    recordApiHit,
    saveSnapshot,
    getAnalytics
};