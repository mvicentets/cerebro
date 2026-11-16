/* Segundo Cérebro: sincronização com Supabase
   - login com e-mail e senha
   - cada registro vira uma linha na tabela "items"; fotos e áudios vão para o bucket privado "media"
   - funciona offline: tudo continua salvo no aparelho e sincroniza quando a internet volta
*/
const SB_URL = 'https://xgzwjuspgzpvvmbdhxqp.supabase.co';
const SB_KEY = 'sb_publishable_R_L0hA3jV0iRKi-Cchr-DQ_35727GY7';  // chave pública (segura no navegador; a proteção vem das regras RLS)

const SYNC_KINDS = ['tasks','workouts','journal','notes','books','uber','reminders','body','results','content'];
const SKEY = 'sc2-sync-v1', SESS = 'sc2-session-v1';
const syncConfigured = () => !SB_URL.includes('XXXX') && !SB_KEY.includes('SUA_');
const loadJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch(e) { return null; } };
const freshState = () => ({hashes:{}, media:{}, lastPull:null, lastSync:null});

let session = loadJSON(SESS);
let sstate = loadJSON(SKEY) || freshState();
let syncStatus = session ? 'ok' : 'off', syncErr = '';
let loginEmail = '', refreshing = null;

const saveSession = () => { if (session) localStorage.setItem(SESS, JSON.stringify(session)); else localStorage.removeItem(SESS); };
const saveState = () => localStorage.setItem(SKEY, JSON.stringify(sstate));
const strHash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h.toString(36) + '.' + s.length; };
const recHash = d => strHash(JSON.stringify(d));

/* ---------------- autenticação ---------------- */
async function sbErr(r){ try { const j = await r.json(); return j.msg || j.error_description || j.message || j.error || ('erro ' + r.status); } catch(e) { return 'erro ' + r.status; } }
const jsonHeaders = () => ({apikey: SB_KEY, 'Content-Type': 'application/json'});
function setSession(j){
  session = {access_token:j.access_token, refresh_token:j.refresh_token, expires_at:Date.now() + (j.expires_in || 3600) * 1000,
             user:{id:j.user.id, email:j.user.email}};
  saveSession();
}
/* Renovação do login.
   O Supabase troca o "refresh token" a cada renovação e cada um só pode ser usado uma vez.
   Com o app aberto em mais de uma aba/janela, todas dividem o mesmo login salvo: por isso
   (1) sempre relemos o login salvo antes de renovar, (2) só uma aba renova por vez (Web Locks) e
   (3) uma recusa só desloga se ninguém mais renovou e o servidor disser que o token é inválido. */
const storedSession = () => loadJSON(SESS);
function adoptStored(){
  const s = storedSession();
  if (s && session && s.user && session.user && s.user.id === session.user.id && s.refresh_token !== session.refresh_token && s.expires_at >= session.expires_at) { session = s; return true; }
  return false;
}
const withRefreshLock = fn => (navigator.locks && navigator.locks.request) ? navigator.locks.request('sc2-auth-refresh', fn) : fn();
async function refreshSession(force){
  if (!session) return;
  const tokenBefore = session.access_token;
  if (adoptStored() && Date.now() < session.expires_at - 60000) return;   // outra aba já renovou: usa o login dela
  if (!force && Date.now() < session.expires_at - 60000) return;
  if (refreshing) return refreshing;
  refreshing = withRefreshLock(async () => {
    if (!session) return;
    adoptStored();                                                    // outra aba pode ter renovado enquanto esperávamos
    if (session.access_token !== tokenBefore && Date.now() < session.expires_at - 60000) return;
    if (!force && Date.now() < session.expires_at - 60000) return;
    const used = session.refresh_token;
    let r;
    try { r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {method:'POST', headers:jsonHeaders(), body:JSON.stringify({refresh_token:used})}); }
    catch(e) { return; }                                              // sem internet: tenta depois, continua logado
    if (r.ok) { setSession(await r.json()); return; }
    if (adoptStored()) return;                                        // outra aba renovou primeiro: usa o login dela
    if (r.status >= 500 || r.status === 429) return;                  // problema temporário do servidor: não desloga
    const msg = (await sbErr(r)).toLowerCase();
    if (r.status === 400 || r.status === 401 || /refresh token|invalid|not found|revoked|already used/.test(msg)) {
      const email = session.user && session.user.email;
      session = null; saveSession(); setSyncStatus('off');
      if (email) loginEmail = email;
      toast('Sua sessão expirou. Entre de novo em ⚙️ Ajustes (seus dados continuam aqui).');
      render();
    }
  }).finally(() => { refreshing = null; });
  return refreshing;
}
async function sbFetch(path, opts = {}, retry = true){
  await refreshSession(false);
  if (!session) throw new Error('sem sessão');
  const r = await fetch(SB_URL + path, {...opts, headers:{apikey:SB_KEY, Authorization:'Bearer ' + session.access_token, ...(opts.headers || {})}});
  if (r.status === 401 && retry) { if (!adoptStored()) await refreshSession(true); return sbFetch(path, opts, false); }
  return r;
}
// outra aba renovou, entrou ou saiu: acompanha
addEventListener('storage', e => {
  if (e.key !== SESS) return;
  const s = storedSession();
  if (s && (!session || s.refresh_token !== session.refresh_token)) { const was = !!session; session = s; if (!was) { setSyncStatus('ok'); render(); syncNow(); } }
  else if (!s && session) { session = null; setSyncStatus('off'); render(); }
});
async function signIn(email, password, create){
  const path = create ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
  const r = await fetch(SB_URL + path, {method:'POST', headers:jsonHeaders(), body:JSON.stringify({email, password})});
  if (!r.ok) throw new Error(await sbErr(r));
  const j = await r.json();
  if (!j.access_token) throw new Error('CONFIRMAR');   // conta criada: falta confirmar pelo link do e-mail
  setSession(j);
  // mesma conta de antes neste aparelho: continua de onde parou; conta nova/primeira vez: junta o que tem aqui com a nuvem
  if (sstate.uid !== j.user.id) { sstate = freshState(); sstate.uid = j.user.id; saveState(); }
}
function syncLogoutLocal(){ session = null; saveSession(); sstate = freshState(); saveState(); setSyncStatus('off'); }

