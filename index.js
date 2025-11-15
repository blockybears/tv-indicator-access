import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const STORAGE_FILE = path.join(process.cwd(), 'tv-storage.json');

// --- CONFIGURATION ---
const PROFILE_DIR = path.join(process.cwd(), 'tv-profile');

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [key, val] = a.includes('=') ? a.split('=', 2) : [a, undefined];
    const k = key;
    switch (k) {
      case '--list-only':
      case '--all':
      case '--invite-only':
      case '--refresh-invite-list':
      case '--grant':
      case '--no-expiry':
      case '--headed':
      case '--show':
        out.flags.add(k);
        break;
      case '--users':
      case '--scripts': {
        if (val !== undefined) { out.values[k] = val; break; }
        // collect subsequent non-flag tokens as a space-separated list
        const vals = [];
        while (i + 1 < argv.length && !String(argv[i+1]).startsWith('--')) {
          vals.push(argv[++i]);
        }
        if (vals.length) {
          // Support comma- or space-separated; normalize to comma-separated string
          out.values[k] = vals.join(',');
        }
        break;
      }
      case '--expires':
      case '--days':
      case '--profile-url':
        if (val !== undefined) { out.values[k] = val; break; }
        if (i + 1 < argv.length) { out.values[k] = argv[++i]; }
        break;
      default:
        break;
    }
  }
  return out;
}
const ARGS_PARSED = parseArgs(process.argv);
const ARGS = ARGS_PARSED.flags;
const ARG_VALUES = ARGS_PARSED.values;
// ---------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseScriptRef(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/script\/([^/]+)\//);
    if (!m) return { id: '', slug: '' };
    const token = m[1];
    const dash = token.indexOf('-');
    return dash > 0 ? { id: token.slice(0, dash), slug: token.slice(dash + 1) } : { id: token, slug: '' };
  } catch {
    return { id: '', slug: '' };
  }
}

async function applyInviteOnlyFilters(page) {
  // Access type: Invite-only (keep privacy as-is; can be public or private)
  const accessFilter = page.locator('button[aria-label="Script access type filter"]');
  if (await accessFilter.count()) {
    await accessFilter.click();
    const opt1 = page.locator('[role="option"]:has-text("Invite-only")');
    if (await opt1.count()) await opt1.first().click();
    else await page.locator(':text("Invite-only")').first().click();
  }

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
}

async function listScriptsOnProfile(page, profileUrl) {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle');

    // Always filter to Invite-only + Private for our use case
    await applyInviteOnlyFilters(page);

    await page.waitForSelector('article:has(a[data-qa-id="ui-lib-card-link-title"])', { timeout: 30000 });

    let lastCount = -1;
    for (let i = 0; i < 20; i++) {
        const count = await page.locator('article:has(a[data-qa-id="ui-lib-card-link-title"])').count();
        if (count === lastCount) break;
        lastCount = count;
        await page.mouse.wheel(0, 2000);
        await page.waitForTimeout(800);
    }

    const articles = page.locator('article:has(a[data-qa-id="ui-lib-card-link-title"])');
    const count = await articles.count();
    const scripts = [];

    for (let i = 0; i < count; i++) {
        const card = articles.nth(i);
        const titleEl = card.locator('a[data-qa-id="ui-lib-card-link-title"]').first();
        const [title, href] = await Promise.all([
            titleEl.textContent(),
            titleEl.getAttribute('href'),
        ]);

        let url = href || '';
        if (url && url.startsWith('/')) url = new URL(url, 'https://www.tradingview.com').href;

        const ref = parseScriptRef(url);
        scripts.push({
            title: (title || '').trim(),
            url,
            id: ref.id,
            slug: ref.slug,
            index: i,
        });
    }

    return { scripts, articles };
}

