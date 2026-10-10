/**
 * Lagos Life gift runner  (parallel)
 *
 * For each account, concurrently:
 *   1. register a fresh account with a unique username
 *   2. log in and hand the session cookies to Puppeteer
 *   3. play the full onboarding wizard, screen by screen, with real clicks
 *   4. wait for the starting wallet to land
 *   5. gift AMOUNT to TARGET_ID
 *
 * Runs CONCURRENCY accounts at once through one shared browser, each in its
 * own isolated browser context, so the throughput is limited by the onboarding
 * rather than by transfer throttling.
 */

const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const fs        = require('fs');
const path      = require('path');

// ---------- CONFIG ----------
const BASE        = process.env.BASE_URL  || 'https://lagoslife.app';
const TARGET_ID   = process.env.TARGET_ID || 'dc6c3aaafa38471499c9';
const AMOUNT      = Number(process.env.AMOUNT || 1000000);
const NOTE        = process.env.NOTE      || 'closed-loop test';
const COUNT       = Number(process.env.COUNT || 1);
// One account at a time by default: the browser drives a real 3D game world,
// and stacking those is what makes it flaky. Raise it only if you accept that.
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 3));
const HEADLESS    = process.env.HEADLESS !== 'false';
const RANDOMISE   = process.env.RANDOMISE_LOOK !== 'false';
const LOW_CPU     = process.env.LOW_CPU !== 'false';

// The 1m starting gift is a date-scoped campaign. If it stops being granted,
// every account fails identically, so bail out on the first one rather than
// working through the whole list.
const ABORT_ON_GIFT_DEAD = process.env.ABORT_ON_GIFT_DEAD !== 'false';
const SHOTS       = process.env.SHOTS === 'true';
const SHOT_DIR    = path.join(__dirname, 'shots');

const PASSWORD    = process.env.PASSWORD || 'Str0ngPass!22';
const NAME        = 'Test User';

// Pacing. These are the only sleeps left in the hot path; lower them for more
// speed, raise them if the site starts serving stale DOM.
const SETTLE_MS       = Number(process.env.SETTLE_MS || 400);  // after a click
const PICK_MS         = Number(process.env.PICK_MS   || 150);  // after a pick
const ADVANCE_WAIT_MS = Number(process.env.ADVANCE_WAIT_MS || 6000);  // for the button to enable
const BLOCK_ASSETS    = process.env.BLOCK_ASSETS !== 'false';
const WALLET_POLL_MS  = Number(process.env.WALLET_POLL_MS || 250);
const ACCOUNT_TIMEOUT = Number(process.env.ACCOUNT_TIMEOUT_MS || 60000);

// Transfers are throttled per account, not globally, so a parallel run needs
// no gap. Raise this only if the server starts answering 429.
const SEND_GAP_MS   = Number(process.env.SEND_GAP_MS || 0);
const SEND_RETRIES  = Number(process.env.SEND_RETRIES || 4);
const SEND_BACKOFF  = Number(process.env.SEND_BACKOFF_MS || 65000);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(...a);

// @sparticuz/chromium ships Lambda-tuned flags, and three of them make a
// multi-tab browser impossible: --single-process, --no-zygote and
// --in-process-gpu collapse everything into one process, so the second
// target created kills the browser. Drop them so one browser can host many
// isolated contexts.
// Only these three break multi-tab browsing. Everything else is left alone so
// the 3D game renders properly (swiftshader software GL stays enabled).
const DROP_ARG = /^(--single-process|--no-zygote|--in-process-gpu)$/;

// LOW_CPU=true additionally strips the software-GL flags and kills the canvas
// renderers. Only useful if you care about throughput more than the game
// actually drawing — it can stop the game world from rendering at all.
const LOW_CPU_ARG = /^(--use-gl=angle|--use-angle=swiftshader|--ignore-gpu-blocklist)$/;

function browserArgs() {
  const base = LOW_CPU
    ? chromium.args.filter(a => !DROP_ARG.test(a) && !LOW_CPU_ARG.test(a))
        .concat(['--disable-gpu', '--disable-software-rasterizer', '--disable-3d-apis'])
    : chromium.args.filter(a => !DROP_ARG.test(a));
  return base;
}

