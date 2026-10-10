#!/usr/bin/env bash
# Lagos Life - one-shot setup. Installs the system libs Chromium needs and the
# node modules. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> node $(node -v 2>/dev/null || echo MISSING)  npm $(npm -v 2>/dev/null || echo MISSING)"
node -v >/dev/null 2>&1 || { echo "Node 18+ is required."; exit 1; }

if command -v apt-get >/dev/null 2>&1; then
  echo "==> installing chromium system libraries"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    curl ca-certificates fonts-liberation \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libpango-1.0-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
    libasound2 xdg-utils
else
  echo "==> apt-get not found, skipping system libs (install them manually)"
fi

echo "==> installing node modules"
npm install --no-audit --no-fund

echo "==> verifying chromium can launch"
node -e "
const puppeteer=require('puppeteer-core');
const chromium=require('@sparticuz/chromium');
(async()=>{
  const exe = process.env.PUPPETEER_EXECUTABLE_PATH || await chromium.executablePath();
  const b = await puppeteer.launch({args:chromium.args,executablePath:exe,headless:chromium.headless,defaultViewport:chromium.defaultViewport});
  console.log('   chromium OK:', await b.version());
  await b.close();
})().catch(e=>{console.error('   chromium FAILED:', e.message);process.exit(1);});
"

echo
echo "Setup complete. Run it with:  npm start"
