// =============================================================================
// Greenmarket — student client. Static, public, holds no secret and no answer.
// =============================================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc, collection, setDoc, updateDoc, onSnapshot, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { FIREBASE_CONFIG, INSTRUCTOR_PUBLIC_KEY } from './firebase-config.js?v=37';
import { CASES, ICONS } from './cases.js?v=37';
import { encryptPayload, cryptoAvailable, groupKeyB64, decryptWithGroupKey } from './crypto.js?v=37';

const app  = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app);

// Firestore refuses every read until the anonymous sign-in has landed. A phone
// on a slow link can show the join screen well before that, and a tap then came
// back as "No connection", which was untrue. Everything that reads waits here.
let markAuthed;
const authReady = new Promise(res => { markAuthed = res; });
const waitForAuth = ms => Promise.race([
  authReady,
  new Promise((_, rej) => setTimeout(() => rej(new Error('auth-timeout')), ms)),
]);

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------
const LS = 'gm_session_v1';
const LS_WORK = 'gm_work_v1';          // this group's own writing and numbers
const state = {
  uid:null, code:null, groupId:null, label:'', members:[],
  phase:'lobby', endsAt:null, open:0, submitted:false, score:null,
  reveal:null, feedback:null, board:null, podiumStep:0,
  slots: CASES.map(() => ({ green:'', add:'', des:'', prob:50, done:false })),
};
const doneCount = () => state.slots.filter(s => s.done).length;
const $ = id => document.getElementById(id);
const show = which => {
  ['intro','join','wait','home','market','sent','board','result'].forEach(id =>
    $(id).classList.toggle('hidden', id !== which));
  // the intro carries its own big logo, so the bar stays but empties itself
  document.querySelector('.topbar').classList.toggle('bare', which === 'intro');
};
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
    await waitForAuth(12000);
    const snap = await getDoc(doc(db, 'sessions', code));
    if (!snap.exists()) return 'none';
    return JOINABLE.includes(snap.data().phase) ? 'open' : 'closed';
  } catch (e) {
    console.warn('sessionState failed:', e.code || e.message);
    return 'offline';
  }
}

let waitTimer = null;
function waitForMarket(code, label, members) {
  show('wait');
  $('waitBack').classList.remove('hidden');
  $('waitTitle').textContent = 'The market is not open';
  $('waitText').textContent  = `Wait. Your instructor opens market ${code} soon. This page tries again by itself.`;
  $('waitWho').textContent   = '';
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = setInterval(async () => {
    if (await sessionState(code) === 'open') {
      clearInterval(waitTimer); waitTimer = null;
      $('waitBack').classList.add('hidden');
      $('waitTitle').textContent = 'You are in';
      doJoin(code, label, members);
    }
  }, 4000);
}

$('doJoin').onclick = async () => {
  const btn = $('doJoin'), was = btn.textContent;
  const busy = t => { btn.disabled = true; btn.textContent = t; };
  const free = () => { btn.disabled = false; btn.textContent = was; };
  const code  = $('code').value.replace(/\D/g,'');
  const label = $('gname').value.trim();
  const members = [...$('members').querySelectorAll('input')]
    .map(i => i.value.trim()).filter(Boolean);
  if (code.length !== 4) return fail('The market code is four digits.');
  if (!label || !members.length) return fail('Write the group name and one name.');
  if (!cryptoAvailable()) return fail('This page needs https. Nothing was sent.');

  busy('One moment…');
  const st = await sessionState(code);
  free();
  if (st === 'none')    return waitForMarket(code, label, members);
  if (st === 'closed')  return fail('This market is closed. You cannot join now.');
  if (st === 'offline') return fail('The connection is slow. Touch the button again.');
  busy('One moment…');
  await doJoin(code, label, members);
  free();
};

