// Opens the real join page in headless Chrome as several phones and taps on it.
//   node tests/browser-phones.cjs <page url with relay and #code> <count>
// Then follows commands on stdin: "tap <i>", "vote <i> <0|1>", "state <i>", "shot <i> <file>", "quit".
const {chromium} = require('playwright');
const readline = require('readline');

(async () => {
  const [url, count] = process.argv.slice(2);
  const options = {args: ['--no-sandbox']};
  if (process.env.CHROME_PATH)
    options.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(options);
  const pages = [];
  for (let i = 0; i < Number(count); i++) {
    const context = await browser.newContext({viewport: {width: 390, height: 780}, hasTouch: true, isMobile: true});
    const page = await context.newPage();
    page.on('pageerror', e => console.log(`error ${i} ${e}`));
    await page.goto(url);
    pages.push(page);
  }
  console.log('ready');
  for await (const line of readline.createInterface({input: process.stdin})) {
    const [cmd, i, arg] = line.trim().split(' ');
    const page = pages[Number(i)];
    if (cmd === 'quit') {
      break;
    } else if (cmd === 'tap') {
      await page.locator('#soma').dispatchEvent('pointerdown');
      console.log('ok');
    } else if (cmd === 'vote') {
      await page.locator(`#vote button[data-c="${arg}"]`).dispatchEvent('pointerdown');
      console.log('ok');
    } else if (cmd === 'state') {
      const state = await page.evaluate(() => ({...window.evoked.state, status: document.getElementById('status').textContent,
        hint: document.getElementById('hint').textContent, flash: document.getElementById('flash').className,
        labels: Array.from(document.querySelectorAll('#vote button'), b => b.textContent)}));
      console.log(JSON.stringify(state));
    } else if (cmd === 'shot') {
      await page.screenshot({path: arg});
      console.log('ok');
    }
  }
  // closing can hang on a page that still has a socket open: give it a moment, then leave
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 4000))]);
  process.exit(0);
})();
