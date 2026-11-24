// Read-only monitor. Polls /api/state every 2 s and re-renders only when the data changed (focus and open rows
// are kept); countdowns and the "last update" clock tick every second without re-rendering.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');
const shortAddr = (a) => (/^0x[0-9a-f]{40}$/i.test(a || '') ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || ''));
const clock = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour12: false });
const clockMs = (ms) => `${clock(ms)}.${String(ms % 1000).padStart(3, '0')}`;
const dateTime = (ms) => new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dur = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.floor(ms / 60000)} min ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')} s`);
const NAME = { ethereum: 'Ethereum', fabric: 'Fabric' };
const KEY = { ethereum: 'eth', fabric: 'fab' };
const OWN_LEDGER = { TP1: 'ethereum', TP2: 'fabric' };     // each app writes only this ledger
const isRunning = (s) => !['DONE', 'EXPIRED'].includes(s.state);

const ui = { verify: null, verifying: false, open: new Set(), touched: false, filters: { running: true, done: true, expired: false }, lastKey: '', state: null, fetchedAt: 0, offset: 0 };

// ------------------------------------------------------------------ wording
function stateOf(s) {
  if (s.state === 'DONE') return { cls: 'ok', text: 'Synchronisé' };
  if (s.state === 'EXPIRED') return { cls: 'off', text: 'Expirée' };
  const text = { NEW: 'Démarrage', LOCKED_OWN: 'Verrou posé', REVEALED: 'Secret publié', LOCKING: 'Verrouillage', LOCKED: 'Attente du secret', CLAIMED: 'Réclamé' }[s.state] || s.state;
  return { cls: 'run', text: `En cours · ${text}` };
}

function trigger(src) {
  if (!src) return 'Événement Locked';
  if (src.startsWith('DOSSIER')) return `Dossier ${src.replace('DOSSIER-', 'n° ')}`;
  return src.charAt(0).toUpperCase() + src.slice(1);
}

function stepText(e) {
  return esc(e.step)
    .replace(/\b(ethereum|fabric)\b/g, (m) => NAME[m])                     // older log entries
    .replace(/\s*\(T=(\d+)\)/, (_, t) => `, échéance ${clock(Number(t) * 1000)}`);
}

// a write = logged by an app on its own ledger with a transaction; anything else on a ledger is a read
function kindOf(e) {
  if (!e.ledger) return 'meta';
  return OWN_LEDGER[e.app] === e.ledger && e.detail && e.detail.txId ? 'write' : 'read';
}

// ------------------------------------------------------------------ summary strip
function ledgerCell(key, ledger, app, title, sub) {
  const info = ledger.info || {};
  const where = key === 'eth'
    ? `<dt>Contrat</dt><dd class="mono" title="${esc(info.address)}">HashSyncHTLC ${esc(shortAddr(info.address))}</dd>`
    : `<dt>Chaincode</dt><dd class="mono">${esc((info.contract || '').replace('chaincode ', ''))} (${esc(info.channel)})</dd>`;
  return `
    <div class="label"><span class="sq ${key}" aria-hidden="true"></span>${title} <span class="muted">· ${sub}</span></div>
    <div class="value">${ledger.ok ? ledger.records.length : '–'}<span class="unit">enregistrement${ledger.records.length === 1 ? '' : 's'}</span></div>
    <dl class="kv">
      ${where}
      <dt>Signataire</dt><dd class="mono" title="${esc(app.signer || '')}">${app.ok ? esc(shortAddr(app.signer) || '?') : '–'}</dd>
    </dl>
    ${!ledger.ok ? '<p class="warn">Registre injoignable : les synchronisations reprendront dès qu\'il répondra.</p>' : ''}
    ${ledger.ok && !app.ok ? `<p class="warn">${key === 'eth' ? 'TP1' : 'TP2'} hors ligne : aucune étape ne peut être écrite sur ce registre.</p>` : ''}`;
}

