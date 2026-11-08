/**
 * tests/st-f30-2026-11-08.test.js — CRM audit 2026-11-06, ST-F30.
 *
 * Ask Joe has run through the NBD server since 2026-08-10 (no key to save),
 * yet clearJoeKey() still behaved as if a key switched Joe on: it emptied the
 * chat in memory and redrew it (so the saved history was replaced on the next
 * save) and said "Key cleared — Joe AI is off until you save a new key". The
 * chat footer offered it as "Change Key", so one tap there wiped the chat.
 *
 * Now clearJoeKey() only removes the old key (session + local) and says Joe
 * stays on; the chat and its saved history are untouched. The footer drops
 * "Change Key" and carries data-joe-foot, which demo-mode.js uses to find it
 * (it used to find the footer by its clearJoeKey control).
 *
 * Lifts the REAL clearJoeKey out of ai.js; reads dashboard.html and
 * demo-mode.js. Zero deps. Run: node tests/st-f30-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const AI = read('docs/pro/js/ai.js');
const HTML = read('docs/pro/dashboard.html');
const DEMO = read('docs/pro/js/demo-mode.js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
const s = AI.indexOf('function clearJoeKey(');
const FN = s >= 0 ? AI.slice(s, AI.indexOf('\n}\n', s) + 3) : '';
const consts = (AI.match(/^const JOE_(KEY|CHAT)_STORE\s*=.*$/gm) || []).join('\n');

function store(seed) {
  const m = Object.assign({}, seed);
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m };
}

console.log('ASK JOE: CLEARING AN OLD KEY KEEPS THE CHAT (ST-F30)');
ok('control: clearJoeKey and the storage keys lifted from ai.js', /function clearJoeKey\(/.test(FN) && /JOE_KEY_STORE/.test(consts) && /JOE_CHAT_STORE/.test(consts), consts);
{
  const keyName = (consts.match(/JOE_KEY_STORE\s*=\s*'([^']+)'/) || [])[1];
  const chatName = (consts.match(/JOE_CHAT_STORE\s*=\s*'([^']+)'/) || [])[1];
  const history = JSON.stringify([{ role: 'user', content: 'text Maria' }, { role: 'assistant', content: 'Sent.' }]);
  const status = { textContent: '', style: {} };
  let inits = 0;
  const sb = {
    sessionStorage: store({ [keyName]: 'old-key', [chatName]: history }),
    localStorage: store({ [keyName]: 'old-key' }),
    document: { getElementById: (id) => (id === 'joeKeyStatus' ? status : null) },
    initJoeChat: () => { inits++; },
  };
  vm.createContext(sb);
  vm.runInContext(consts + '\nlet _joeMessages = [{ role: "user", content: "text Maria" }];\n' + FN + '\nclearJoeKey();\nthis.msgs = _joeMessages;', sb);
  ok('the old key is gone from session and local storage', sb.sessionStorage.getItem(keyName) === null && sb.localStorage.getItem(keyName) === null);
  ok('the saved chat history is kept', sb.sessionStorage.getItem(chatName) === history, sb.sessionStorage.getItem(chatName));
  ok('the chat on screen is not emptied or redrawn', inits === 0 && Array.isArray(sb.msgs) && sb.msgs.length === 1, inits + ' redraws, ' + JSON.stringify(sb.msgs));
  ok('the status no longer says Joe is off until a new key is saved', !/save a new key|is off/i.test(status.textContent), status.textContent);
  ok('…it says the old key is cleared and Joe stays on', /cleared/i.test(status.textContent) && /stays on/i.test(status.textContent), status.textContent);
}

console.log('\nASK JOE FOOTER');
{
  const tpl = (HTML.match(/<template id="tpl-view-joe">([\s\S]*?)<\/template>/) || [])[1] || '';
  const foot = (tpl.match(/<div[^>]*data-joe-foot[^>]*>([\s\S]*?)<\/div>/) || [])[1];
  ok('control: the Ask Joe view template is found', /joeSendBtn/.test(tpl));
  ok('the chat footer carries data-joe-foot', foot != null, tpl.slice(-400));
  ok('…and offers no "Change Key" (no clearJoeKey control in the Ask Joe view)', !/Change Key/.test(tpl) && !/data-fn="clearJoeKey"/.test(tpl));
  ok('Settings keeps its "Clear previously saved key" button', /data-fn="clearJoeKey">Clear previously saved key</.test(HTML));
  ok('demo-mode.js finds the footer by data-joe-foot (so the sample account still rewrites it)', /querySelectorAll\('\[data-joe-foot\]'\)/.test(DEMO));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