// Advance controls, most specific first. The wizard uses a different label
// on different screens (Continue / Next / Move in).
const ADVANCE = ['Continue', 'Move in', 'Next', 'Finish', 'Start', 'Enter Lagos', 'Begin'];

// ---------- HTTP (async, so accounts really run in parallel) ----------
// getSetCookie() is missing on this Node 18 build, so the joined header is
// split by hand.
function parseSetCookie(raw) {
  return raw
    .split(/,(?=[^;=]+=)/)
    .map(c => c.split(';')[0].trim())
    .filter(Boolean);
}

async function http(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      Referer: `${BASE}/`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) Chrome/120 Mobile',
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') || '' };
}

// ---------- PAGE FUNCTIONS (run inside the browser) ----------

// Reads the current screen and returns what it is asking for.
const READ_STEP = () => {
  const vis = e => e.offsetParent !== null;
  const heads = [...document.querySelectorAll('h1,h2,h3')]
    .filter(vis).map(e => e.innerText.trim()).filter(Boolean);

  const leaves = [...document.querySelectorAll('p,span,div')]
    .filter(e => vis(e) && e.childElementCount === 0)
    .map(e => (e.innerText || '').trim())
    .filter(t => /^(Choose|Pick|Select|Where will|What's|Every Lagosian|Rent is paid)/i.test(t));

  // Option cards are the rounded-2xl chips (single-word ones like "Woman"
  // included, which a text-shape test would miss). Only plain data is
  // returned: page.evaluate cannot serialise DOM nodes back out.
  const NOT_AN_OPTION = /^(Choose|Continue|Next|Back|Move in|Finish|Start|Got it|Randomise)/i;
  const cards = [...document.querySelectorAll('button')]
    .filter(vis)
    .filter(e => /rounded-2xl/.test(typeof e.className === 'string' ? e.className : ''))
    .map(e => ({
      text: (e.innerText || '').trim().replace(/\s+/g, ' '),
      selected: /bg-ink/.test(typeof e.className === 'string' ? e.className : ''),
    }))
    .filter(c => c.text && !NOT_AN_OPTION.test(c.text));

  const inGame = ['Home', 'Buy', 'Map', 'Phone'].every(l =>
    [...document.querySelectorAll('button')].some(b => vis(b) && (b.innerText || '').trim() === l));

  return { heads, leaves, cards, inGame };
};

// Fills the screen the way a player would: a random look, the requested
// number of traits, and a pick on every other choice screen.
const FILL_STEP = (opts) => {
  const vis = e => e.offsetParent !== null;
  const NOT_AN_OPTION = /^(Choose|Continue|Next|Back|Move in|Finish|Start|Got it|Randomise)/i;
  const isOpt = e => /rounded-2xl/.test(typeof e.className === 'string' ? e.className : '');
  const sel = e => /bg-ink/.test(typeof e.className === 'string' ? e.className : '');

  const cards = [...document.querySelectorAll('button')]
    .filter(vis).filter(isOpt)
    .filter(e => { const t = (e.innerText || '').trim(); return t && !NOT_AN_OPTION.test(t); });

  const chosen = [];
  const txt = document.body.innerText;

  const m = txt.match(/Choose\s+(\d+)/i);
  // A screen that says "Choose N" must have option cards. If it claims a
  // choice is needed but none are found, the page has not hydrated yet —
  // say so instead of clicking nothing and stalling on the next screen.
  if (m && cards.length === 0) {
    return { chosen, need: parseInt(m[1], 10), cards: 0, hydrated: false };
  }
  if (m) {
    // "Choose N" — top up to exactly N. The selected class only updates after
    // React re-renders, so count our own clicks instead of re-reading the DOM,
    // otherwise the loop keeps going and picks every option on the screen.
    const need = parseInt(m[1], 10);
    const already = cards.filter(sel).length;
    let remaining = Math.max(0, need - already);
    for (const c of cards) {
      if (remaining <= 0) break;
      if (sel(c)) continue;
      c.click();
      remaining--;
      chosen.push((c.innerText || '').trim().split('\n')[0]);
    }
  } else if (opts.randomise) {
    // Pick a random option on this screen so each sim looks different.
    const unsel = cards.filter(c => !sel(c));
    const pool = unsel.length ? unsel : cards;
    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      pick.click();
      chosen.push((pick.innerText || '').trim().split('\n')[0]);
    }
    // Random skin tone, when the screen offers one.
    const sw = [...document.querySelectorAll('button')]
      .filter(vis).filter(e => /rounded-full/.test(typeof e.className === 'string' ? e.className : ''))
      .filter(e => (e.getAttribute('aria-label') || '').startsWith('#'));
    if (sw.length) {
      sw[Math.floor(Math.random() * sw.length)].click();
      chosen.push('skin random');
    }
  } else if (cards.length && !cards.some(sel)) {
    // Nothing selected and randomisation is off: take the first option.
    cards[0].click();
    chosen.push((cards[0].innerText || '').trim().split('\n')[0]);
  }

  return { chosen, need: m ? parseInt(m[1], 10) : 0, cards: cards.length, hydrated: true };
};

// Clicks the first enabled advance control. Returns {clicked, disabled}.
// After a pick the button exists but stays disabled for a moment while React
// re-renders, so "disabled" is reported separately from "missing" — they need
// different handling.
const CLICK_ADVANCE = (labels) => {
  const vis = e => e.offsetParent !== null;
  const btns = [...document.querySelectorAll('button')].filter(vis);
  let sawDisabled = null;
  for (const label of labels) {
    const el = btns.find(b => (b.innerText || '').trim() === label);
    if (!el) continue;
    if (el.disabled) { sawDisabled = label; continue; }
    el.click();
    return { clicked: label };
  }
  return { clicked: null, disabled: sawDisabled, present: btns.map(b => (b.innerText || '').trim()).filter(Boolean) };
};

const DISMISS_COOKIE_BANNER = () => {
  const el = [...document.querySelectorAll('button')]
    .find(b => /^Accept$/i.test((b.innerText || '').trim()));
  if (el) { el.click(); return true; }
  return false;
};

const DISMISS_DIALOG = () => {
  const el = [...document.querySelectorAll('button')]
    .find(b => b.offsetParent && /^(Got it|OK|Close|Dismiss)$/i.test((b.innerText || '').trim()));
  if (el) { el.click(); return true; }
  return false;
};

const READ_BALANCE = () => {
  const t = document.body.innerText;
  const head = t.split('visits')[0];
  const m = head.match(/₦([\d,]+(?:\.\d+)?)(m|k)?/i);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  if (!m[2]) return n;
  return Math.round(n * (m[2].toLowerCase() === 'm' ? 1e6 : 1e3));
};

// ---------- ONE ACCOUNT ----------
// Usernames are decided up front so a job that times out mid-flight still
// reports which account it was.
function makeUsername(i) {
  return `tu_${Date.now().toString().slice(-7)}${i}${Math.floor(Math.random() * 900 + 100)}`;
}

async function runAccount(job, browser) {
  const { i, USERNAME } = job;
  const EMAIL  = `${USERNAME}@example.com`;
  const result = { i, USERNAME, ok: false };
  let context;

  const t0 = Date.now();
  try {
    // ---------- 1. REGISTER ----------
    const reg = await http('/api/auth/register', {
      method: 'POST',
      body: { name: NAME, username: USERNAME, password: PASSWORD, email: EMAIL, adult: true, born: '1995-03-22' },
    });
    if (reg.status !== 200) throw new Error(`register returned ${reg.status} ${reg.text.slice(0, 80)}`);
    result.register = reg.status;

    // ---------- 2. LOGIN ----------
    const login = await http('/api/auth/login', {
      method: 'POST',
      body: { username: USERNAME, password: PASSWORD },
    });
    if (login.status !== 200) throw new Error(`login returned ${login.status} ${login.text.slice(0, 80)}`);
    const jar = parseSetCookie(login.setCookie);
    const cookieHeader = jar.join('; ');
    if (!jar.length) throw new Error('login returned no session cookie');
    result.cookie = jar.length;

    // ---------- 3. BROWSER CONTEXT ----------
    // Its own context, so cookies never leak between concurrent accounts.
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.setCookie(...jar.map(c => {
      const [name, ...rest] = c.split('=');
      return { name: name.trim(), value: rest.join('='), domain: 'lagoslife.app', path: '/' };
    }));

    // The wizard is DOM-driven, so images, video and web fonts are dead
    // weight: skipping them cuts load time and memory a lot when several
    // accounts run at once.
    if (BLOCK_ASSETS) {
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
        else req.continue().catch(() => {});
      });
    }

    // networkidle2 rather than domcontentloaded: the wizard is React and does
    // nothing until it hydrates. The server-rendered HTML already contains the
    // screen text, so waiting on "the text is there" passes far too early and
    // every click lands on a dead element.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });

    // The cookie banner sits over the wizard and eats the first click.
    if (await page.evaluate(DISMISS_COOKIE_BANNER)) await sleep(100);

    // Confirm the browser really is signed in before touching the wizard. The
    // session check races the first paint, so give it a few tries.
    let who = null;
    for (let t = 0; t < 10 && !who; t++) {
      who = await page.evaluate(() =>
        (document.body.innerText.match(/@(tu_\d+)/) || [])[1] || null);
      if (!who) await sleep(150);
    }
    if (!who) throw new Error('browser session is not signed in');
    result.session = who;

    if (SHOTS) { fs.mkdirSync(SHOT_DIR, { recursive: true }); }

    // ---------- 4. ONBOARDING ----------
    // A client-side navigation can destroy the execution context mid-read,
    // so every read is retried rather than trusted once.
    const readStep = async () => {
      for (let t = 0; t < 4; t++) {
        try {
          const s = await page.evaluate(READ_STEP);
          if (s) return s;
        } catch (_) { /* context torn down, retry */ }
        await sleep(250);
      }
      return null;
    };

    const screens = [];
    for (let step = 0; step < 20; step++) {
      const s = await readStep();
      if (!s) break;
      if (s.inGame) break;

      const screenLabel = s.heads.join(' / ') || s.leaves.join(' / ') || '(look)';
      screens.push(screenLabel);

      // Fill and advance as one retryable unit. If the advance control stays
      // disabled, the picks did not register — the screen had not hydrated
      // when they were made — so pick again instead of giving up.
      let adv = { clicked: null };
      for (let attempt = 1; attempt <= 3; attempt++) {
        let fill = { chosen: [], hydrated: true };
        const fillDeadline = Date.now() + ADVANCE_WAIT_MS;
        while (Date.now() < fillDeadline) {
          fill = await page.evaluate(FILL_STEP, { randomise: RANDOMISE });
          if (fill.hydrated) break;
          await sleep(200);
        }
        if (!fill.hydrated) { await sleep(500); continue; }

        if (fill.chosen.length) {
          await sleep(PICK_MS);
          log(`  [${USERNAME}] screen ${step}: ${fill.chosen.join(', ')}`);
        }

        if (SHOTS) {
          await page.screenshot({ path: path.join(SHOT_DIR, `${USERNAME}-${step}.png`), fullPage: true });
        }

        const advDeadline = Date.now() + ADVANCE_WAIT_MS;
        while (Date.now() < advDeadline) {
          adv = await page.evaluate(CLICK_ADVANCE, ADVANCE);
          if (adv.clicked) break;
          await sleep(150);
        }
        if (adv.clicked) break;

        log(`  [${USERNAME}] screen ${step} attempt ${attempt}: ` +
            (adv.disabled ? `"${adv.disabled}" stayed disabled` : 'no advance control') + ', retrying');
        await sleep(500);
      }

      if (!adv.clicked) {
        log(`  [${USERNAME}] stuck on screen ${step} (${screenLabel}) after 3 attempts — stopping`);
        break;
      }
      // Wait for the screen to actually change instead of sleeping a fixed
      // amount, so a fast transition is not punished and a slow one is not
      // cut short.
      await page.waitForFunction((prev) => {
        const vis = e => e.offsetParent !== null;
        const head = [...document.querySelectorAll('h1,h2,h3')]
          .filter(vis).map(e => e.innerText.trim()).join(' / ');
        const leaf = [...document.querySelectorAll('p,span,div')]
          .filter(e => vis(e) && e.childElementCount === 0)
          .map(e => (e.innerText || '').trim())
          .filter(t => /^(Choose|Where will|What's|Every Lagosian|Rent is paid)/i.test(t))
          .join(' / ');
        return (head || leaf || '(look)') !== prev;
      }, { timeout: 6000 }, screenLabel).catch(() => {});
      await page.evaluate(DISMISS_DIALOG);
    }
    result.screens = screens.length;

    // ---------- 5. WAIT FOR THE STARTING WALLET ----------
    // A new sim is credited asynchronously, so sending straight away can fail
    // with "Couldn't take the money from your wallet". The balance is read
    // from the save API rather than the page, which is far quicker and does
    // not depend on the game canvas having rendered.
    const readSave = async () => {
      const save = await http('/api/save', { cookie: cookieHeader, timeout: 10000 }).catch(() => null);
      const g = save && save.json && save.json.game;
      return g || null;
    };
    const readMoney = async () => {
      const g = await readSave();
      return g && typeof g.money === 'number' ? g.money : null;
    };

    let bal = 0;
    for (let round = 0; round < 3; round++) {
      for (let t = 0; t < 12; t++) {
        const m = await readMoney();
        if (m !== null) bal = m;
        if (bal >= AMOUNT) break;
        await page.evaluate(DISMISS_DIALOG).catch(() => {});
        await sleep(WALLET_POLL_MS);
      }
      if (bal >= AMOUNT) break;
      // The starting gift is claimed when the game boots. If it never landed,
      // reloading gives the client another go at it.
      log(`  [${USERNAME}] wallet ₦${bal.toLocaleString()}, reloading to retry the claim`);
      await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
      await sleep(1500);
    }
    result.wallet = bal;

    if (SHOTS) {
      await page.screenshot({ path: path.join(SHOT_DIR, `${USERNAME}-final.png`), fullPage: true });
    }

    await context.close();
    context = null;

    // ---------- 6. GIFT ----------
    if (bal < AMOUNT) {
      // Diagnose: which credits actually landed? The starting gift shows up as
      // a gift.claim row, so a missing row tells us the claim never fired.
      const g = await readSave().catch(() => null);
      const ledger = (g && g.ledger) || [];
      result.ledger = ledger.map(l => `${l.k}=${l.a}`);
      result.gifts = g ? g.gifts : undefined;
      result.origin = g ? g.origin : undefined;
      log(`  [${USERNAME}] wallet ₦${bal.toLocaleString()} too low, gift skipped`);
      log(`      ledger: ${JSON.stringify(result.ledger)}`);
      log(`      origin: ${JSON.stringify(result.origin)}  gifts: ${JSON.stringify(result.gifts)}`);
      result.gift = `skipped (wallet ₦${bal.toLocaleString()})`;
      return result;
    }

    {
      const g = await readSave().catch(() => null);
      result.ledger = ((g && g.ledger) || []).map(l => `${l.k}=${l.a}`);
    }

    for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
      const send = await http('/api/send', {
        method: 'POST',
        cookie: cookieHeader,
        body: { to: TARGET_ID, amount: AMOUNT, note: NOTE },
      });
      result.gift = `http ${send.status} ${send.text.slice(0, 100)}`;

      if (send.status === 200 && send.json && send.json.ok) {
        result.ok = true;
        result.txId = send.json.id;
        result.fee = send.json.fee;
        break;
      }
      if (send.status === 429 && attempt < SEND_RETRIES) {
        await sleep(SEND_BACKOFF);
        continue;
      }
      break;
    }

    return result;
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    return result;
  } finally {
    if (context) { try { await context.close(); } catch (_) {} }
    result.ms = Date.now() - t0;
    const tag = result.ok ? 'GIFTED' : 'FAILED';
    log(`  ${tag}  ${USERNAME}  ${Math.round(result.ms / 1000)}s  ` +
        (result.txId ? `tx ${result.txId}` : result.error || result.gift || ''));
  }
}