function statusCell(st) {
  const c = st.convergence;
  const running = st.syncs.filter(isRunning).length;
  let cls; let head; let text;
  if (!st.ethereum.ok || !st.fabric.ok) {
    cls = 'off'; head = 'Inconnu'; text = 'Un des registres ne répond pas.';
  } else if (!c.ethereumOnly.length && !c.fabricOnly.length) {
    cls = 'ok'; head = 'Identiques'; text = c.both ? `${c.both} enregistrement${c.both > 1 ? 's' : ''} sur les deux registres.` : 'Aucun enregistrement.';
  } else {
    cls = 'run'; head = `${c.ethereumOnly.length + c.fabricOnly.length} à synchroniser`;
    text = `${c.ethereumOnly.length} seulement sur Ethereum, ${c.fabricOnly.length} seulement sur Fabric.`;
  }
  return `
    <div class="label"><span class="sq ${cls}" aria-hidden="true"></span>Registres</div>
    <div class="value">${head}</div>
    <dl class="kv">
      <dt>Détail</dt><dd>${text}</dd>
      <dt>En cours</dt><dd>${running ? `${running} synchronisation${running > 1 ? 's' : ''}` : 'aucune'}</dd>
    </dl>
    <div class="verify">
      <button type="button" class="btn" data-action="verify" ${ui.verifying ? 'disabled' : ''}>${ui.verifying ? 'Vérification…' : 'Vérifier la synchronisation'}</button>
      ${verifyResult()}
    </div>`;
}

// Result of the on-demand check: every record asked to each ledger directly (hasRecord), see GET /api/verify
function verifyResult() {
  const v = ui.verify;
  if (!v) return '<p class="verify-result muted">Interroge chaque registre, enregistrement par enregistrement.</p>';
  if (v.error) return `<p class="verify-result bad">${esc(v.error)}</p>`;
  const when = `vérifié à ${clock(v.at)}, en ${dur(v.ms)}, bloc Ethereum ${v.ethereumBlock}`;
  if (v.inSync) {
    return `<p class="verify-result ok"><span class="sq ok" aria-hidden="true"></span> <strong>Synchronisés.</strong>
      Les ${v.total} enregistrements sont présents sur Ethereum et sur Fabric <span class="muted">(${when})</span>.</p>`;
  }
  return `<div class="verify-result bad"><span class="sq run" aria-hidden="true"></span> <strong>Pas encore synchronisés :</strong>
      ${v.missing.length} enregistrement${v.missing.length > 1 ? 's' : ''} sur ${v.total} manque${v.missing.length > 1 ? 'nt' : ''} d'un côté <span class="muted">(${when})</span>.
      <ul>${v.missing.map((m) => `<li class="mono">${esc(short(m.hash))} (${esc(m.origin)}) : absent de ${!m.onEthereum ? 'Ethereum' : 'Fabric'}</li>`).join('')}</ul></div>`;
}

async function runVerify() {
  ui.verifying = true;
  render();
  try {
    const res = await fetch('/api/verify', { cache: 'no-store' });
    ui.verify = await res.json();
  } catch (err) {
    ui.verify = { at: Date.now(), error: 'Moniteur injoignable.' };
  }
  ui.verifying = false;
  render();
}

