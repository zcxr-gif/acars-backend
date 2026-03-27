/* =========================
 * Premium Telemetry Engine
 * ========================= */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure the data directory exists [cite: 2, 3]
const dbPath = path.join(__dirname, 'data');
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

// Initialize SQLite Database
const db = new Database(path.join(dbPath, 'telemetry.db'));

// Premium Database Optimizations for Space and Concurrency
db.pragma('journal_mode = WAL'); // Write-Ahead Logging for high-concurrency performance
db.pragma('synchronous = NORMAL'); // Balances safety with write speed in WAL mode
db.pragma('auto_vacuum = FULL'); // Automatically shrinks the DB file when old data is deleted

// Create the time-series table optimized for interval snapshots [cite: 4]
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

// In-Memory Accumulators (Reset after each snapshot) [cite: 5]
let currentIntervalRequests = 0;
const activeIps = new Set();

/**
 * Records an incoming HTTP request and tracks unique IP addresses. [cite: 6]
 * Call this via Express middleware. [cite: 7]
 */
function recordApiHit(ip) {
    currentIntervalRequests++;
    if (ip) {
        // Strip IPv6 mapping for cleaner IP tracking if necessary [cite: 7]
        const cleanIp = ip.replace(/^.*:/, '');
        activeIps.add(cleanIp); [cite: 8]
    }
}

/**
 * Takes a snapshot of the current traffic, writes it to the database,
 * and purges data older than 7 days to keep disk space tightly managed.
 */
function saveSnapshot(activeSocketsCount) {
    // Compile the statements
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

    // Reset accumulators for the next time window [cite: 10]
    currentIntervalRequests = 0;
    activeIps.clear(); [cite: 10, 11]
}

/**
 * Retrieves aggregated analytical data for the frontend dashboard. [cite: 11]
 * Groups data by Date and Hour to show trends and peak times. [cite: 12]
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
            usage_stats [cite: 13, 14]
        WHERE timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY record_date, record_hour
        ORDER BY record_date DESC, record_hour DESC
    `);
    
    const rawData = stmt.all(daysBack); [cite: 14, 15]
    
    // Process the data into an easily graphable format [cite: 15]
    const summary = {
        totalDaysTracked: 0,
        highestPeakUsers: 0,
        totalRequestsWindow: 0, 
        busiestDay: null,
        busiestHour: null,
        hourlyBreakdown: []
    };

    const dayMap = new Map(); [cite: 16]

    rawData.forEach(row => {
        // Find highest peak concurrent users [cite: 16]
        if (row.peak_concurrent_users > summary.highestPeakUsers) {
            summary.highestPeakUsers = row.peak_concurrent_users;
            summary.busiestHour = `${row.record_date} @ ${row.record_hour}`;
        }
        
        // Accumulate total requests for the dashboard KPI [cite: 16]
        summary.totalRequestsWindow += row.total_api_requests; [cite: 17]

        // Track daily totals for "Busiest Day" metric [cite: 17]
        const currentDayTotal = dayMap.get(row.record_date) || 0;
        dayMap.set(row.record_date, currentDayTotal + row.total_api_requests);
    });

    summary.totalDaysTracked = dayMap.size; [cite: 18]
    
    if (dayMap.size > 0) {
        // Find the day with the highest API request volume [cite: 18]
        const sortedDays = [...dayMap.entries()].sort((a, b) => b[1] - a[1]);
        
        summary.busiestDay = { [cite: 18, 19]
            date: sortedDays[0][0],
            requests: sortedDays[0][1]
        }; [cite: 19, 20]
    }

    // Reverse the data so Chart.js plots left-to-right chronologically (oldest -> newest) [cite: 20]
    summary.hourlyBreakdown = rawData.reverse();
    
    return summary; [cite: 20, 21]
}

module.exports = {
    recordApiHit,
    saveSnapshot,
    getAnalytics
};