// =============================================================================
// Greenmarket — student client. Static, public, holds no secret and no answer.
// =============================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc, collection, setDoc, updateDoc, onSnapshot, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { FIREBASE_CONFIG, INSTRUCTOR_PUBLIC_KEY } from './firebase-config.js?v=14';
import { CASES, ICONS } from './cases.js?v=14';
import { encryptPayload, cryptoAvailable, groupKeyB64, decryptWithGroupKey } from './crypto.js?v=14';

const app  = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app);

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------
const LS = 'gm_session_v1';
const state = {
  uid:null, code:null, groupId:null, label:'', members:[],
  phase:'lobby', endsAt:null, open:0, submitted:false, score:null,
  reveal:null, feedback:null, board:null,
  slots: CASES.map(() => ({ green:'', add:'', des:'', prob:50, done:false })),
};
const doneCount = () => state.slots.filter(s => s.done).length;
const $ = id => document.getElementById(id);
const show = which => ['intro','join','wait','home','market','sent','board','result'].forEach(id =>
  $(id).classList.toggle('hidden', id !== which));
const fail = msg => { $('err').textContent = msg; $('err').classList.remove('hidden'); };
const clearErr = () => $('err').classList.add('hidden');

// -----------------------------------------------------------------------------
// join
// -----------------------------------------------------------------------------
function memberRow(v = '') {
  const i = document.createElement('input');
  i.type = 'text'; i.placeholder = 'Name and surname'; i.value = v;
  $('members').appendChild(i);
}
[0,1,2].forEach(() => memberRow());
$('addMember').onclick = () => memberRow();

const JOINABLE = ['lobby','playing','countdown'];

/** Is this market open? Returns 'open', 'closed', 'none' or 'offline'. */
async function sessionState(code) {
  try {
    const snap = await getDoc(doc(db, 'sessions', code));
    if (!snap.exists()) return 'none';
    return JOINABLE.includes(snap.data().phase) ? 'open' : 'closed';
  } catch (e) { return 'offline'; }
}

let waitTimer = null;
function waitForMarket(code, label, members) {
  show('wait');
  $('waitTitle').textContent = 'The market is not open';
  $('waitText').textContent  = `Wait. Your instructor opens market ${code} soon. This page tries again by itself.`;
  $('waitWho').textContent   = '';
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = setInterval(async () => {
    if (await sessionState(code) === 'open') {
      clearInterval(waitTimer); waitTimer = null;
      $('waitTitle').textContent = 'You are in';
      doJoin(code, label, members);
    }
  }, 4000);
}

$('doJoin').onclick = async () => {
  const code  = $('code').value.replace(/\D/g,'');
  const label = $('gname').value.trim();
  const members = [...$('members').querySelectorAll('input')]
    .map(i => i.value.trim()).filter(Boolean);
  if (code.length !== 4) return fail('The market code is four digits.');
  if (!label || !members.length) return fail('Write the group name and one name.');
  if (!cryptoAvailable()) return fail('This page needs https. Nothing was sent.');

  const st = await sessionState(code);
  if (st === 'none')    return waitForMarket(code, label, members);
  if (st === 'closed')  return fail('This market is closed. You cannot join now.');
  if (st === 'offline') return fail('No connection. Try again.');
  doJoin(code, label, members);
};

async function doJoin(code, label, members) {
  try {
    clearErr();
    state.code = code; state.label = label; state.members = members;
    state.groupId = state.uid;
    const enc = await encryptPayload(
      { label, members, groupKey: await groupKeyB64() }, INSTRUCTOR_PUBLIC_KEY);
    await setDoc(groupRef(), {
      label, enc, ownerUid: state.uid,
      predictions: {}, done: 0, submitted: false, score: null,
      joinedAt: serverTimestamp(),
    });
    localStorage.setItem(LS, JSON.stringify({ code, label, members }));
    watchSession();
    show('wait');
    $('waitTitle').textContent = 'You are in';
    $('waitText').textContent = 'Wait. Your instructor starts the game. Keep this page open.';
    $('waitWho').textContent = `${label} — ${members.length} people`;
    $('who').textContent = label;
  } catch (e) {
    fail(e.code === 'permission-denied'
      ? 'The market is not open for new groups. Ask your instructor.'
      : 'Could not join: ' + e.message);
  }
}