// ------------------------------------------------------------------ timeline (one column per ledger)
function timeline(s) {
  const t0 = s.events.length ? s.events[0].at : s.createdAt;
  const rows = s.events.map((e) => {
    const k = kindOf(e);
    const time = `<td class="num mono">${clockMs(e.at)}</td><td class="num mono delta">+${dur(e.at - t0)}</td>`;
    if (k === 'meta') {
      const cls = /Erreur|expirée/i.test(e.step) ? 'bad' : /synchronisé/i.test(e.step) ? 'good' : '';
      const extra = e.detail && e.detail.error ? ` : ${esc(e.detail.error)}` : '';
      return `<tr class="meta ${cls}">${time}<td class="span" colspan="2"><span class="who">${esc(e.app)}</span> ${stepText(e)}${extra}</td></tr>`;
    }
    const d = e.detail || {};
    const ref = d.txId ? `bloc ${esc(d.block)} · tx ${esc(short(String(d.txId).replace(/^0x/, '')))}` : '';
    const sub = k === 'write' ? `${ref}${d.from ? ` · signé par ${esc(shortAddr(d.from))}` : ''}` : (ref ? `événement lu : ${ref}` : '');
    const cell = `<td class="lane-${KEY[e.ledger]}">
        <div class="op"><span class="sq ${KEY[e.ledger]} ${k === 'read' ? 'hollow' : ''}" aria-hidden="true"></span>
          <span><span class="sr-only">${k === 'write' ? 'Écriture' : 'Lecture'} : </span><span class="who">${esc(e.app)}</span> ${stepText(e)}</span></div>
        ${sub ? `<div class="sub">${sub}</div>` : ''}
      </td>`;
    return `<tr>${time}${e.ledger === 'ethereum' ? `${cell}<td></td>` : `<td></td>${cell}`}</tr>`;
  }).join('');
  return `<table class="timeline">
      <colgroup><col class="t"><col class="d"><col><col></colgroup>
      <thead><tr><th class="num">Heure</th><th class="num delta">Écart</th><th class="eth-h">Ethereum · écrit par TP1</th><th class="fab-h">Fabric · écrit par TP2</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="legend"><span><span class="sq eth" aria-hidden="true"></span>écriture (transaction signée)</span><span><span class="sq eth hollow" aria-hidden="true"></span>lecture par l'autre application</span></div>`;
}

