import { syncBusinessCentral } from '../lib/bcSync';

async function runSync() {
  try {
    console.log(`[${new Date().toISOString()}] Running scheduled BC sync...`);
    await syncBusinessCentral();
    console.log(`[${new Date().toISOString()}] Scheduled sync completed successfully.`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Scheduled sync error:`, error);
  }
}

// 5 minutes in milliseconds
const INTERVAL_MS = 5 * 60 * 1000;

// Run immediately on startup
runSync();

setInterval(runSync, INTERVAL_MS);

console.log(`[CRON] Scheduled BC sync every 5 minutes.`);