/* ---------------- sincronização ---------------- */
function snapshot(){
  const m = new Map();
  for (const k of SYNC_KINDS) for (const r of db[k] || []) m.set(k + ':' + r.id, {kind:k, id:r.id, data:r});
  m.set('meta:settings', {kind:'meta', id:'settings', data:{kmL:db.settings.kmL || '', fuel:db.settings.fuel || ''}});
  m.set('meta:contentLog', {kind:'meta', id:'contentLog', data:db.contentLog || {}});
  return m;
}
async function pull(){
  const since = sstate.lastPull ? new Date(new Date(sstate.lastPull).getTime() - 5000).toISOString() : null;
  const rows = [], page = 1000;
  for (let from = 0; ; from += page) {
    const q = '/rest/v1/items?select=kind,id,data,deleted,updated_at&order=updated_at.asc' + (since ? '&updated_at=gt.' + encodeURIComponent(since) : '');
    const r = await sbFetch(q, {headers:{Range:`${from}-${from + page - 1}`, 'Range-Unit':'items'}});
    if (!r.ok) throw new Error('baixar: ' + await sbErr(r));
    const batch = await r.json(); rows.push(...batch);
    if (batch.length < page) break;
  }
  if (!rows.length) return false;
  const snap = snapshot();
  let changed = false, maxU = sstate.lastPull;
  for (const row of rows) {
    if (!maxU || row.updated_at > maxU) maxU = row.updated_at;
    const key = row.kind + ':' + row.id, local = snap.get(key), synced = sstate.hashes[key];
    const localDirty = local ? recHash(local.data) !== synced : synced !== undefined; // mudou (ou foi apagado) aqui e ainda não subiu
    if (row.kind === 'meta') {
      if (row.deleted || !row.data) continue;
      if (row.id === 'settings') { for (const f of ['kmL','fuel']) if (row.data[f] && (!localDirty || !db.settings[f])) { db.settings[f] = row.data[f]; changed = true; } }
      if (row.id === 'contentLog') { db.contentLog = {...row.data, ...(db.contentLog || {})}; changed = true; }
      if (!localDirty) sstate.hashes[key] = recHash(snapshot().get(key).data);
      continue;
    }
    if (!SYNC_KINDS.includes(row.kind) || localDirty) continue;   // mudança local mais recente vence e sobe em seguida
    const arr = db[row.kind], i = arr.findIndex(x => x.id === row.id);
    if (row.deleted) { if (i >= 0) { arr.splice(i, 1); changed = true; } delete sstate.hashes[key]; }
    else if (row.data) { if (i >= 0) arr[i] = row.data; else arr.push(row.data); sstate.hashes[key] = recHash(row.data); changed = true; }
  }
  sstate.lastPull = maxU; saveState();
  return changed;
}
function dedupeReminders(){
  // celular e computador criaram o mesmo lembrete padrão: fica só um
  const groups = new Map();
  for (const r of db.reminders) {
    const k = [r.title, r.time, (r.days || []).slice().sort().join(',')].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keep = new Set([...groups.values()].map(g => g.find(r => r.id === 'jiu-padrao') || g[0]));
  db.reminders = db.reminders.filter(r => keep.has(r));
}
async function pushMedia(){
  for (const id of new Set(allPhotoIds())) {
    if (sstate.media[id]) continue;
    const blob = await idb.get(id).catch(() => null); if (!blob) continue;
    const r = await sbFetch(`/storage/v1/object/media/${session.user.id}/${id}`, {method:'POST', headers:{'Content-Type':blob.type || 'application/octet-stream', 'x-upsert':'true'}, body:blob});
    if (!r.ok) throw new Error('foto/áudio: ' + await sbErr(r));
    sstate.media[id] = 1; saveState();
  }
}
async function fetchRemoteMedia(id){
  if (!session || !navigator.onLine) return null;
  try {
    const r = await sbFetch(`/storage/v1/object/authenticated/media/${session.user.id}/${id}`);
    if (!r.ok) return null;
    const b = await r.blob(); await idb.put(id, b); sstate.media[id] = 1; saveState(); return b;
  } catch(e) { return null; }
}
async function push(){
  const snap = snapshot(), up = [], uidv = session.user.id;
  for (const [key, r] of snap) { const h = recHash(r.data); if (sstate.hashes[key] !== h) up.push({key, h, row:{user_id:uidv, kind:r.kind, id:r.id, data:r.data, deleted:false}}); }
  for (const key of Object.keys(sstate.hashes)) if (!snap.has(key)) { const i = key.indexOf(':'); up.push({key, h:null, row:{user_id:uidv, kind:key.slice(0, i), id:key.slice(i + 1), data:null, deleted:true}}); }
  await pushMedia();
  for (let i = 0; i < up.length; i += 200) {
    const chunk = up.slice(i, i + 200);
    const r = await sbFetch('/rest/v1/items?on_conflict=user_id,kind,id', {method:'POST', headers:{'Content-Type':'application/json', Prefer:'resolution=merge-duplicates,return=minimal'}, body:JSON.stringify(chunk.map(x => x.row))});
    if (!r.ok) throw new Error('enviar: ' + await sbErr(r));
    for (const x of chunk) { if (x.h === null) delete sstate.hashes[x.key]; else sstate.hashes[x.key] = x.h; }
    saveState();
  }
  return up.length;
}

let syncing = null, syncAgain = false, syncTimer = null;
function syncSoon(){ if (!session || !syncConfigured()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), 1500); }
async function syncNow(manual){
  if (!syncConfigured() || !session) return;
  if (syncing) { syncAgain = true; return syncing; }
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  setSyncStatus('syncing');
  syncing = (async () => {
    try {
      const changed = await pull();
      if (changed) { dedupeReminders(); localStorage.setItem(KEY, JSON.stringify(db)); if (!document.querySelector('#view input:focus, #view textarea:focus')) render(); }
      await push();
      sstate.lastSync = Date.now(); saveState(); syncErr = ''; setSyncStatus('ok');
      if (manual) toast('☁️ Tudo sincronizado');
    } catch(e) {
      console.warn('sync', e); syncErr = String(e.message || e);
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      if (manual) toast('Não consegui sincronizar agora');
    }
  })().finally(() => { syncing = null; if (syncAgain) { syncAgain = false; syncSoon(); } });
  return syncing;
}