// The time lock of both HTLCs: where each lock is, when it was set, its deadline, and how it ended.
// A lock ends in one of two ways: claimed with the secret before its deadline, or refunded after it.
function timeLocks(s) {
  const find = (ledger, re) => s.events.find((e) => e.ledger === ledger && re.test(e.step) && OWN_LEDGER[e.app] === ledger);
  const row = (label, ledger, deadline) => {
    const set = find(ledger, /^Verrou HTLC/);
    const claimed = find(ledger, /^(Secret publié|Verrou réclamé|Réclamé|Secret reçu|Verrou local réclamé)/);
    const refunded = find(ledger, /^Échéance dépassée/);
    let outcome;
    if (!deadline) outcome = '<span class="muted">pas encore posé</span>';
    else if (claimed) outcome = `<span class="lock ok">réclamé à ${clock(claimed.at)}, ${dur(deadline * 1000 - claimed.at).replace(/,\d s$/, ' s')} avant l'échéance</span>`;
    else if (refunded) outcome = `<span class="lock off">échéance dépassée, remboursé à ${clock(refunded.at)}</span>`;
    else if (isRunning(s)) outcome = `<span class="lock run">expire <strong data-deadline="${deadline}">…</strong></span>
        <meter min="0" max="1" data-meter="${deadline}" data-start="${Math.floor((set ? set.at : s.createdAt) / 1000)}" aria-hidden="true"></meter>`;
    else outcome = '<span class="muted">tentative terminée</span>';
    return `<tr><th scope="row">${label}</th><td><span class="sq ${KEY[ledger]}" aria-hidden="true"></span> ${NAME[ledger]}</td>
      <td class="num">${set ? clock(set.at) : '–'}</td><td class="num">${deadline ? clock(deadline * 1000) : '–'}</td><td>${outcome}</td></tr>`;
  };
  return `<table class="locks">
      <caption>Verrous temporels (time lock) : chaque verrou doit être réclamé avec le secret avant son échéance, sinon il est remboursé</caption>
      <thead><tr><th>Verrou</th><th>Registre</th><th class="num">Posé à</th><th class="num">Échéance</th><th>Issue</th></tr></thead>
      <tbody>${row('Origine (T<sub>A</sub>)', s.from, s.originDeadline)}${row('Destination (T<sub>B</sub>)', s.to, s.destDeadline)}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ sync table
function syncRows(s) {
  const st = stateOf(s);
  const open = ui.open.has(s.syncId);
  const done = s.events.find((e) => /synchronisé/i.test(e.step));
  const took = done ? dur(done.at - s.createdAt) : (isRunning(s) ? '…' : '–');
  const row = `<tr class="sync ${open ? 'open' : ''}" data-row="${esc(s.syncId)}">
      <td><button type="button" class="toggle" data-sync="${esc(s.syncId)}" aria-expanded="${open}" aria-label="${open ? 'Masquer' : 'Afficher'} les étapes de la synchronisation ${esc(short(s.recordHash))}">
        <span class="caret" aria-hidden="true">›</span><span class="state ${st.cls}"><span class="sq ${st.cls}" aria-hidden="true"></span>${st.text}</span></button></td>
      <td class="dir"><span class="${KEY[s.from]}-t">${NAME[s.from]}</span><span class="arrow" aria-label="vers">→</span><span class="${KEY[s.to]}-t">${NAME[s.to]}</span> <span class="muted">(${esc(s.originApp)})</span></td>
      <td class="mono" title="${esc(s.recordHash)}">${esc(short(s.recordHash))}</td>
      <td class="hide-sm">${esc(trigger(s.source))}</td>
      <td class="num hide-sm">${dateTime(s.createdAt)}</td>
      <td class="num">${took}</td>
    </tr>`;
  if (!open) return row;
  return `${row}<tr class="detail"><td colspan="6">
      <dl class="detail-grid">
        <dt>Enregistrement h</dt><dd><span class="mono">${esc(s.recordHash)}</span><button type="button" class="copy" data-copy="${esc(s.recordHash)}">Copier</button></dd>
        <dt>Hashlock q</dt><dd><span class="mono">${esc(s.hashlock)}</span><button type="button" class="copy" data-copy="${esc(s.hashlock)}">Copier</button></dd>
        <dt>Tentative</dt><dd><span class="mono">${esc(s.syncId)}</span></dd>
      </dl>
      ${timeLocks(s)}
      ${s.lastError && isRunning(s) ? `<p class="notice">Nouvel essai toutes les 2 s. Dernière erreur : ${esc(s.lastError)}</p>` : ''}
      ${timeline(s)}
    </td></tr>`;
}

function renderSyncs(st) {
  const g = { running: st.syncs.filter(isRunning), done: st.syncs.filter((s) => s.state === 'DONE'), expired: st.syncs.filter((s) => s.state === 'EXPIRED') };
  $('cRunning').textContent = g.running.length;
  $('cDone').textContent = g.done.length;
  $('cExpired').textContent = g.expired.length;
  if (!ui.touched) {                                   // until the user takes over: open what runs, else the latest
    ui.open = new Set(g.running.map((s) => s.syncId));
    if (!ui.open.size && g.done[0]) ui.open.add(g.done[0].syncId);
  }
  const shown = st.syncs.filter((s) => ui.filters[isRunning(s) ? 'running' : s.state === 'DONE' ? 'done' : 'expired']);
  if (!st.syncs.length) {
    $('syncs').innerHTML = '<p class="empty"><strong>Aucune synchronisation.</strong> Enregistrez un dossier dans TP1 ou TP2 ; elle apparaîtra ici en quelques secondes.</p>';
    return;
  }
  if (!shown.length) {
    $('syncs').innerHTML = `<p class="empty">Aucune synchronisation avec ces filtres${g.expired.length ? ` (${g.expired.length} expirée${g.expired.length > 1 ? 's' : ''} masquée${g.expired.length > 1 ? 's' : ''})` : ''}.</p>`;
    return;
  }
  $('syncs').innerHTML = `<table>
      <thead><tr><th>Statut</th><th>Sens (origine)</th><th>Enregistrement</th><th class="hide-sm">Déclencheur</th><th class="num hide-sm">Début</th><th class="num">Durée</th></tr></thead>
      <tbody>${shown.map(syncRows).join('')}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ records table
function renderRecords(st) {
  const map = new Map();
  for (const [ledger, data] of [['ethereum', st.ethereum], ['fabric', st.fabric]]) {
    for (const r of data.records) {
      const row = map.get(r.hash) || { hash: r.hash, origin: r.origin };
      row[ledger] = r.addedAt;
      map.set(r.hash, row);
    }
  }
  const first = (r) => Math.min(r.ethereum ?? Infinity, r.fabric ?? Infinity);
  const rows = [...map.values()].sort((a, b) => first(b) - first(a));
  if (!rows.length) {
    $('records').innerHTML = '<p class="empty"><strong>Les deux registres sont vides.</strong></p>';
    return;
  }
  const cell = (t, ok) => (t ? `<td class="yes num">${dateTime(t * 1000)}</td>` : `<td class="no num">${ok ? 'absent' : '–'}</td>`);
  $('records').innerHTML = `<table>
      <thead><tr><th>Empreinte</th><th>Créé par</th><th class="num">Ajouté sur Ethereum</th><th class="num">Ajouté sur Fabric</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mono" title="${esc(r.hash)}">${esc(short(r.hash))}</td>
        <td>${esc(r.origin)} <span class="muted">(${r.origin === 'TP1' ? 'Ethereum' : 'Fabric'})</span></td>
        ${cell(r.ethereum, st.ethereum.ok)}${cell(r.fabric, st.fabric.ok)}
      </tr>`).join('')}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ render + timers