// ---------- MAIN ----------
(async () => {
  const started = Date.now();
  log('Lagos Life gift runner');
  log(`  base        : ${BASE}`);
  log(`  recipient   : ${TARGET_ID}`);
  log(`  amount      : ₦${AMOUNT.toLocaleString()}`);
  log(`  accounts    : ${COUNT}`);
  log(`  concurrency : ${CONCURRENCY}`);
  log(`  randomise   : ${RANDOMISE}\n`);

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || await chromium.executablePath();

  const browser = await puppeteer.launch({
    args: browserArgs(),
    executablePath,
    headless: HEADLESS,
    defaultViewport: chromium.defaultViewport,
    // A busy box can stall a single CDP call for a while; give it room so a
    // slow render never turns into a dead browser handle.
    protocolTimeout: ACCOUNT_TIMEOUT + 30000,
  });

  // Work queue drained by CONCURRENCY workers.
  const jobs = Array.from({ length: COUNT }, (_, i) => ({ i, USERNAME: makeUsername(i) }));
  const queue = [...jobs];
  const results = new Array(COUNT);

  let giftDead = false;

  const worker = async () => {
    for (;;) {
      if (giftDead) return;
      const job = queue.shift();
      if (!job) return;
      const timeout = new Promise(res => setTimeout(
        () => res({ ...job, ok: false, wallet: 0, error: `timeout after ${ACCOUNT_TIMEOUT}ms` }),
        ACCOUNT_TIMEOUT));
      results[job.i] = await Promise.race([runAccount(job, browser), timeout]);

      // If the starting gift is not being granted at all, every remaining
      // account is going to fail the same way. Stop instead of grinding
      // through the rest of the list burning accounts.
      if (ABORT_ON_GIFT_DEAD && job.i === 0 && !results[job.i].ok &&
          results[job.i].wallet !== undefined && results[job.i].wallet < AMOUNT) {
        giftDead = true;
        log('\n!! the starting gift was not granted on the first account.');
        log('!! stopping the run — check whether the campaign is still live.');
        continue;
      }

      if (SEND_GAP_MS) await sleep(SEND_GAP_MS);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, COUNT) }, worker));
  await browser.close();

  // ---------- SUMMARY ----------
  const done = results.filter(Boolean);
  const ok = done.filter(r => r.ok);
  const total = ok.length * AMOUNT;
  const secs = (Date.now() - started) / 1000;

  log(`\n${'='.repeat(58)}`);
  log('SUMMARY');
  log('='.repeat(58));
  for (const r of done) {
    log(`  ${r.ok ? 'GIFTED' : 'FAILED'}  ${r.USERNAME}  wallet ₦${(r.wallet || 0).toLocaleString()}` +
        (r.txId ? `  tx ${r.txId}  fee ₦${r.fee}` : '') +
        (r.error ? `  (${r.error})` : ''));
  }
  log(`  ${ok.length}/${done.length} succeeded · ₦${total.toLocaleString()} gifted`);
  log(`  ${secs.toFixed(0)}s total · ${(ok.length / (secs / 60)).toFixed(1)} gifts/min`);

  fs.writeFileSync(
    path.join(__dirname, 'run-results.json'),
    JSON.stringify({
      at: new Date().toISOString(), base: BASE, target: TARGET_ID, amount: AMOUNT,
      count: COUNT, concurrency: CONCURRENCY, seconds: Math.round(secs),
      succeeded: ok.length, giftsPerMinute: Number((ok.length / (secs / 60)).toFixed(2)),
      results: done,
    }, null, 2)
  );

  if (ok.length !== done.length) process.exit(1);
})().catch(e => {
  console.error('[fatal]', e && e.message ? e.message : e);
  process.exit(1);
});