/* ---------------- interface ---------------- */
const SYNC_TXT = {ok:'sincronizado', syncing:'sincronizando…', offline:'sem internet', error:'erro ao sincronizar', off:''};
function setSyncStatus(s){
  syncStatus = s;
  const d = document.getElementById('syncDot');
  if (d) { d.className = 'sdot ' + s; d.title = SYNC_TXT[s]; d.querySelector('span').textContent = SYNC_TXT[s]; }
  const t = document.getElementById('syncTxt'); if (t) t.textContent = SYNC_TXT[s] || '';
}
function syncSection(){
  if (!syncConfigured()) return '';
  if (session) {
    const ls = sstate.lastSync ? `${fmtShort(ymd(new Date(sstate.lastSync)))} às ${hm(sstate.lastSync)}` : '—';
    return `<div class="h"><h3>☁️ Sincronização</h3><span class="time" id="syncTxt">${SYNC_TXT[syncStatus] || ''}</span></div>
      <div class="kv"><span>Conta</span><b>${esc(session.user.email)}</b></div>
      <div class="kv"><span>Última sincronização</span><b>${ls}</b></div>
      ${syncStatus === 'error' && syncErr ? `<p class="time" style="color:var(--red-fg)">${esc(syncErr)}</p>` : ''}
      <button class="btn block" data-sync="now">Sincronizar agora</button>
      <button class="btn danger block" data-sync="logout">Sair desta conta neste aparelho</button>`;
  }
  return `<div class="h"><h3>☁️ Sincronização</h3></div>
    <p class="muted" style="font-size:14px;margin:6px 0">Entre com seu e-mail e senha para deixar celular e computador sempre iguais. Use a mesma conta nos dois.</p>
    <form id="sbForm" onsubmit="return false">
    ${prop('✉️', 'E-mail', `<input id="sbEmail" name="email" type="email" inputmode="email" autocomplete="username" placeholder="voce@email.com" value="${esc(loginEmail)}">`)}
    ${prop('🔑', 'Senha', `<input id="sbPass" name="password" type="password" autocomplete="current-password" placeholder="mínimo 8 caracteres">`)}
    <button class="btn block" data-sync="login">Entrar</button>
    <button class="btn ghost block" data-sync="signup">Criar minha conta</button></form>`;
}
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-sync]'); if (!el) return;
  const act = el.dataset.sync;
  if (act === 'login' || act === 'signup') {
    loginEmail = (document.getElementById('sbEmail').value || '').trim().toLowerCase();
    const pass = document.getElementById('sbPass').value || '';
    if (!/^\S+@\S+\.\S+$/.test(loginEmail)) { toast('Digite um e-mail válido'); return; }
    if (pass.length < 8) { toast('A senha precisa ter pelo menos 8 caracteres'); return; }
    if (act === 'signup' && !(await ask('Criar a conta ' + loginEmail + '? Use essa mesma conta no celular e no computador.', 'Criar conta'))) return;
    const label = el.textContent; el.disabled = true; el.textContent = 'Conectando…';
    try { await signIn(loginEmail, pass, act === 'signup'); toast('☁️ Conectado! Sincronizando…'); render(); await syncNow(); render(); }
    catch(err) {
      const m = String(err.message || '');
      if (m === 'CONFIRMAR') {
        el.disabled = false; el.textContent = label;
        openSheet({ title:'Confirme seu e-mail', save:null, html:`<div class="callout blue" style="margin-top:6px"><span class="ci">✉️</span><div>Conta criada! Enviei um e-mail para <b>${esc(loginEmail)}</b>.<br>Abra o e-mail e toque no link de confirmação (pode abrir em qualquer navegador). Depois volte aqui e toque em <b>Entrar</b>.</div></div><p class="time">Não chegou? Olhe a caixa de spam. O remetente é o Supabase.</p>` });
        return;
      }
      toast(/not confirmed/i.test(m) ? 'Confirme seu e-mail pelo link que enviei e tente de novo' :/invalid login/i.test(m) ? 'E-mail ou senha incorretos' : /already registered|already exists/i.test(m) ? 'Essa conta já existe. Toque em Entrar' : /signups? not allowed|disabled/i.test(m) ? 'Cadastro fechado. Use Entrar' : 'Não consegui: ' + m);
      el.disabled = false; el.textContent = label;
    }
  }
  if (act === 'now') { await syncNow(true); render(); }
  if (act === 'logout') {
    if (!(await ask('Sair da conta neste aparelho? Os dados continuam aqui e na nuvem, só param de sincronizar.', 'Sair', true))) return;
    try { await sbFetch('/auth/v1/logout', {method:'POST'}); } catch(err) {}
    syncLogoutLocal(); render(); toast('Desconectado');
  }
});

/* chegou pelo link de confirmação do e-mail: já entra */
(async () => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!syncConfigured() || !h.get('access_token') || !h.get('refresh_token')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', {headers:{apikey:SB_KEY, Authorization:'Bearer ' + h.get('access_token')}});
    if (!r.ok) return;
    setSession({access_token:h.get('access_token'), refresh_token:h.get('refresh_token'), expires_in:+h.get('expires_in') || 3600, user:await r.json()});
    if (sstate.uid !== session.user.id) { sstate = freshState(); sstate.uid = session.user.id; saveState(); }
    toast('✅ E-mail confirmado! Conectado'); render(); await syncNow(); render();
  } catch(e) {}
})();

/* quando sincronizar */
if (syncConfigured() && session) { setSyncStatus('ok'); syncNow(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
addEventListener('online', () => syncNow());
addEventListener('offline', () => session && setSyncStatus('offline'));
setInterval(() => { if (!document.hidden) syncNow(); }, 20000);