function render() {
  const st = ui.state;
  const a = document.activeElement;
  const focus = a && (a.dataset.sync ? `[data-sync="${CSS.escape(a.dataset.sync)}"]` : a.dataset.filter ? `[data-filter="${CSS.escape(a.dataset.filter)}"]`
    : a.dataset.action ? `[data-action="${CSS.escape(a.dataset.action)}"]` : null);
  $('ethCell').innerHTML = ledgerCell('eth', st.ethereum, st.apps.TP1, 'Ethereum', 'Hardhat, écrit par TP1');
  $('fabCell').innerHTML = ledgerCell('fab', st.fabric, st.apps.TP2, 'Hyperledger Fabric', 'test-network, écrit par TP2');
  $('statusCell').innerHTML = statusCell(st);
  renderSyncs(st);
  renderRecords(st);
  if (focus) { const el = document.querySelector(focus); if (el) el.focus(); }
  tick();
}

function tick() {
  const now = Date.now() + ui.offset;
  const ago = Math.round((Date.now() - ui.fetchedAt) / 1000);
  $('live').classList.toggle('stale', !!ui.fetchedAt && ago > 6);
  $('liveText').textContent = !ui.fetchedAt ? 'Connexion…'
    : ago > 6 ? `Pas de réponse depuis ${ago} s` : `Mis à jour à ${clock(ui.fetchedAt)} · toutes les 2 s`;
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const left = Number(el.dataset.deadline) * 1000 - now;
    el.textContent = left > 0 ? `dans ${dur(left).replace(/,\d s$/, ' s')}` : 'maintenant (remboursement en cours)';
  });
  document.querySelectorAll('[data-meter]').forEach((el) => {
    const end = Number(el.dataset.meter) * 1000; const start = Number(el.dataset.start) * 1000;
    el.value = Math.max(0, Math.min(1, (end - now) / (end - start)));
  });
}

async function refresh() {
  try {
    const st = await (await fetch('/api/state', { cache: 'no-store' })).json();
    ui.fetchedAt = Date.now();
    ui.offset = st.at - Date.now();
    const { at, ...rest } = st;
    const key = JSON.stringify(rest);
    if (key !== ui.lastKey) { ui.lastKey = key; ui.state = st; render(); } else tick();
  } catch (err) {
    tick();
  }
}

// ------------------------------------------------------------------ interactions
function toggle(id) {
  ui.touched = true;
  if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id);
  render();
}

document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-action="verify"]')) { if (!ui.verifying) runVerify(); return; }
  const copy = ev.target.closest('[data-copy]');
  if (copy) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(copy.dataset.copy).then(() => {
        copy.textContent = 'Copié';
        setTimeout(() => { copy.textContent = 'Copier'; }, 1500);
      });
    }
    return;
  }
  const btn = ev.target.closest('[data-sync]');
  if (btn) { toggle(btn.dataset.sync); return; }
  if (ev.target.closest('tr.detail')) return;
  const row = ev.target.closest('tr[data-row]');           // the whole row is clickable; the button keeps it keyboard-accessible
  if (row && !window.getSelection().toString()) toggle(row.dataset.row);
});

document.addEventListener('change', (ev) => {
  const f = ev.target.dataset && ev.target.dataset.filter;
  if (!f) return;
  ui.filters[f] = ev.target.checked;
  render();
});

refresh();
setInterval(refresh, 2000);
setInterval(tick, 1000);