async function grantAccessFromDialog(page, usernames) {
    const dialog = page.locator('[data-dialog-name="Manage invite-only access to this script"]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });

    const addTabById = dialog.locator('button#Add new users');
    if (await addTabById.count()) {
        await addTabById.click();
    } else {
        const addTab = dialog.locator('button:has-text("Add new users")');
        if (await addTab.count()) await addTab.click();
    }

    const searchInput = dialog.locator('input[placeholder*="Search for a user"]');

    // Revoke existing access for a user (if present), then return to Add new users tab
    async function revokeIfPresent(username) {
        // Switch to "Access granted" tab
        const accessTabById = dialog.locator('button#Access granted');
        if (await accessTabById.count()) {
            await accessTabById.click();
        } else {
            const accessTab = dialog.locator('button:has-text("Access granted")');
            if (await accessTab.count()) await accessTab.click();
        }
        await page.waitForTimeout(400);

        // Locate granted row by data-username or visible text
        let grantedRow = dialog.locator(`[data-username="${username}"]`).first();
        if (!(await grantedRow.count())) {
            const byText = dialog.getByText(username, { exact: true });
            if (await byText.count()) grantedRow = byText.first();
        }

        if (await grantedRow.count()) {
            // Preferred: explicit remove icon within the row
            const removeIcon = grantedRow.locator('[data-name="manage-access-dialog-item-remove-button"]').first();
            try {
                if (await removeIcon.count()) {
                    await removeIcon.hover({ timeout: 800 }).catch(() => {});
                    await removeIcon.click({ timeout: 1500 });
                } else {
                    // Fallbacks: generic revoke/remove controls
                    const revokeBtn = grantedRow.locator(':is(button, [role="button"]):has-text("Revoke")').first();
                    const removeBtn = grantedRow.locator(':is(button, [role="button"]):has-text("Remove")').first();
                    const revokeText = grantedRow.getByText('Revoke access');
                    if (await revokeBtn.count()) await revokeBtn.click({ timeout: 1500 });
                    else if (await removeBtn.count()) await removeBtn.click({ timeout: 1500 });
                    else if (await revokeText.count()) await revokeText.click({ timeout: 1500 });
                    else {
                        // Open row to reveal actions
                        await grantedRow.hover({ timeout: 800 }).catch(() => {});
                        await grantedRow.click({ timeout: 800 }).catch(() => {});
                        const anyRevoke = dialog.locator(':is(button, [role="button"]):has-text("Revoke"), :is(button, [role="button"]):has-text("Remove")').first();
                        if (await anyRevoke.count()) await anyRevoke.click({ timeout: 800 });
                    }
                }
            } catch {}

            // Confirm revoke if confirmation dialog appears
            const confirmDlg = page.locator('[data-dialog-name*="Revoke" i], [data-dialog-name*="Remove" i], [data-dialog-name*="Delete" i]');
            if (await confirmDlg.count()) {
                const confirmBtn = confirmDlg.locator(':is(button, [role="button"]):has-text("Revoke"), :is(button, [role="button"]):has-text("Remove"), :is(button, [role="button"]):has-text("Confirm")').first();
                if (await confirmBtn.count()) await confirmBtn.click();
                try { await confirmDlg.waitFor({ state: 'hidden', timeout: 5000 }); } catch {}
            }

            try { await grantedRow.waitFor({ state: 'detached', timeout: 5000 }); } catch {}
            console.log(`Revoked existing access for ${username}.`);
        }

        // Return to "Add new users" tab
        const addTabById2 = dialog.locator('button#Add new users');
        if (await addTabById2.count()) await addTabById2.click();
        else {
            const addTab = dialog.locator('button:has-text("Add new users")');
            if (await addTab.count()) await addTab.click();
        }
        await page.waitForTimeout(300);
    }

    for (const username of usernames) {
        console.log(`--- Processing user: ${username} ---`);
        await revokeIfPresent(username);
        await searchInput.fill(username);
        await page.waitForTimeout(1800);

        let userResult = page.locator(`[data-name="user-search-row"]:has-text("${username}")`).first();
        if (!(await userResult.count())) {
            const byUsernameAttr = page.locator(`[data-username="${username}"]`).first();
            if (await byUsernameAttr.count()) userResult = byUsernameAttr;
        }
        if (await userResult.count()) {
            // Try click row; if dialog not open, click "Add access" text within row
            await userResult.click();
            let expirationDialog = page.locator('[data-dialog-name="Set expiration date"]');
            if (!await expirationDialog.isVisible({ timeout: 800 }).catch(() => false)) {
                const addAccess = userResult.getByText('Add access', { exact: true });
                if (await addAccess.count()) await addAccess.click();
                expirationDialog = page.locator('[data-dialog-name="Set expiration date"]');
            }
            await expirationDialog.waitFor({ state: 'visible', timeout: 10000 });

            const noExpirationCheckbox = expirationDialog.locator('input[type="checkbox"]');
            const noExpiryLabel = expirationDialog.getByText('No expiration date');

            // Expiry handling
            const wantNoExpiry = ARGS.has('--no-expiry') || (!ARG_VALUES['--expires'] && !ARG_VALUES['--days']);

            // Helper to reliably toggle the checkbox by checking current state and clicking label if needed
            async function ensureNoExpiryChecked(checked) {
                if (await noExpirationCheckbox.count()) {
                    const isChecked = await noExpirationCheckbox.isChecked().catch(() => false);
                    if (checked && !isChecked) {
                        try { await noExpirationCheckbox.check(); } catch { try { await noExpiryLabel.click(); } catch {} }
                    } else if (!checked && isChecked) {
                        try { await noExpirationCheckbox.uncheck(); } catch { try { await noExpiryLabel.click(); } catch {} }
                    }
                } else {
                    // Fallback only label click
                    try { await noExpiryLabel.click(); } catch {}
                }
                await page.waitForTimeout(150);
            }

            if (wantNoExpiry) {
                await ensureNoExpiryChecked(true);
            } else {
                await ensureNoExpiryChecked(false);
                const desiredDate = (() => {
                    if (ARG_VALUES['--expires']) return ARG_VALUES['--expires'];
                    const daysStr = ARG_VALUES['--days'];
                    const days = daysStr ? parseInt(daysStr, 10) : NaN;
                    if (!isNaN(days)) {
                        const d = new Date();
                        d.setDate(d.getDate() + days);
                        const yyyy = d.getFullYear();
                        const mm = String(d.getMonth() + 1).padStart(2, '0');
                        const dd = String(d.getDate()).padStart(2, '0');
                        return `${yyyy}-${mm}-${dd}`;
                    }
                    return '';
                })();
                if (desiredDate) {
                    const dateInput = expirationDialog.locator('input[placeholder="YYYY-MM-DD"][data-qa-id="ui-lib-Input-input"]');
                    const dateContainer = expirationDialog.locator('[data-qa-id="ui-lib-Input"]').first();
                    // Wait for input to be enabled (not disabled)
                    for (let tries = 0; tries < 6; tries++) {
                        if (await dateInput.count()) {
                            const disabled = await dateInput.evaluate(el => !!el.disabled).catch(() => false);
                            if (!disabled) break;
                        }
                        // Toggle label once to ensure state propagates
                        try { await noExpiryLabel.click(); await noExpiryLabel.click(); } catch {}
                        await page.waitForTimeout(200);
                    }
                    // Focus and fill
                    try { await dateContainer.click({ timeout: 1000 }); } catch {}
                    try { await dateInput.click({ timeout: 1000 }); } catch {}
                    try { await dateInput.press('Control+A'); } catch {}
                    try { await dateInput.fill(desiredDate); } catch { await dateInput.type(desiredDate); }
                }
            }

            // Finalize by clicking Apply
            const applyBtn = expirationDialog.locator('[data-name="submit-button"], button:has-text("Apply")');
            await applyBtn.click();

            await expirationDialog.waitFor({ state: 'hidden', timeout: 10000 });
            console.log(`✔ Access granted to ${username}.`);
        } else {
            console.warn(`User "${username}" not found in search results. Skipping.`);
        }
        await page.waitForTimeout(600);
    }

    const closeBtn = dialog.locator('[data-qa-id="close"]');
    if (await closeBtn.count()) await closeBtn.click();
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
}

async function openManageAccessFromScriptPage(page) {
    // Try direct visible button first
    const direct = page.locator('button:has-text("Manage access")').first();
    if (await direct.count()) {
        try {
            await direct.waitFor({ state: 'visible', timeout: 1000 });
            await direct.click();
            return true;
        } catch {}
    }

    // Try the Share button if present
    const shareButton = page.locator('button[aria-label*="Share"]').first();
    if (await shareButton.count()) {
        try {
            await shareButton.waitFor({ state: 'visible', timeout: 2000 });
            await shareButton.click();
            const manageAccessButton = page.locator('button:has-text("Manage access")');
            await manageAccessButton.waitFor({ state: 'visible', timeout: 3000 });
            await manageAccessButton.click();
            return true;
        } catch {}
    }

    // Try generic menu buttons then look for the menu item
    const menuButtons = page.locator('button[aria-haspopup="menu"], button[aria-expanded][aria-controls], button[aria-label*="More" i]');
    const mbCount = await menuButtons.count();
    for (let i = 0; i < Math.min(mbCount, 6); i++) {
        const btn = menuButtons.nth(i);
        try {
            await btn.scrollIntoViewIfNeeded();
            await btn.click({ timeout: 1500 });
            const manage = page.locator('button:has-text("Manage access")');
            if (await manage.count()) {
                await manage.waitFor({ state: 'visible', timeout: 2000 });
                await manage.click();
                return true;
            }
        } catch {}
    }

    return false;
}

async function refreshInviteList(page, profileUrl) {
    const { scripts } = await listScriptsOnProfile(page, profileUrl);
    const simplified = scripts.map(s => ({ id: s.id, slug: s.slug, title: s.title, url: s.url }));

    // Single canonical file with enabled flags
    const selectionPath = path.join(process.cwd(), 'script-selection.json');
    let prev = { scripts: [] };
    try { prev = JSON.parse(await fs.readFile(selectionPath, 'utf-8')); } catch {}
    const prevMap = new Map(prev.scripts.map(s => [s.id || s.url, s]));
    const merged = simplified.map(s => {
        const key = s.id || s.url;
        const old = prevMap.get(key);
        return { ...s, enabled: old ? !!old.enabled : false };
    });
    const out = { updatedAt: new Date().toISOString(), scripts: merged };
    await fs.writeFile(selectionPath, JSON.stringify(out, null, 2));
    console.log('Updated script-selection.json');
    return merged;
}

async function resolveTargetsFromSelectionOrArgs() {
    // --scripts can be a comma-separated list of full URLs or script IDs
    const listArg = (ARG_VALUES['--scripts'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const selectionPath = path.join(process.cwd(), 'script-selection.json');
    const idToScript = new Map();
    // Build from selection file if present
    try {
        const sel = JSON.parse(await fs.readFile(selectionPath, 'utf-8'));
        for (const s of sel.scripts || []) {
            if (s.id) idToScript.set(s.id, s);
            if (s.url) idToScript.set(s.url, s);
        }
    } catch {}

    const scripts = [];
    if (listArg.length) {
        for (const token of listArg) {
            if (/^https?:\/\//i.test(token)) {
                const ref = parseScriptRef(token);
                scripts.push({ title: '', url: token, id: ref.id, slug: ref.slug });
            } else {
                const found = idToScript.get(token);
                if (found) scripts.push(found);
                else {
                    // Fallback: construct TradingView URL from id if possible
                    const url = `https://www.tradingview.com/script/${token}/`;
                    const ref = parseScriptRef(url);
                    scripts.push({ title: '', url, id: ref.id, slug: ref.slug });
                }
            }
        }
        return scripts;
    }

    try {
        const selection = JSON.parse(await fs.readFile(selectionPath, 'utf-8'));
        const enabled = (selection.scripts || []).filter(s => s.enabled);
        if (enabled.length) return enabled;
    } catch {}

    return [];
}

function isLoginPageUrl(urlString) {
  try {
    const u = new URL(urlString);
    return u.pathname.includes('/accounts/signin');
  } catch {
    return false;
  }
}

async function interactiveLoginAndSaveState() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1300, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const p = await ctx.newPage();
  await p.goto('https://www.tradingview.com/accounts/signin/', { waitUntil: 'domcontentloaded' });
  console.log('Login required. Please complete login in the visible window...');
  try {
    await p.waitForURL((u) => !u.pathname.includes('/accounts/signin/'), { timeout: 180000 });
    const state = await ctx.storageState();
    await fs.writeFile(STORAGE_FILE, JSON.stringify(state, null, 2));
    console.log(`Saved new auth state to ${STORAGE_FILE}`);
  } catch (e) {
    console.error('Login not detected within time limit. You can rerun later.');
  } finally {
    await ctx.close();
  }
}


async function main() {
    const listOnly = ARGS.has('--list-only');
    const manageAll = ARGS.has('--all');
    const doRefreshInvite = ARGS.has('--refresh-invite-list');
    const doGrant = ARGS.has('--grant') || (!listOnly && !doRefreshInvite);

    const profileUrl = ARG_VALUES['--profile-url'];
    const usersFromArgs = (ARG_VALUES['--users'] || '').split(',').map(s => s.trim()).filter(Boolean);

    if (doGrant && usersFromArgs.length === 0) {
        console.error('No users provided. Use the --users argument to specify one or more TradingView usernames.');
        process.exit(1);
    }

    // Determine which operations require the profile URL.
    const needsProfileUrl = doRefreshInvite || listOnly || (doGrant && !(await resolveTargetsFromSelectionOrArgs()).length);
    if (needsProfileUrl && !profileUrl) {
        console.error('Missing --profile-url argument. This is required for listing or refreshing scripts from a profile.');
        process.exit(1);
    }

    console.log('🚀 Starting TradingView access manager...');

    try {
        await fs.access(STORAGE_FILE);
    } catch {
        console.error(`🔴 Session file not found at ${STORAGE_FILE}`);
        console.error('Please run `npm run save-session` first to log in and create the session file.');
        process.exit(1);
    }

    const headed = ARGS.has('--headed') || ARGS.has('--show');
    let browser = await chromium.launch({ headless: !headed });
    let context = await browser.newContext({ storageState: STORAGE_FILE });
    let page = await context.newPage();

    // Determine the URL for the initial authentication check.
    // Use the profile URL if available, otherwise use a generic TradingView page.
    const authCheckUrl = profileUrl || 'https://www.tradingview.com/chart/';
    await page.goto(authCheckUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (isLoginPageUrl(page.url())) {
      await browser.close();
      await interactiveLoginAndSaveState();
      // Relaunch fresh context with updated storage
      browser = await chromium.launch({ headless: !headed });
      context = await browser.newContext({ storageState: STORAGE_FILE });
      page = await context.newPage();
      // Re-run the auth check after logging in
      await page.goto(authCheckUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    try {
        if (doRefreshInvite) {
            await refreshInviteList(page, profileUrl);
            console.log('✅ Refresh complete. "script-selection.json" has been updated.');
            return;
        }

        let targets = await resolveTargetsFromSelectionOrArgs();
        let fromArgsOrSelection = targets.length > 0;

        if (!fromArgsOrSelection) {
            const listed = await listScriptsOnProfile(page, profileUrl);
            targets = listed.scripts;
        }

        if (listOnly) {
            console.log('Discovered scripts:');
            console.log(JSON.stringify(targets, null, 2));
            console.log('✅ List-only mode: done.');
            return;
        }

        // The INDICATOR_TITLE filter is removed. Curation should be done via `script-selection.json` or `--scripts`.
        if (!fromArgsOrSelection && !manageAll) {
             console.warn('No scripts specified via --scripts and no scripts are enabled in script-selection.json. Nothing to do.');
             return;
        }

        for (const t of targets) {
            console.log(`Processing script: ${t.title || '(no title)'} -> ${t.url}`);

            if (t.url) {
                await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForLoadState('networkidle');
                const opened = await openManageAccessFromScriptPage(page);
                if (!opened) {
                    console.warn('Could not open Manage access from script page via known controls.');
                    continue;
                }
                await grantAccessFromDialog(page, usersFromArgs);
            } else {
                console.warn(`Skipping script without URL: ${t.title}`);
            }

            await page.waitForTimeout(800);
        }

        console.log('🎉 All targets processed.');

    } catch (error) {
        console.error('🔴 An error occurred:', error);
    } finally {
        await browser.close();
    }
}

main();