const sessionRef = () => doc(db, 'sessions', state.code);
const groupRef   = () => doc(collection(db, 'sessions', state.code, 'groups'), state.groupId);

// -----------------------------------------------------------------------------
// the session clock, driven by the instructor
// -----------------------------------------------------------------------------
// A phone that was asleep resyncs its listener only after a few seconds. When the
// tab comes back, read the session once directly so the screen catches up at once.
async function catchUp() {
  if (!state.code) return;
  try {
    const snap = await getDoc(sessionRef());
    const d = snap.data() || {};
    const phase = d.phase || 'lobby';
    const ends  = d.countdownEndsAt ? d.countdownEndsAt.toMillis() : null;
    if (phase !== state.phase || ends !== state.endsAt) {
      state.phase = phase; state.endsAt = ends; applyPhase();
    }
  } catch (e) { /* the listener will catch up on its own */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) catchUp(); });
window.addEventListener('focus', catchUp);
window.addEventListener('online', catchUp);

// Keep the screen on while a group is playing, so the connection is not suspended.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* not supported, or refused: nothing to do */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (state.phase === 'playing' || state.phase === 'countdown')) keepAwake(true);
});

function watchSession() {
  onSnapshot(sessionRef(), snap => {
    const d = snap.data() || {};
    state.phase  = d.phase || 'lobby';
    state.endsAt = d.countdownEndsAt ? d.countdownEndsAt.toMillis() : null;
    applyPhase();
  }, e => fail('Lost the connection: ' + e.message));

  onSnapshot(groupRef(), async snap => {     // the worker may submit on our behalf
    if (!snap.exists() && state.label) {      // the instructor cleared the lobby
      localStorage.removeItem(LS);
      state.submitted = false; state.score = null;
      state.slots = CASES.map(() => ({ green:'', add:'', des:'', prob:50, done:false }));
      return show('join');
    }
    const d = snap.data() || {};
    if (d.submitted && !state.submitted) { state.submitted = true; applyPhase(); }
    if (d.score != null) { state.score = d.score; renderSent(); }
    if (d.feedbackEnc && !state.feedback) {
      try { state.feedback = await decryptWithGroupKey(d.feedbackEnc); renderReveal(); }
      catch (e) { /* a different browser, or the key was cleared */ }
    }
  });

  onSnapshot(doc(db, 'sessions', state.code, 'public', 'leaderboard'), snap => {
    if (snap.exists()) { state.board = snap.data().rows || []; renderBoard(); }
  });

  onSnapshot(doc(db, 'sessions', state.code, 'public', 'reveal'), snap => {
    if (snap.exists()) { state.reveal = snap.data().markets; renderReveal(); }
  });
}

function applyPhase() {
  clearErr();
  if (state.phase === 'reveal' && state.reveal) { renderReveal(); return show('result'); }
  if (state.phase === 'podium' && state.board) { renderBoard(); return show('board'); }
  if (state.submitted || state.phase === 'submitted' || state.phase === 'podium'
      || state.phase === 'reveal') { renderSent(); return show('sent'); }
  if (state.phase === 'lobby') { keepAwake(false); return show('wait'); }
  keepAwake(true);
  renderHome();                               // playing or countdown
}