async function doJoin(code, label, members) {
  try {
    clearErr();
    // Joining is the start of a round. Anything left over from a previous one —
    // a submission, a score, last round's commentary — would otherwise decide
    // which screen this group sees, and strand it on "your answers are sent".
    Object.assign(state, {
      phase:'lobby', endsAt:null, submitted:false, score:null,
      reveal:null, feedback:null, board:null, podiumStep:0, open:0,
    });
    if (!loadedWorkFor(code)) state.slots = CASES.map(
      () => ({ green:'', add:'', des:'', prob:50, done:false }));
    state.code = code; state.label = label; state.members = members;
    state.groupId = state.uid;
    // This browser may already be in this market — a reload, a second tap, or a
    // group that came back to the join screen. Writing the document again would
    // be an update, which the rules refuse while the market is still in the
    // lobby, and the group would be told the market is shut. It is already in.
    let already = false;
    try { already = (await getDoc(groupRef())).exists(); } catch (e) { already = false; }
    const enc = await encryptPayload(
      { label, members, groupKey: await groupKeyB64() }, INSTRUCTOR_PUBLIC_KEY);
    if (already) {
      localStorage.setItem(LS, JSON.stringify({ code, label, members }));
      watchSession(); show('wait');
      $('waitBack').classList.add('hidden');
      $('waitTitle').textContent = 'You are in';
      $('waitText').textContent = 'Wait. Your instructor starts the game. Keep this page open.';
      $('waitWho').textContent = `${label} — ${members.length} people`;
      $('who').textContent = label;
      return;
    }
    await setDoc(groupRef(), {
      label, enc, ownerUid: state.uid,
      predictions: {}, done: 0, submitted: false, score: null,
      joinedAt: serverTimestamp(),
    });
    localStorage.setItem(LS, JSON.stringify({ code, label, members }));
    watchSession();
    show('wait');
    $('waitBack').classList.add('hidden');
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

let watchers = [];
function stopWatching() { watchers.forEach(u => { try { u(); } catch (e) {} }); watchers = []; }

function watchSession() {
  stopWatching();                           // a rejoin must not stack listeners
  watchers.push(onSnapshot(sessionRef(), snap => {
    const d = snap.data() || {};
    state.phase  = d.phase || 'lobby';
    state.endsAt = d.countdownEndsAt ? d.countdownEndsAt.toMillis() : null;
    state.podiumStep = d.podiumStep ?? 0;
    applyPhase();
  }, e => fail('Lost the connection: ' + e.message)));

  watchers.push(onSnapshot(groupRef(), async snap => {     // the worker may submit on our behalf
    if (!snap.exists() && state.label) {      // the instructor cleared the lobby
      localStorage.removeItem(LS); localStorage.removeItem(LS_WORK);
      stopWatching();                         // or the session listener drags us on
      Object.assign(state, {
        code:null, groupId:null, label:'', members:[], phase:'lobby', endsAt:null,
        submitted:false, score:null, reveal:null, feedback:null, board:null,
        podiumStep:0, open:0,
        slots: CASES.map(() => ({ green:'', add:'', des:'', prob:50, done:false })),
      });
      $('code').value = ''; $('gname').value = '';
      return show('join');
    }
    const d = snap.data() || {};
    // These are the numbers that were actually scored, including any market the
    // worker filled in at 50% when the clock ran out. They outrank the local copy.
    if (d.predictions) {
      CASES.forEach((c,i) => {
        const p = d.predictions[String(c.id)];
        if (typeof p === 'number') { state.slots[i].prob = p; state.slots[i].done = true; }
      });
    }
    if (d.submitted && !state.submitted) { state.submitted = true; applyPhase(); }
    if (d.score != null) { state.score = d.score; renderSent(); }
    if (d.feedbackEnc && !state.feedback) {
      try { state.feedback = await decryptWithGroupKey(d.feedbackEnc); renderReveal(); }
      catch (e) { /* a different browser, or the key was cleared */ }
    }
  }));

  watchers.push(onSnapshot(doc(db, 'sessions', state.code, 'public', 'leaderboard'), snap => {
    if (snap.exists()) { state.board = snap.data().rows || []; renderBoard(); }
  }));

  // The outcomes are published when the market closes, well before the
  // instructor reveals them. Holding them in the page would put the answer key
  // on every phone during the podium, so they are only fetched on the word go.
  watchers.push(onSnapshot(sessionRef(), s => {
    if ((s.data() || {}).phase !== 'reveal' || revealSub) return;
    revealSub = onSnapshot(doc(db, 'sessions', state.code, 'public', 'reveal'), snap => {
      if (snap.exists()) { state.reveal = snap.data().markets; renderReveal(); }
    });
    watchers.push(() => { revealSub && revealSub(); revealSub = null; });
  }));
}
let revealSub = null;

function applyPhase() {
  clearErr();
  if (state.phase === 'reveal') { renderReveal(); return show('result'); }
  if (state.phase === 'podium') { renderBoard(); return show('board'); }
  if (state.submitted || state.phase === 'submitted'
      || state.phase === 'reveal') { renderSent(); return show('sent'); }
  if (state.phase === 'lobby') { keepAwake(false); return show('wait'); }
  keepAwake(true);
  // Someone writing inside a market stays there when the clock starts; only the
  // clock is repainted. Otherwise every phone jumps to the grid mid-sentence.
  if (!$('market').classList.contains('hidden')) { renderClock(); return; }
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
  $('cRows').textContent = c.desc;
  $('aGreen').value = s.green; $('aAdd').value = s.add; $('aDest').value = s.des;
  $('lock').textContent = s.done ? 'Save the change' : 'Save';
  snapshot = { ...s };
  paintProb(); show('market'); renderClock();
  window.scrollTo({ top:0 });
}

// Typing is kept in state immediately and pushed to Firestore a second later, so a
// market that closes mid-sentence still has the words. The Save button stays, because
// it is what marks a market as answered.
let autoTimer = null, autoPending = false;
let snapshot = null;                          // the market as it was when opened
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
/** The writing is encrypted to the instructor and cannot be read back, so the
 *  browser keeps its own copy. Without it a reload showed empty answers and
 *  50% on every market in the reveal. */
function saveWork() {
  try { localStorage.setItem(LS_WORK, JSON.stringify({ code: state.code, slots: state.slots })); }
  catch (e) { /* a full or blocked store is not worth failing over */ }
}
function loadWork(code) {
  try {
    const w = JSON.parse(localStorage.getItem(LS_WORK) || 'null');
    if (w && w.code === code && Array.isArray(w.slots) && w.slots.length === CASES.length
        && w.slots.every(s => s && typeof s.green === 'string' && typeof s.add === 'string'
                           && typeof s.des === 'string')) {
      state.slots = w.slots;
      return true;
    }
  } catch (e) { /* ignore a damaged store */ }
  return false;
}
const loadedWorkFor = code => loadWork(code);

async function pushProgress() {
  saveWork();
  const predictions = {};
  state.slots.forEach((s,i) => {
    // Only a saved market carries a number. Writing one for a half-typed market
    // made the echo below mark it answered, inflating the count and unlocking
    // the send button for ten markets nobody had committed to.
    if (s.done) predictions[CASES[i].id] = s.prob;
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
  await pushProgress();
  try {
    await updateDoc(groupRef(), { submitted: true, auto, submittedAt: serverTimestamp() });
  } catch (e) {
    // Not sent. Stay on the markets so the group can try again, rather than sit
    // under a heading that says it worked.
    fail('Not sent: ' + e.message + ' Touch the button again.');
    renderHome();
    return;
  }
  state.submitted = true;
  clearInterval(clockTimer);
  renderSent(); show('sent');
}

function renderSent() {
  $('sentTbl').innerHTML = CASES.map((c,i) =>
    `<tr><td>${c.title}</td><td>${state.slots[i].prob}%</td></tr>`).join('');
  if (state.score == null) {
    $('sentText').innerHTML = 'Wait. Your instructor shows the results.';
  } else {
    const sign = state.score > 0 ? '+' : '';
    const tone = state.score > 0 ? 'up' : state.score < 0 ? 'down' : 'flat';
    $('sentText').innerHTML =
      `<span class="scoreline">Your points <b class="big ${tone}">${sign}${state.score}</b></span>`
      + `<span class="scorenote">Wait for the leaderboard.</span>`;
  }
}

// -----------------------------------------------------------------------------
// the reveal — only reachable once the instructor releases it
// -----------------------------------------------------------------------------
const esc = s => String(s).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const said = (lab, txt) => `<p class="said"><b>${lab}</b>` +
  (txt && txt.trim() ? `<span>“${esc(txt.trim())}”</span>`
                     : '<span class="small">You wrote nothing.</span>') + '</p>';

// The instructor walks the podium: third, then second, then first, then everyone.
const MEDAL = { 1:'🥇', 2:'🥈', 3:'🥉' };
function plinth(row, place) {
  if (!row) return '<div class="ghost-slot"></div>';
  const me = row.label === state.label;
  return `<div class="plinth p${place}${me?' me':''}">
    <div class="medal">${MEDAL[place]}</div>
    <div class="nm">${esc(row.label)}${me?'<br><span class="small">(you)</span>':''}</div>
    <div class="pt">${row.score>0?'+':''}${row.score}</div>
    <div class="block">${place}</div>
  </div>`;
}

function renderBoard() {
  if (!state.board) {
    $('boardTitle').textContent = 'The results are coming';
    $('boardSub').textContent   = 'Wait a moment.';
    $('podium').innerHTML = ''; $('boardList').innerHTML = '';
    return;
  }
  if (!state.board) return;
  const step = state.podiumStep || 0;
  const by = r => state.board.find(x => x.rank === r);
  const n = state.board.length;

  $('boardTitle').textContent = step === 0 ? 'The results are in'
    : step < 4 ? 'The podium' : 'The leaderboard';
  $('boardSub').textContent = step === 0
    ? 'Wait. Your instructor shows the places one by one.'
    : `${n} group${n===1?'':'s'} · ${CASES.length} markets · 990 points possible`;

  // second on the left, first in the middle, third on the right — revealed 3, 2, 1
  $('podium').innerHTML = step === 0 ? '' : [
      step >= 2 ? plinth(by(2), 2) : '<div class="ghost-slot"></div>',
      step >= 3 ? plinth(by(1), 1) : '<div class="ghost-slot"></div>',
      step >= 1 ? plinth(by(3), 3) : '<div class="ghost-slot"></div>',
    ].join('');

  $('boardList').innerHTML = step < 4 ? '' :
    '<div style="margin-top:18px">' + state.board.map(r => `
      <div class="rank ${r.rank<=3?'p'+r.rank:''} ${r.label===state.label?'me':''}">
        <div class="pos">${MEDAL[r.rank] || r.rank}</div>
        <div class="nm">${esc(r.label)}${r.label===state.label?' <span class="small">(you)</span>':''}</div>
        <div class="pts">${r.score>0?'+':''}${r.score}</div>
      </div>`).join('') + '</div>';
}

function renderReveal() {
  if (!state.reveal) {                     // the payload is a moment behind
    $('revTitle').textContent = 'The products are coming…';
    $('revList').innerHTML = ''; $('revOverall').innerHTML = '';
    return;
  }
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
          <div class="t"><i>${esc(c.title)}</i> was <b>${esc(m.real.split(' · ')[0])}</b></div>
          <div class="sub">${esc(m.real.split(' · ').slice(1).join(' · '))}</div>
        </div>
        <div class="revres ${m.alive?'yes':'no'}">
          <div class="big">${m.alive ? 'YES · ON SALE' : 'NO · NOT ON SALE'}</div>
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
  const rule = '='.repeat(66), thin = '-'.repeat(66);
  const wrap = (s, w = 66) => String(s).replace(
    new RegExp(`(?![^\\n]{1,${w}}$)([^\\n]{1,${w}})\\s`, 'g'), '$1\n');

  let txt = `GREENMARKET — ${state.label.toUpperCase()}\n${rule}\n`
          + `People: ${state.members.join(', ')}\n`
          + `Points: ${state.score ?? 0}\n\n`;
  if (fb?.overall) txt += wrap(fb.overall) + '\n\n';

  CASES.forEach((c,i) => {
    const m = state.reveal?.[String(c.id)], s = state.slots[i];
    if (!m) return;
    const f = fb?.markets?.[String(c.id)];
    txt += `${thin}\n${c.title} was ${m.real}\n${thin}\n`
         + `Outcome: ${m.alive ? 'still on sale' : 'not on sale'}`
         + `   You said: ${s.prob}%\n\n`
         + `YOU WROTE\n`
         + `  Sustainability benefit: ${s.green || '(nothing)'}\n`
         + `  Value added:            ${s.add   || '(nothing)'}\n`
         + `  Value destroyed:        ${s.des   || '(nothing)'}\n\n`
         + (f ? wrap(f.summary) + '\n'
              + (f.right?.length  ? `  Right:  ${f.right.join('; ')}\n`  : '')
              + (f.missed?.length ? `  Missed: ${f.missed.join('; ')}\n` : '') + '\n' : '')
         + `THE MARKET\n  ${m.green}\n`
         + m.add.map(x => `  + ${x}\n`).join('')
         + m.des.map(x => `  - ${x}\n`).join('')
         + '\n' + wrap(m.why) + '\n\n';
  });
  txt += `${rule}\n30296 Global Sustainability Strategy · Bocconi University\n`;

  // Safari ignores a click on an anchor that is not in the document, and a URL
  // revoked in the same tick. Both cost nothing to get right.
  const a = document.createElement('a');
  const href = URL.createObjectURL(new Blob([txt], { type:'text/plain;charset=utf-8' }));
  a.href = href;
  a.download = `greenmarket-${state.label.replace(/[^\w]+/g,'-').toLowerCase()}.txt`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(href); a.remove(); }, 4000);
}

// -----------------------------------------------------------------------------
// wiring
// -----------------------------------------------------------------------------
$('download').onclick = downloadMd;
$('download2').onclick = downloadMd;
$('toJoin').onclick = () => show('join');
$('backIntro').onclick = () => show('intro');

function flush() { clearTimeout(autoTimer); if (autoPending) { autoPending = false; pushProgress(); } }

/** Walk away from a market and leave it as it was when it was opened. */
function cancelMarket() {
  clearTimeout(autoTimer); autoPending = false;
  const s = state.slots[state.open];
  Object.assign(s, snapshot);                 // whatever it held on the way in
  pushProgress();                             // undo anything autosave already sent
  renderHome();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', flush);
$('back').onclick = () => { flush(); renderHome(); };
$('cancel').onclick = cancelMarket;
$('waitBack').onclick = () => {           // a mistyped market code is a dead end otherwise
  if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  $('waitBack').classList.add('hidden');
  show('join');
};

// While a text box has focus the bet bar leaves its sticky position, so the
// phone keyboard does not push it up over the writing.
for (const id of ['aGreen', 'aAdd', 'aDest']) {
  const box = $(id);
  box.addEventListener('focus', () => document.body.classList.add('typing'));
  box.addEventListener('blur',  () => document.body.classList.remove('typing'));
}
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
// The page ships with every screen hidden, so without this the student stares
// at an empty black page until the anonymous sign-in lands.
if (!localStorage.getItem(LS)) show('intro');

onAuthStateChanged(auth, async user => {
  if (!user) return;
  state.uid = user.uid; state.groupId = user.uid;
  markAuthed(user);
  const saved = JSON.parse(localStorage.getItem(LS) || 'null');
  if (!saved) return show('intro');

  // Only rejoin the saved market if it is still there and we are still in it.
  // Otherwise this is a new game: forget it and start from the rules.
  state.code = saved.code; state.label = saved.label; state.members = saved.members;
  loadWork(saved.code);
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
signInAnonymously(auth).catch(e => fail('Could not start: ' + (e.code || e.message)));
if (!cryptoAvailable()) fail('This page needs https. Open it from the web address, not from a file.');
