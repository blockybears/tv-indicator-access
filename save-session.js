// save-session.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_DIR = path.join(__dirname, 'tv-profile');
const STORAGE_FILE = path.join(__dirname, 'tv-storage.json');

(async () => {
  console.log('🚀 Launching browser to save authentication state...');

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1300, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.goto('https://www.tradingview.com/accounts/signin/', { waitUntil: 'domcontentloaded' });

  console.log('🟡 Please log in to TradingView in the browser window.');
  console.log('   The script will automatically continue once login is detected.');

  try {
    // Wait for successful login by detecting a URL change away from the sign-in page
    await page.waitForURL((url) => !url.pathname.includes('/accounts/signin/'), { timeout: 180000 });
    console.log('✅ Login detected.');

    // Save storage state to file
    const storageState = await browser.storageState();
    await fs.writeFile(STORAGE_FILE, JSON.stringify(storageState, null, 2));
    console.log(`✅ Authentication state saved to ${STORAGE_FILE}`);

  } catch (error) {
    console.error('🔴 Login was not detected within the time limit. Please try running the script again.');
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
})();