let clockTimer = null;
function renderClock() {
  const html = () => {
    if (!state.endsAt) return '';
    const left = Math.max(0, state.endsAt - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
    const calm = left > 60000 ? ' calm' : '';
    return `<div class="clock${calm}"><b>${m}:${String(s).padStart(2,'0')}</b>
      <span class="small">left. At zero everything is sent. A market with no answer becomes 50%.</span></div>`;
  };
  ['clockHome','clockMarket'].forEach(id => { const el = $(id); if (el) el.innerHTML = html(); });
  if (clockTimer) clearInterval(clockTimer);
  if (state.endsAt) {
    clockTimer = setInterval(() => {
      ['clockHome','clockMarket'].forEach(id => { const el = $(id); if (el) el.innerHTML = html(); });
      if (Date.now() >= state.endsAt) {       // belt and braces: the worker also sweeps
        clearInterval(clockTimer);
        if (!state.submitted) submitAll(true);
      }
    }, 1000);
  }
}

// -----------------------------------------------------------------------------
// the markets
// -----------------------------------------------------------------------------
function gauge(p, done) {
  const LEN = Math.PI * 26, col = p >= 50 ? 'var(--yes)' : 'var(--no)';
  return `<svg class="gauge" viewBox="0 0 64 42">
    <path d="M6 34 A26 26 0 0 1 58 34" fill="none" stroke="#2b3f54" stroke-width="6.5" stroke-linecap="round"/>
    ${done ? `<path d="M6 34 A26 26 0 0 1 58 34" fill="none" stroke="${col}" stroke-width="6.5"
       stroke-linecap="round" stroke-dasharray="${LEN}" stroke-dashoffset="${LEN*(1-p/100)}"/>` : ''}
    <text x="32" y="29" text-anchor="middle" font-size="14" font-weight="700"
      fill="${done?'#eef3f8':'#6b7a88'}" letter-spacing="-.5">${done ? p+'%' : '—'}</text>
    <text x="32" y="39" text-anchor="middle" font-size="7" fill="#858d92">chance</text>
  </svg>`;
}

function renderHome() {
  $('grid').innerHTML = CASES.map((c,i) => {
    const s = state.slots[i];
    return `<div class="mcard${s.done?' done':''}" data-i="${i}">
      <div class="mtop">
        <div class="mthumb">${ICONS[c.icon](c.pal[0], c.pal[1])}</div>
        <div class="mq">Is ${c.title} still on sale?</div>
        ${gauge(s.prob, s.done)}
      </div>
      <div class="mbtns">${s.done
        ? '<button class="bEdit">Change your answer</button>'
        : '<button class="bYes">Buy Yes</button><button class="bNo">Buy No</button>'}</div>
      <div class="mfoot"><span>${c.cat}</span>${s.done
        ? '<span class="chk">✓ Saved</span>'
        : '<span class="chk" style="color:var(--soft)">Not done</span>'}</div>
    </div>`;
  }).join('');
  document.querySelectorAll('.mcard').forEach(el =>
    el.addEventListener('click', () => openMarket(+el.dataset.i)));

  const n = doneCount();
  $('subTxt').innerHTML = `<b>${n} of ${CASES.length}</b> predictions done`;
  $('subBar').style.width = (n / CASES.length * 100) + '%';
  $('submitAll').disabled = n < CASES.length;
  $('counter').innerHTML = `<b>${n}</b> / ${CASES.length} done`;
  show('home'); renderClock();
}

function paintProb() {
  const v = state.slots[state.open].prob;
  $('probVal').textContent = v + '%';
  $('pYes').textContent = v + '%';
  $('pNo').textContent = (100 - v) + '%';
  $('prob').value = v;
  $('prob').style.background =
    `linear-gradient(to right, var(--yes) 0 ${v}%, var(--no) ${v}% 100%)`;
}

function openMarket(i) {
  state.open = i;
  const c = CASES[i], s = state.slots[i];
  $('cIcon').innerHTML = ICONS[c.icon](c.pal[0], c.pal[1]);
  $('cCat').textContent = c.cat;
  $('cTitle').textContent = c.title;
  $('cNum').textContent = `Market ${i+1} of ${CASES.length}`;
  $('cRows').innerHTML = c.rows.map(([k,v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('aGreen').value = s.green; $('aAdd').value = s.add; $('aDest').value = s.des;
  $('lock').textContent = s.done ? 'Save the change' : 'Save';
  paintProb(); show('market'); renderClock();
  window.scrollTo({ top:0 });
}

// Typing is kept in state immediately and pushed to Firestore a second later, so a
// market that closes mid-sentence still has the words. The Save button stays, because
// it is what marks a market as answered.
let autoTimer = null, autoPending = false;
function noteTyping() {
  const s = state.slots[state.open];
  s.green = $('aGreen').value; s.add = $('aAdd').value; s.des = $('aDest').value;
  if (state.submitted) return;
  autoPending = true;
  $('saveState').textContent = 'typing…';
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    if (!autoPending) return;
    autoPending = false;
    try { await pushProgress(); $('saveState').textContent = 'saved'; }
    catch (e) { $('saveState').textContent = 'not saved'; }
    setTimeout(() => { if (!autoPending) $('saveState').textContent = ''; }, 2500);
  }, 1000);
}

async function saveMarket() {
  const s = state.slots[state.open];
  s.green = $('aGreen').value; s.add = $('aAdd').value; s.des = $('aDest').value;
  s.done = true;
  renderHome();
  await pushProgress();
}

/** Probabilities travel in the clear — they are numbers, not personal data.
 *  The written answers travel inside the encrypted blob. */
async function pushProgress() {
  const predictions = {};
  state.slots.forEach((s,i) => {
    if (s.done || s.green.trim() || s.add.trim() || s.des.trim()) predictions[CASES[i].id] = s.prob;
  });
  try {
    const enc = await encryptPayload({
      label: state.label, members: state.members, groupKey: await groupKeyB64(),
      answers: state.slots.map((s,i) => ({ id:CASES[i].id, green:s.green, add:s.add, des:s.des })),
    }, INSTRUCTOR_PUBLIC_KEY);
    await updateDoc(groupRef(), { predictions, done: doneCount(), enc, updatedAt: serverTimestamp() });
  } catch (e) {
    fail(e.code === 'permission-denied'
      ? 'The market is closed. Your last answer was not saved.'
      : 'Could not save: ' + e.message);
  }
}

async function submitAll(auto = false) {
  if (state.submitted) return;
  state.slots.forEach(s => { if (!s.done) { s.prob = 50; s.done = true; } });  // missing = 50%
  state.submitted = true;
  await pushProgress();
  try {
    await updateDoc(groupRef(), { submitted: true, auto, submittedAt: serverTimestamp() });
  } catch (e) { fail('Could not send: ' + e.message); }
  renderSent(); show('sent');
}

function renderSent() {
  $('sentTbl').innerHTML = CASES.map((c,i) =>
    `<tr><td>${c.title}</td><td>${state.slots[i].prob}%</td></tr>`).join('');
  $('sentText').textContent = state.score == null
    ? 'Wait. Your instructor shows the results.'
    : `Your points: ${state.score > 0 ? '+' : ''}${state.score}. Wait for the leaderboard.`;
}

// -----------------------------------------------------------------------------
// the reveal — only reachable once the instructor releases it
// -----------------------------------------------------------------------------
const esc = s => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const said = (lab, txt) => `<p class="said"><b>${lab}</b>` +
  (txt && txt.trim() ? `<span>“${esc(txt.trim())}”</span>`
                     : '<span class="small">You wrote nothing.</span>') + '</p>';

function renderBoard() {
  if (!state.board) return;
  const n = state.board.length;
  $('boardSub').textContent = `${n} group${n===1?'':'s'} · ${CASES.length} markets · 990 points possible`;
  $('boardList').innerHTML = state.board.map(r => `
    <div class="rank ${r.rank<=3?'p'+r.rank:''} ${r.label===state.label?'me':''}">
      <div class="pos">${r.rank===1?'🥇':r.rank===2?'🥈':r.rank===3?'🥉':r.rank}</div>
      <div class="nm">${esc(r.label)}${r.label===state.label?' <span class="small">(you)</span>':''}</div>
      <div class="pts">${r.score>0?'+':''}${r.score}</div>
    </div>`).join('');
}

function renderReveal() {
  if (!state.reveal) return;
  const fb = state.feedback;
  $('revTitle').textContent = `${state.label}: ${state.score > 0 ? '+' : ''}${state.score ?? 0} points`;
  $('revOverall').innerHTML = fb?.overall
    ? `<p class="overall">${esc(fb.overall)}</p>` : '';
  $('revList').innerHTML = CASES.map((c,i) => {
    const m = state.reveal[String(c.id)], s = state.slots[i];
    if (!m) return '';
    const f = fb?.markets?.[String(c.id)];
    return `<div class="panel rev">
      <div class="revtop">
        ${m.photo ? `<img class="shot" src="${m.photo}" alt="">` : ''}
        <div class="revname">
          <div class="t">${esc(m.real.split(' · ')[0])}</div>
          <div class="sub">${esc(m.real.split(' · ').slice(1).join(' · '))}</div>
        </div>
        <div class="revres ${m.alive?'yes':'no'}">
          <div class="big">${m.alive ? 'Yes · on sale' : 'No · not on sale'}</div>
          <div class="small">You said ${s.prob}%</div>
        </div>
      </div>
      <div class="cmp">
        <div><h3>You wrote that</h3>
          ${said('Sustainability benefit', s.green)}
          ${said('Value added', s.add)}
          ${said('Value destroyed', s.des)}
          ${f ? `<p class="aibox"><i>${esc(f.summary)}</i>
             ${f.right?.length  ? `<span class="good">Right: ${esc(f.right.join('; '))}</span>`  : ''}
             ${f.missed?.length ? `<span class="bad">Missed: ${esc(f.missed.join('; '))}</span>` : ''}</p>` : ''}
        </div>
        <div><h3>The market thought that</h3>
          <p class="fact g">${esc(m.green)}</p>
          ${m.add.map(x => `<p class="fact a">${esc(x)}</p>`).join('')}
          ${m.des.map(x => `<p class="fact d">${esc(x)}</p>`).join('')}
          <p class="small" style="margin-top:9px">${esc(m.why)}</p>
        </div>
      </div>
    </div>`;
  }).join('');
}

function downloadMd() {
  const fb = state.feedback;
  let md = `# Greenmarket — ${state.label}\n\n`
         + `People: ${state.members.join(', ')}\n\n`
         + `Points: ${state.score ?? 0}\n\n`;
  if (fb?.overall) md += `${fb.overall}\n\n`;
  CASES.forEach((c,i) => {
    const m = state.reveal?.[String(c.id)], s = state.slots[i];
    if (!m) return;
    const f = fb?.markets?.[String(c.id)];
    md += `## ${m.real}\n\n`
        + `Result: **${m.alive ? 'still on sale' : 'not on sale'}** · you said **${s.prob}%**\n\n`
        + `**You wrote**\n\n- Sustainability benefit: ${s.green || '(nothing)'}\n`
        + `- Value added: ${s.add || '(nothing)'}\n- Value destroyed: ${s.des || '(nothing)'}\n\n`
        + (f ? `*${f.summary}*\n\n`
             + (f.right?.length  ? `Right: ${f.right.join('; ')}\n\n` : '')
             + (f.missed?.length ? `Missed: ${f.missed.join('; ')}\n\n` : '') : '')
        + `**The market**\n\n- ${m.green}\n`
        + m.add.map(x => `- ${x}\n`).join('') + m.des.map(x => `- ${x}\n`).join('')
        + `\n${m.why}\n\n`;
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type:'text/markdown' }));
  a.download = `greenmarket-${state.label.replace(/[^\w]+/g,'-').toLowerCase()}.md`;
  a.click(); URL.revokeObjectURL(a.href);
}

// -----------------------------------------------------------------------------
// wiring
// -----------------------------------------------------------------------------
$('download').onclick = downloadMd;
$('download2').onclick = downloadMd;
$('toJoin').onclick = () => show('join');
$('backIntro').onclick = () => show('intro');

function flush() { clearTimeout(autoTimer); if (autoPending) { autoPending = false; pushProgress(); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', flush);
$('back').onclick = () => { flush(); renderHome(); };
['aGreen','aAdd','aDest'].forEach(id => {
  $(id).addEventListener('input', noteTyping);
  $(id).addEventListener('blur', flush);
});
$('lock').onclick = saveMarket;
$('submitAll').onclick = () => submitAll(false);
$('prob').oninput = e => { state.slots[state.open].prob = +e.target.value; paintProb(); };

// -----------------------------------------------------------------------------
// boot
// -----------------------------------------------------------------------------
onAuthStateChanged(auth, async user => {
  if (!user) return;
  state.uid = user.uid; state.groupId = user.uid;
  const saved = JSON.parse(localStorage.getItem(LS) || 'null');
  if (!saved) return show('intro');

  // Only rejoin the saved market if it is still there and we are still in it.
  // Otherwise this is a new game: forget it and start from the rules.
  state.code = saved.code; state.label = saved.label; state.members = saved.members;
  let ours = false;
  try { ours = (await getDoc(groupRef())).exists(); } catch (e) { ours = false; }
  const st = await sessionState(saved.code);
  if (!ours || st === 'offline') {
    localStorage.removeItem(LS);
    state.code = null; state.label = ''; state.members = [];
    return show('intro');
  }
  $('who').textContent = saved.label;
  $('waitWho').textContent = `${saved.label} — ${saved.members.length} people`;
  watchSession(); show('wait');
});
signInAnonymously(auth).catch(e => fail('Could not sign in: ' + e.message));
if (!cryptoAvailable()) fail('This page needs https. Open it from the web address, not from a file.');
