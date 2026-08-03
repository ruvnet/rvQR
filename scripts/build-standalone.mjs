/*!
 * Build standalone.html — the whole app as one file that makes no network
 * requests, for the air-gapped side of a transfer.
 *
 * This existed only as a sequence of steps someone remembered to run, and it
 * went stale exactly the way every hand-maintained artifact in this repository
 * has: planner.js shipped, the page kept working, and standalone.html silently
 * described the app as it had been two increments earlier. The script list is
 * DERIVED from index.html for the same reason — a script added to the page is
 * inlined here automatically instead of being quietly missing.
 *
 *   node scripts/build-standalone.mjs
 *
 * Differences from the published page, and why each one exists:
 *   - every <script src> is inlined, so there is nothing left to fetch;
 *   - the demo artifacts are inlined as base64 and fetch() is shimmed to serve
 *     them, because "no network" has to include the demo button;
 *   - the CSP meta is dropped, because it forbids the inline scripts this file
 *     is made of. That is a real reduction in defence for a file you are meant
 *     to run from disk, and it is stated here rather than left for a reader to
 *     discover;
 *   - the description meta says "standalone", so a saved copy is identifiable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'artifacts');
const OUT = path.join(ROOT, 'standalone.html');

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const b64 = (p) => fs.readFileSync(path.join(SRC, p)).toString('base64');

let html = read('index.html');

// Derived from the page, never hand-listed.
const SCRIPTS = [...html.matchAll(/<script[^>]*src="\.\/([^"]+)"/g)].map((m) => m[1]);
if (!SCRIPTS.length) throw new Error('no scripts found in index.html — the regex or the page shape changed');

const DEMOS = {
  'rvf_wasm_bg.wasm': b64('demo/rvf_wasm_bg.wasm'),
  'ruvnet-demo.rvf': b64('demo/ruvnet-demo.rvf')
};

const shim = `
/* Demo artifacts inlined: this page makes no network requests. */
var RVQR_DEMOS = (function () {
  var raw = ${JSON.stringify(DEMOS)};
  var out = {};
  Object.keys(raw).forEach(function (k) {
    var bin = atob(raw[k]);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    out[k] = u8;
  });
  return out;
})();
(function () {
  var realFetch = typeof fetch === 'function' ? fetch.bind(null) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var hit = Object.keys(RVQR_DEMOS).filter(function (n) { return url.indexOf(n) !== -1; })[0];
    if (hit) {
      return Promise.resolve(new Response(RVQR_DEMOS[hit], {
        status: 200, headers: { 'content-type': 'application/octet-stream' }
      }));
    }
    if (realFetch) return realFetch(input, init);
    return Promise.reject(new Error('offline artifact: ' + url));
  };
})();
`;

// The CSP forbids the inline scripts this build is made of.
html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, '');

// Identify a saved copy as the standalone build rather than the hosted page.
html = html.replace(
  /<meta name="description" content="[^"]*">/i,
  '<meta name="description" content="rvQR standalone — one file, no network. ' +
  'Move RVF containers and WASM artifacts between devices with a screen and a camera.">'
);

for (const s of SCRIPTS) {
  const re = new RegExp('<script[^>]*src="\\./' + s.replace(/[/.]/g, (m) => '\\' + m) + '"[^>]*></script>');
  if (!re.test(html)) throw new Error('script tag not found: ' + s);
  const body = read(s);
  // Replacer FUNCTION, not a string: a string replacement interprets $&, $`
  // and $' inside the JS body and splices surrounding markup back in.
  const replacement = '<script>\n' + (s === 'core.js' ? shim + '\n' : '') + body + '\n</script>';
  html = html.replace(re, () => replacement);
}

for (const bad of ['src="./', 'Content-Security-Policy']) {
  if (html.includes(bad)) throw new Error('unresolved reference remains: ' + bad);
}

fs.writeFileSync(OUT, html);
console.log(JSON.stringify({
  bytes: html.length,
  kb: Math.round(html.length / 1024),
  scripts: (html.match(/<script>/g) || []).length,
  inlined: SCRIPTS,
  externalRefs: html.match(/src="(?!data:)[^"]+"/g) || [],
  demos: Object.keys(DEMOS)
}, null, 1));
