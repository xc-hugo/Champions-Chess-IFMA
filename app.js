// app.js — Próximas partidas + prob sem influência de apostas + player de música + edição do torneio
// Firebase v12 (modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, orderBy, serverTimestamp, runTransaction, writeBatch, limit, increment
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
  getDatabase, ref as rtdbRef, set as rtdbSet, onChildAdded, onChildRemoved,
  remove as rtdbRemove, onValue
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

/* ==================== Helpers DOM ==================== */
const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmt2 = n => (n < 10 ? `0${n}` : `${n}`);
const esc = (s)=> String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function parseLocalDate(input){
  if(!input) return null;
  try{
    if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input)){
      const [d, t] = input.split("T");
      const [y,m,da] = d.split("-").map(Number);
      const [hh,mm] = t.split(":").map(Number);
      return new Date(y, m-1, da, hh, mm);
    }
    const d = new Date(input);
    if(!isNaN(d.getTime())) return d;
  }catch(_){}
  return null;
}
function fmtLocalDateStr(val){
  const d = val instanceof Date ? val : parseLocalDate(val);
  if(!d) return "—";
  return `${fmt2(d.getDate())}/${fmt2(d.getMonth()+1)}/${d.getFullYear()} ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function fmtDateDayTime(val){
  const d = val instanceof Date ? val : parseLocalDate(val);
  if(!d) return "—";
  const dias = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  return `${dias[d.getDay()]}, ${fmt2(d.getDate())}/${fmt2(d.getMonth()+1)}/${d.getFullYear()} • ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function fmtOnlyDate(val){
  const d = val instanceof Date ? val : parseLocalDate(val);
  if(!d) return "—";
  const dias = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  return `${dias[d.getDay()]} ${fmt2(d.getDate())}/${fmt2(d.getMonth()+1)}`;
}
function fmtTime(val){
  const d = parseLocalDate(val);
  if(!d) return "—";
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
const clamp01 = x => Math.max(0, Math.min(1, x));
const clampPct = x => Math.max(0, Math.min(100, x));

/* IDs e nomes */
function deriveUserId({ profile, email, uid }){
  return (profile?.userId) || (profile?.username) || (email ? email.split("@")[0] : (uid ? uid.slice(0,6) : "—"));
}
function deriveUserIdFromMaps(uid, profilesMap, walletsMap){
  const p = profilesMap?.[uid] || {};
  const w = walletsMap?.[uid] || {};
  return p.userId || p.username || (p.email || w.email || uid).split("@")[0];
}

/* ==================== Config ==================== */
const firebaseConfig = {
  apiKey: "AIzaSyCP3RH4aR-sSbB7CeZV6c6cpj9fC4HjhCw",
  authDomain: "championschessifma.firebaseapp.com",
  projectId: "championschessifma",
  storageBucket: "championschessifma.firebasestorage.app",
  messagingSenderId: "341916270688",
  appId: "1:341916270688:web:eea60783f83c4a002cc305",
  measurementId: "G-CRQSG5KVHY"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const rtdb = getDatabase(app);

// Coleções
const C_WALLETS = "wallets";
const C_BETS    = "bets";
const C_SETTINGS= "settings";

// Apostas / sistema
const BET_COST   = 2;       // CCIP debitados por aposta
const MIN_SEED_POINTS = 6;  // saldo inicial (CCIP)
const ONE_DAY_MS = 24*60*60*1000;
const UNDO_WINDOW_MS = 5000;

// Música
const TRACK_SRC = "./Joy Crookes - Feet Don't Fail Me Now (Lyrics).mp3";

/* ==================== Estado ==================== */
const state = {
  user: null,
  admin: false,
  players: [],
  matches: [],
  posts: [],
  bets: [],
  wallet: 0, // CCIP (points)
  listeners: {
    players:null, matches:null, posts:null, bets:null, wallet:null, chat:null, admin:null, betsFeed:null, settings:null,
  },
  feedRowsData: {},
  rankings: { bestByWins: [], mostPoints: [], mostBets: [], profilesMap: {}, walletsMap: {} },
  tournamentId: 1,
  winners: [],

  // Música
  audio: null,
  audioUI: null,
  audioStarted: false,
};

let _bootShown = false;
let _autoPostponeLock = false;
let undoState = null;

/* ==================== Abas ==================== */
function showTab(tab){
  $$(".view").forEach(v=>v.classList.remove("visible"));
  $$(".tab").forEach(b=>b.classList.remove("active"));
  $(`#${tab}`)?.classList.add("visible");
  $(`.tab[data-tab="${tab}"]`)?.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function initTabs(){
  $$(".tab").forEach(btn=> btn.addEventListener("click", ()=> showTab(btn.dataset.tab)));
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener("click", (e)=>{
      const id = a.getAttribute("href").slice(1);
      if($(`#${id}`)){ e.preventDefault(); showTab(id); }
    });
  });
  $("#user-chip")?.addEventListener("click", ()=> showTab("perfil"));
}

/* ==================== Settings / Edição do Torneio ==================== */
function ensureTournamentBadge(){
  let badge = $("#tournament-badge");
  if(!badge){
    // tenta colocar na barra central de navegação
    const navCenter = document.querySelector(".nav-center") || document.querySelector("header") || document.body;
    badge = document.createElement("span");
    badge.id = "tournament-badge";
    badge.textContent = `Edição #${state.tournamentId}`;
    badge.style.cssText = "margin-left:8px;padding:4px 8px;border-radius:999px;background:#EEF2FF;color:#3730A3;font-weight:700;font-size:12px;display:inline-flex;align-items:center;gap:6px";
    navCenter?.appendChild(badge);
  }else{
    badge.textContent = `Edição #${state.tournamentId}`;
  }
}
function listenSettings(){
  if(state.listeners.settings) state.listeners.settings();
  const ref = doc(db, C_SETTINGS, "global");
  state.listeners.settings = onSnapshot(ref, (snap)=>{
    const cur = snap.exists() ? (Number(snap.data()?.tournamentId)||1) : 1;
    state.tournamentId = cur;
    ensureTournamentBadge();
  }, (_)=>{ ensureTournamentBadge(); });
}

/* ==================== Auth & Admin ==================== */
async function loginGoogle(){
  try{ await setPersistence(auth, browserLocalPersistence); }catch(_){}
  const provider = new GoogleAuthProvider();
  try{
    await signInWithPopup(auth, provider);
  }catch(err){
    if(err?.code?.startsWith("auth/popup")){
      await signInWithRedirect(auth, provider);
    }else{
      console.error("login error:", err);
      alert("Não foi possível entrar com Google. Tente novamente.");
    }
  }
}
async function logout(){ await signOut(auth); }

const ADMIN_EMAILS = [
  // "seu.email@ifma.edu.br",
];
function applyAdminUI(){
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !state.admin));
  $("#admin-matches-admin")?.remove();
  $("#seed-btn")?.closest(".row")?.remove();
  organizeAdminTools();
  updateAuthUI();
  renderMatches();
  renderPosts();
}
function listenAdmin(user){
  if(typeof state.listeners.admin === "function"){ state.listeners.admin(); state.listeners.admin=null; }
  if(!user){ state.admin=false; applyAdminUI(); return; }

  let fsActive = false;
  let rtdbActive = false;
  let byClaim = false;
  const byList = ADMIN_EMAILS.includes(user.email);

  const compute = ()=>{
    state.admin = !!(byList || fsActive || rtdbActive || byClaim);
    applyAdminUI();
  };

  const adminsRef = doc(db,"admins", user.uid);
  const unsubFS = onSnapshot(adminsRef, (snap)=>{
    const d = snap.exists() ? snap.data() : null;
    fsActive = !!(d && (d.active===true || d.isAdmin===true));
    compute();
  }, (_e)=>{ fsActive=false; compute(); });

  const rtdbRefActive = rtdbRef(rtdb, `admins/${user.uid}/active`);
  const unsubRT = onValue(rtdbRefActive, (snap)=>{
    rtdbActive = snap.exists() && snap.val() === true;
    compute();
  }, (_e)=>{ rtdbActive = false; compute(); });

  user.getIdTokenResult(true).then(tk=>{
    byClaim = !!tk.claims?.admin; compute();
  }).catch(()=>{ byClaim=false; compute(); });

  state.listeners.admin = ()=> { try{unsubFS();}catch(_){}
                                 try{unsubRT();}catch(_){}};  
}

/* Chat enable/desabilita & aposta habilitada apenas com saldo */
function setChatEnabled(enabled){
  const input = $("#chat-text");
  const form  = $("#chat-form");
  input && (input.disabled = !enabled);
  form && (form.querySelectorAll("input,button,textarea").forEach(el=> el.disabled = !enabled));
  $("#chat-login-hint")?.classList.toggle("hidden", !!enabled);
}
function updateBetFormEnabled(){
  const form = $("#bet-form");
  if(!form) return;
  const submit = form.querySelector('button[type="submit"], .btn[type="submit"], .btn-primary');
  const can = !!state.user && (state.wallet >= BET_COST);
  if(submit) submit.disabled = !can;
  const hint = ensureOddsHint();
  if(hint){
    if(!state.user) hint.textContent = "Entre com Google para apostar.";
    else if(state.wallet < BET_COST) hint.textContent = `Saldo insuficiente para apostar (precisa de ${BET_COST} CCIP).`;
  }
}
function updateAuthUI(){
  const chip = $("#user-chip");
  const email = $("#user-email");
  const adminBadge = $("#admin-badge");
  const btnLogin = $("#btn-open-login");
  const btnOut = $("#btn-logout");
  const tabAdmin = $("#tab-admin");

  if(state.user){
    chip?.classList.remove("hidden");
    email && (email.textContent = state.user.displayName || state.user.email);
    btnLogin?.classList.add("hidden");
    btnOut?.classList.remove("hidden");
    if(state.admin){ adminBadge?.classList.remove("hidden"); tabAdmin?.classList.remove("hidden"); }
    else { adminBadge?.classList.add("hidden"); tabAdmin?.classList.add("hidden"); }
    setChatEnabled(true);
  }else{
    chip?.classList.add("hidden");
    btnLogin?.classList.remove("hidden");
    btnOut?.classList.add("hidden");
    adminBadge?.classList.add("hidden");
    tabAdmin?.classList.add("hidden");
    setChatEnabled(false);
  }

  const betForm = $("#bet-form");
  betForm && betForm.querySelectorAll("input,select,button,textarea").forEach(i=> i.disabled = !state.user);
  updateBetFormEnabled();
}

/* ==================== Perfil ==================== */
async function loadProfileIntoState(uid){
  try{
    const snap = await getDoc(doc(db,"profiles", uid));
    if(snap.exists()){
      const p = snap.data();
      const name = p.displayName || p.name;
      if(name){ state.user.displayName = name; }
    }
  }catch(_){}
}
function bindProfileForm(){
  $("#profile-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
    if(!state.user) return;
    const name = $("#profile-name").value.trim();
    try{
      await setDoc(doc(db,"profiles",state.user.uid), {
        displayName: name || null, email: state.user.email || null, updatedAt: serverTimestamp()
      }, { merge:true });
      state.user.displayName = name || state.user.displayName;
      updateAuthUI();
      alert("Perfil salvo!");
    }catch(err){
      console.error("perfil save", err);
      alert("Sem permissão para salvar perfil. Verifique as rules de /profiles.");
    }
  });
}
function fillProfile(){
  if(!state.user){
    $("#profile-name") && ($("#profile-name").value = "");
    $("#profile-email") && ($("#profile-email").value = "");
    $("#profile-username") && ($("#profile-username").textContent = "—");
    return;
  }
  $("#profile-name") && ($("#profile-name").value = state.user.displayName || "");
  $("#profile-email") && ($("#profile-email").value = state.user.email || "");
  $("#profile-username") && ($("#profile-username").textContent = state.user.uid.slice(0,6));
}

/* ==================== Carteira (CCIP) ==================== */
function _coercePoints(p){
  if(typeof p === "string"){
    const parsed = parseFloat(String(p).replace(",","."));
    if(Number.isFinite(parsed)) return parsed;
    return 0;
  }
  return Number.isFinite(p) ? p : 0;
}
function listenWallet(uid){
  if(state.listeners.wallet) state.listeners.wallet();
  if(!uid){
    state.wallet=0; renderWalletCard(); return;
  }
  state.listeners.wallet = onSnapshot(doc(db,C_WALLETS,uid),(snap)=>{
    let pts = 0;
    if(snap.exists()){
      pts = _coercePoints(snap.data()?.points);
    }
    state.wallet = pts;
    renderWalletCard();
  }, (err)=> {
    console.error("listenWallet:", err);
    state.wallet = 0; renderWalletCard();
  });
}
async function ensureWalletInit(uid){
  if(!uid) return;
  const refWal = doc(db, C_WALLETS, uid);
  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(refWal);
      if(!snap.exists()){
        tx.set(refWal, { points: MIN_SEED_POINTS, email: auth.currentUser?.email||null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }else if(!snap.data()?.email){
        tx.set(refWal, { email: auth.currentUser?.email||null, updatedAt: serverTimestamp() }, { merge:true });
      }
    });
  }catch(e){
    try{
      const snap = await getDoc(refWal);
      if(!snap.exists()){
        await setDoc(refWal, { points: MIN_SEED_POINTS, email: auth.currentUser?.email||null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
    }catch(err){ console.error("ensureWalletInit fallback:", err); }
  }
}

/* Estatísticas da carteira */
function computeMyBetStats(){
  let total=0, wins=0, totalStaked=0, settledStaked=0, returns=0;
  for(const b of state.bets){
    total++;
    const stake = b.stake || BET_COST;
    totalStaked += stake;
    if(b.status && b.status!=="pendente"){ settledStaked += stake; }
    if(b.status==="ganhou"){
      const ret = Number.isFinite(b.settledPayout) ? b.settledPayout : (b.payoutPoints||0);
      wins++; returns += ret;
    }
  }
  const profit = returns - settledStaked;
  const roi = settledStaked ? Math.round((profit/settledStaked)*100) : 0;
  return { total, wins, totalStaked, settledStaked, returns, profit, roi };
}
function renderWalletCard(){
  const card = $("#apostas .grid-2 .card:first-child");
  if(!card) return;
  const my = computeMyBetStats();
  card.innerHTML = `
    <h2>Sua Carteira</h2>
    <div class="table">
      <table>
        <tbody>
          <tr><td><b>Saldo</b></td><td><span id="wallet-ccip">${state.wallet||0}</span> CCIP</td></tr>
          <tr><td><b>Recompensa base por acerto</b></td><td>+${BET_COST} CCIP (mín.)</td></tr>
          <tr><td><b>Total apostado</b></td><td>${my.totalStaked} CCIP</td></tr>
          <tr><td><b>Retornos recebidos</b></td><td>${my.returns} CCIP</td></tr>
          <tr><td><b>Lucro líquido</b></td><td>${my.profit} CCIP</td></tr>
          <tr><td><b>Apostas</b></td><td>${my.total} (${my.wins} ganhas)</td></tr>
          <tr><td><b>ROI</b></td><td>${my.roi}%</td></tr>
        </tbody>
      </table>
    </div>
  `;
  $("#wallet-points") && ($("#wallet-points").textContent = String(state.wallet));
  updateBetFormEnabled();
}

/* ==================== Chat (RTDB) ==================== */
function initChat(){
  if(state.listeners.chat) return;
  const list = $("#chat-list");
  const form = $("#chat-form");
  const input = $("#chat-text");
  const chatRef = rtdbRef(rtdb,"chat");

  const renderItem = (id, msg) => {
    const now = Date.now();
    if(msg.ts && (now - msg.ts) > ONE_DAY_MS) return;
    const el = document.createElement("div");
    el.className = "chat-item";
    el.id = `chat-${id}`;
    const d = new Date(msg.ts||Date.now());
    const hh = fmt2(d.getHours()), mm = fmt2(d.getMinutes());
    const canDel = state.admin || (state.user && state.user.uid===msg.uid);
    el.innerHTML = `
      <div class="meta"><b>${msg.name||"—"}</b> &lt;${msg.email||"—"}&gt; • ${hh}:${mm}</div>
      <div>${(msg.text||"").replace(/</g,"&lt;")}</div>
      ${canDel? `<div style="margin-top:8px"><button class="btn danger small btn-del-chat" data-id="${id}">🗑 Apagar</button></div>`:""}
    `;
    list?.appendChild(el);
    if(canDel){
      el.querySelector(".btn-del-chat")?.addEventListener("click", async ()=>{
        if(!confirm("Apagar esta mensagem do chat?")) return;
        try{ await rtdbRemove(rtdbRef(rtdb, `chat/${id}`)); }
        catch(err){ console.error(err); alert("Sem permissão para apagar no RTDB."); }
      });
    }
  };

  state.listeners.chat = onChildAdded(chatRef, (snap)=> renderItem(snap.key, snap.val()));
  onChildRemoved(chatRef, (snap)=> $(`#chat-${snap.key}`)?.remove());

  form?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
    if(!state.user) return alert("Entre com Google para enviar.");
    const text = (input?.value||"").trim();
    if(!text) return;
    await rtdbSet(rtdbRef(rtdb, `chat/${Date.now()}_${Math.random().toString(36).slice(2)}`), {
      uid: state.user.uid,
      name: state.user.displayName || state.user.email,
      email: state.user.email || "",
      text, ts: Date.now()
    });
    input.value = "";
  });

  setChatEnabled(!!state.user);
}

/* ==================== Players & Tabelas ==================== */
function listenPlayers(){
  if(state.listeners.players) state.listeners.players();
  state.listeners.players = onSnapshot(query(collection(db,"players"), orderBy("name","asc")), (qs)=>{
    state.players = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderPlayers(); renderPlayerSelects(); renderTables(); renderBetsSelect(); renderHome();
  });
}
function renderPlayers(){
  $("#player-search")?.closest(".card")?.classList.add("hidden");
  $("#player-select")?.closest(".row")?.classList.add("hidden");

  const a = state.players.filter(p=>p.group==="A");
  const b = state.players.filter(p=>p.group==="B");
  const mkCard = p => `
    <div class="player-card" data-id="${p.id}">
      <div class="avatar">${(p.name||"?").slice(0,2).toUpperCase()}</div>
      <div class="player-meta">
        <div class="name">${p.name||"?"}</div>
        <div class="muted">Grupo ${p.group||"—"}</div>
      </div>
    </div>`;
  $("#players-cards-A") && ($("#players-cards-A").innerHTML = a.map(mkCard).join("") || "<p class='muted'>Sem jogadores.</p>");
  $("#players-cards-B") && ($("#players-cards-B").innerHTML = b.map(mkCard).join("") || "<p class='muted'>Sem jogadores.</p>");

  $$("#players .player-card").forEach(card=> card.onclick = ()=> renderPlayerDetails(card.dataset.id));
}
function renderPlayerSelects(){
  const sA = $("#match-a"), sB = $("#match-b");
  if(sA && sB){
    const opts = state.players.map(p=> `<option value="${p.id}">${p.name}</option>`).join("");
    sA.innerHTML = opts; sB.innerHTML = opts;
  }
  const s1a=$("#semi1-a"), s1b=$("#semi1-b"), s2a=$("#semi2-a"), s2b=$("#semi2-b");
  [s1a,s1b,s2a,s2b].forEach(sel=>{
    if(sel) sel.innerHTML = state.players.map(p=> `<option value="${p.id}">${p.name}</option>`).join("");
  });
}
function computePlayerStats(playerId){
  const groupMatches = state.matches.filter(m=> m.stage==="groups" && (m.aId===playerId || m.bId===playerId));
  let points=0,w=0,d=0,l=0,played=0;
  for(const m of groupMatches){
    if(!m.result || m.result==="postponed") continue;
    played++;
    if(m.result==="draw"){ d++; points+=1; }
    else if(m.result==="A"){
      if(m.aId===playerId){ w++; points+=3; } else { l++; }
    }else if(m.result==="B"){
      if(m.bId===playerId){ w++; points+=3; } else { l++; }
    }
  }
  return { points, wins:w, draws:d, losses:l, played };
}
function buildPlayerProfileHTML(p){
  const stats = computePlayerStats(p.id);
  const hist = state.matches
    .filter(m=> m.aId===p.id || m.bId===p.id)
    .sort((x,y)=> (parseLocalDate(y.date)||0) - (parseLocalDate(x.date)||0));
  const mapP=Object.fromEntries(state.players.map(pl=>[pl.id,pl.name]));
  const rows = hist.map(m=>{
    const res = m.result==="draw" ? "Empate"
      : m.result==="postponed" ? "Adiado"
      : m.result==="A" ? (m.aId===p.id?"Vitória":"Derrota")
      : m.result==="B" ? (m.bId===p.id?"Vitória":"Derrota")
      : "Pendente";
    return `
      <tr>
        <td>${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}` : stageLabel(m.stage)}</td>
        <td>${fmtLocalDateStr(m.date)}</td>
        <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
        <td>${res}</td>
        <td>${m.code||"—"}</td>
      </tr>`;
  }).join("");

  return `
    <div class="card">
      <div class="profile-hero">
        <div class="profile-avatar">${(p.name||"?").slice(0,2).toUpperCase()}</div>
        <div>
          <h2 style="margin:0">${p.name||"—"} <span class="badge-small">Grupo ${p.group||"—"}</span></h2>
          <div class="profile-stats">
            <div class="stat"><b>Pontos (Grupos):</b> ${stats.points}</div>
            <div class="stat"><b>V:</b> ${stats.wins} · <b>E:</b> ${stats.draws} · <b>D:</b> ${stats.losses}</div>
            <div class="stat"><b>Jogos:</b> ${stats.played}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Histórico de Partidas</h3>
      <div class="table">
        <table>
          <thead>
            <tr><th>Etapa</th><th>Data/Hora</th><th>Partida</th><th>Resultado</th><th>Código</th></tr>
          </thead>
          <tbody>${rows||`<tr><td colspan="5" class="muted">Sem partidas registradas.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}
function renderPlayerDetails(playerId){
  const p = state.players.find(x=>x.id===playerId);
  if(!p){ $("#player-details") && ($("#player-details").innerHTML = "<p class='muted'>Selecione um jogador.</p>"); return; }
  const stats = computePlayerStats(p.id);
  $("#player-details") && ($("#player-details").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="avatar" style="width:54px;height:54px;font-size:18px">${(p.name||"?").slice(0,2).toUpperCase()}</div>
        <div>
          <div style="font-weight:800">${p.name}</div>
          <div class="muted">Grupo ${p.group}</div>
          <div class="muted">Grupos: <b>${stats.points} pts</b> • V ${stats.wins} / E ${stats.draws} / D ${stats.losses}</div>
        </div>
      </div>
      <div><button class="btn ghost" id="btn-open-player-profile" data-id="${p.id}">Abrir perfil</button></div>
    </div>
  `);
  $("#btn-open-player-profile")?.addEventListener("click", ()=>{
    $("#player-profile").innerHTML = buildPlayerProfileHTML(p);
    showTab("player-profile");
  });
}
function renderTables(){
  ["A","B"].forEach(g=>{
    const rows = state.players.filter(p=>p.group===g).map(p=>{
      const s = computePlayerStats(p.id);
      return { id:p.id, name:p.name, ...s };
    }).sort((a,b)=> (b.points-a.points) || (b.wins-a.wins) || a.name.localeCompare(b.name));
    const html = `
      <div class="table">
        <table>
          <thead><tr><th>#</th><th>Jogador</th><th>J</th><th>V</th><th>E</th><th>D</th><th>Pts</th></tr></thead>
          <tbody>
            ${rows.map((r,i)=>`
              <tr class="${i===0?'pos-1': i===1?'pos-2':''}">
                <td>${i+1}</td><td>${r.name}</td><td>${r.played}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td><b>${r.points}</b></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    $(`#table-${g}`) && ($(`#table-${g}`).innerHTML = html);
  });
}

/* ==================== Partidas ==================== */
function stageLabel(s){
  if(s==="semifinal") return "Semifinal";
  if(s==="final") return "Final";
  if(s==="third") return "3º Lugar";
  if(s==="groups") return "F. Grupos";
  return s||"—";
}

/* >>> Probabilidades (apenas V/E/D históricas; sem influência do volume de apostas) */
function probVED(m){
  const sA = computePlayerStats(m.aId);
  const sB = computePlayerStats(m.bId);

  // Probabilidade de empate baseada no histórico de EMPATES
  const drawA = (sA.draws + 1) / (sA.played + 3);
  const drawB = (sB.draws + 1) / (sB.played + 3);
  let pE = clamp01((drawA + drawB) / 2);
  pE = Math.max(0.05, Math.min(0.45, pE)); // limites razoáveis para X

  // Força de vitória de cada um (Vitórias vs derrotas; empates removidos da conta)
  const wlA = (sA.wins + 1) / ((sA.wins + sA.losses) + 2);
  const wlB = (sB.wins + 1) / ((sB.wins + sB.losses) + 2);

  const rem = Math.max(0, 1 - pE);
  const sum = (wlA + wlB) || 1;
  let pA = rem * (wlA / sum);
  let pB = rem - pA;

  const A = Math.round(clampPct(pA*100));
  const E = Math.round(clampPct(pE*100));
  let D = 100 - A - E; // B
  if(D < 0){ D = 0; }

  return { A, E, D };
}
function payoutForPick(m, pick){
  const p = probVED(m);
  const probPct = pick==="A" ? p.A : pick==="B" ? p.D : p.E;
  let pr = probPct/100; if(pr <= 0) pr = 0.01;
  const dec = Math.max(1.5, Math.min(5.0, 0.9*(1/pr)));
  const payout = Math.max(2, Math.round(BET_COST * dec));
  return { probPct, payout };
}

/* ===== Filtros & Partidas UI ===== */
function buildOrMountStatusFilter(){
  const filtersBox = $("#partidas .filters");
  if(!filtersBox) return;
  if($("#filter-status")) return;
  const sel = document.createElement("select");
  sel.id = "filter-status";
  sel.innerHTML = `
    <option value="all">Todas</option>
    <option value="pending">Pendentes</option>
    <option value="finished">Concluídas</option>
    <option value="postponed">Adiadas</option>
  `;
  sel.addEventListener("change", renderMatches);
  filtersBox.appendChild(sel);
}
function matchStatus(m){
  if(m.result === "postponed") return "postponed";
  if(m.result === "A" || m.result === "B" || m.result==="draw") return "finished";
  return "pending";
}
function listenMatches(){
  if(state.listeners.matches) state.listeners.matches();
  state.listeners.matches = onSnapshot(query(collection(db,"matches"), orderBy("date","asc")), async (qs)=>{
    state.matches = qs.docs.map(d=>({id:d.id, ...d.data()}));
    buildOrMountStatusFilter();
    renderMatches(); renderTables(); renderBetsSelect(); renderHome();

    if(state.admin && !_autoPostponeLock){
      _autoPostponeLock = true;
      try { await autoPostponeOverdue(); } finally { _autoPostponeLock = false; }
    }
    if(state.admin) await autoCreateSemisIfDone();
    if(state.admin) await ensureChampionRecorded();

    settleBetsIfFinished();
    updateFeedStatuses();
    rebuildRankings();
  });
}
function renderMatches(){
  const filterSel = $("#filter-stage");
  const statusSel = $("#filter-status");
  const stageFilter = filterSel?.value || "groups";
  const statusFilter = statusSel?.value || "all";

  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  let items = state.matches.slice();

  items = items.filter(m=>{
    if(stageFilter==="all") return true;
    if(stageFilter==="groups") return m.stage==="groups";
    if(stageFilter==="groupA") return m.stage==="groups" && m.group==="A";
    if(stageFilter==="groupB") return m.stage==="groups" && m.group==="B";
    if(stageFilter==="semifinal") return m.stage==="semifinal";
    return true;
  });
  items = items.filter(m=> (statusFilter==="all") ? true : matchStatus(m)===statusFilter);

  const resLabel = (m)=>{
    if(m.result==="A") return mapP[m.aId]||"?";
    if(m.result==="B") return mapP[m.bId]||"?";
    if(m.result==="draw") return "Empate";
    if(m.result==="postponed") return "Adiado";
    return "Pendente";
  };

  const mkRow = (m)=> {
    const p = probVED(m);
    const aName = mapP[m.aId]||"?";
    const bName = mapP[m.bId]||"?";
    const lineA = `V ${p.A}% • E ${p.E}% • D ${p.D}%`;
    const lineB = `V ${p.D}% • E ${p.E}% • D ${p.A}%`;
    return `
      <tr data-id="${m.id}">
        <td><span class="chip chip--stage">${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}` : stageLabel(m.stage)}</span></td>
        <td><b>${aName}</b> × <b>${bName}</b></td>
        <td>${fmtLocalDateStr(m.date)}</td>
        <td>
          <div class="muted"><b>${aName}:</b> ${lineA}</div>
          <div class="muted"><b>${bName}:</b> ${lineB}</div>
        </td>
        <td><span class="chip chip--code">${m.code||"-"}</span></td>
        <td><span class="chip chip--res">${resLabel(m)}</span></td>
        ${state.admin? `<td><button class="btn ghost btn-edit" data-id="${m.id}">Editar</button></td>` : ""}
      </tr>
    `;
  };

  const GA = items.filter(m=>m.stage==="groups" && m.group==="A");
  const GB = items.filter(m=>m.stage==="groups" && m.group==="B");
  const KO = items.filter(m=>m.stage!=="groups");

  const mkTable = (arr)=>`
    <div class="table">
      <table>
        <thead>
          <tr>
            <th>Etapa/Grupo</th>
            <th>Partida</th>
            <th>Data/Hora</th>
            <th>Probabilidades (V/E/D)</th>
            <th>Código</th>
            <th>Resultado</th>
            ${state.admin?`<th>Ações</th>`:""}
          </tr>
        </thead>
        <tbody>${arr.map(mkRow).join("")}</tbody>
      </table>
    </div>
  `;

  let html = "";
  if(GA.length) html += `<div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo A</h3>${mkTable(GA)}</div>`;
  if(GB.length) html += `<div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo B</h3>${mkTable(GB)}</div>`;
  if(KO.length) html += `<div class="card"><h3>Fase KO</h3>${mkTable(KO)}</div>`;

  $("#matches-list") && ($("#matches-list").innerHTML = html || `<div class="card"><p class="muted">Nenhuma partida.</p></div>`);
  if(state.admin){ $$(".btn-edit").forEach(b=> b.onclick = ()=> loadMatchToForm(b.dataset.id)); }
  $("#filter-stage")?.addEventListener("change", renderMatches, { once:true });
}

/* ===== Form Partida (admin) ===== */
function bindMatchForm(){
  const form = $("#match-form");
  const resetBtn = $("#match-reset");
  const delBtn = $("#match-delete");

  form?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
    if(!state.admin) return alert("Apenas admin pode salvar partidas.");
    try{
      const id = $("#match-id").value || null;
      const aId = $("#match-a").value;
      const bId = $("#match-b").value;
      const stage = $("#match-stage").value;
      const group = $("#match-group").value || "";
      const code = $("#match-code").value.trim();
      const result = $("#match-result").value || "";
      const dateNew = $("#match-date").value;
      const dateOrig = $("#match-date-orig").value;

      const payload = { aId, bId, stage, group: group||null, code: code||null, result: result||null };
      if(dateNew){ payload.date = dateNew; }
      else if(!id){ payload.date = null; }
      if(id && !dateNew && dateOrig){ payload.date = dateOrig; }

      if(!id) await addDoc(collection(db,"matches"), { ...payload, createdAt: serverTimestamp() });
      else await updateDoc(doc(db,"matches",id), { ...payload, updatedAt: serverTimestamp() });

      form.reset(); $("#match-id").value=""; $("#match-date-orig").value="";
    }catch(err){
      console.error("Salvar partida:", err);
      alert("Erro ao salvar partida. Verifique permissões.");
    }
  });

  resetBtn?.addEventListener("click", ()=> { form.reset(); $("#match-id").value=""; $("#match-date-orig").value=""; });

  delBtn?.addEventListener("click", async ()=>{
    if(!state.admin) return alert("Apenas admin pode excluir.");
    const id = $("#match-id").value;
    if(!id) return;
    if(!confirm("Excluir esta partida?")) return;
    await deleteDoc(doc(db,"matches",id));
    form.reset(); $("#match-id").value=""; $("#match-date-orig").value="";
  });
}
function loadMatchToForm(id){
  const m = state.matches.find(x=>x.id===id);
  if(!m) return;
  $("#match-id").value = m.id;
  $("#match-a").value = m.aId || "";
  $("#match-b").value = m.bId || "";
  $("#match-stage").value = m.stage || "groups";
  $("#match-group").value = m.group || "";
  $("#match-code").value = m.code || "";
  $("#match-result").value = m.result || "";
  $("#match-date").value = m.date ? (()=>{
    const d = parseLocalDate(m.date);
    return `${d.getFullYear()}-${fmt2(d.getMonth()+1)}-${fmt2(d.getDate())}T${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
  })() : "";
  $("#match-date-orig").value = m.date || "";
  $("#admin-matches")?.scrollIntoView({ behavior:"smooth", block:"start" });
}

/* ==================== Home & Posts ==================== */
function renderHome(){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const pendingScheduled = state.matches.filter(m=> !m.result && !!m.date).slice().sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));

  const today=new Date(); const s=new Date(today); s.setHours(0,0,0,0); const e=new Date(today); e.setHours(23,59,59,999);
  const isSameDay=(d1,d2)=> d1.getFullYear()==d2.getFullYear()&&d1.getMonth()==d2.getMonth()&&d1.getDate()==d2.getDate();

  let pick = pendingScheduled.filter(m=>{const d=parseLocalDate(m.date);return d&&d>=s&&d<=e;});
  if(pick.length===0){
    let nextDay=null; 
    for(const m of pendingScheduled){ const d=parseLocalDate(m.date); if(d && d>e){ nextDay=d; break; } }
    if(nextDay){ pick=pendingScheduled.filter(m=>{const d=parseLocalDate(m.date); return d&&isSameDay(d,nextDay);}); }
  }
  pick=pick.slice(0,6); // mais cheio

  const stageText = (m)=>{
    if(m.stage==="groups") return `F. Grupos${m.group?` ${m.group}`:""}`;
    if(m.stage==="semifinal") return "Semifinal";
    if(m.stage==="final") return "Final";
    if(m.stage==="third") return "3º Lugar";
    return m.stage||"—";
  };

  const rows=pick.map(m=>{
    const p = probVED(m);
    const line = `V ${p.A}% • E ${p.E}% • D ${p.D}%`;
    return `
      <tr>
        <td>${fmtOnlyDate(m.date)}</td>
        <td>${fmtTime(m.date)}</td>
        <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
        <td>${stageText(m)} ${m.code?`<span class="chip chip--code">${m.code}</span>`:""}</td>
        <td class="muted">${line}</td>
      </tr>
    `;
  }).join("");

  const extra = pick.length ? "" : "<tr><td colspan='5'>Sem partidas pendentes hoje/próximo dia.</td></tr>";

  $("#home-next") && ($("#home-next").innerHTML=`
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h3 style="margin:0">Próximas partidas</h3>
        <span class="badge-small" title="Edição atual">Edição #${state.tournamentId}</span>
      </div>
      <div class="table" style="margin-top:8px">
        <table>
          <thead><tr><th>Dia</th><th>Hora</th><th>Partida</th><th>Etapa/Código</th><th>Prob.</th></tr></thead>
          <tbody>${rows || extra}</tbody>
        </table>
      </div>
      <p class="muted" style="margin-top:6px">Probabilidades baseadas no histórico de vitórias/empates/derrotas dos jogadores.</p>
    </div>
  `);

  const posts = state.posts.slice(0,3).map(p=>renderPostItem(p)).join("");
  $("#home-posts") && ($("#home-posts").innerHTML = posts || `<p class="muted">Sem comunicados.</p>`);
  if(state.admin){
    $$("#home-posts .btn-del-post").forEach(b=>{
      b.onclick=async ()=>{ if(!confirm("Apagar este comunicado?"))return; await deleteDoc(doc(db,"posts",b.dataset.id)); };
    });
  }
}
function listenPosts(){
  if(state.listeners.posts) state.listeners.posts();
  state.listeners.posts = onSnapshot(query(collection(db,"posts"), orderBy("createdAt","desc")), (qs)=>{
    state.posts = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderPosts(); renderHome();
  });
}
function renderPostItem(p){
  const dt = p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt? new Date(p.createdAt) : new Date());
  const hh = fmt2(dt.getHours()), mm = fmt2(dt.getMinutes());
  const who = p.authorName ? `${p.authorName} ${p.authorEmail?`&lt;${p.authorEmail}&gt;`:""}` : (p.authorEmail||"—");
  return `
    <div class="post" id="post-${p.id}">
      <div>
        <div class="meta"><b>${p.title||"Comunicado"}</b> — ${hh}:${mm} — ${who}</div>
        <div style="margin-top:8px">${(p.body||"").replace(/</g,"&lt;").replace(/\n/g,"<br>")}</div>
        ${state.admin? `<div style="margin-top:8px"><button class="btn danger small btn-del-post" data-id="${p.id}">🗑 Apagar</button></div>` : ""}
      </div>
    </div>
  `;
}
function renderPosts(){
  $("#posts-list") && ($("#posts-list").innerHTML = state.posts.map(renderPostItem).join("") || `<p class="muted">Sem comunicados.</p>`);
  if(state.admin){
    $$("#posts-list .btn-del-post").forEach(b=>{
      b.onclick=async ()=>{ if(!confirm("Apagar este comunicado?"))return; await deleteDoc(doc(db,"posts",b.dataset.id)); };
    });
  }
}
function bindPostForm(){
  $("#post-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
    try{
      const title = $("#post-title").value.trim();
      const body  = $("#post-body").value.trim();
      if(!title || !body) return;
      await addDoc(collection(db,"posts"), {
        title, body,
        authorUid: state.user?.uid||null,
        authorEmail: state.user?.email||null,
        authorName: state.user?.displayName||null,
        createdAt: serverTimestamp()
      });
      e.target.reset();
    }catch(err){
      console.error("post add", err); alert("Erro ao publicar post (permissão?).");
    }
  });
}

/* ==================== Apostas (minhas + UI) ==================== */
function ensureOddsHint(){
  if($("#bet-odds-hint")) return $("#bet-odds-hint");
  const form = $("#bet-form"); if(!form) return null;
  const p = document.createElement("p");
  p.id = "bet-odds-hint"; p.className = "muted"; p.style.marginTop = "8px";
  form.appendChild(p);
  return p;
}
function updateOddsHint(){
  const matchId = $("#bet-match")?.value;
  const pick = $("#bet-pick")?.value;
  const hint = ensureOddsHint(); if(!hint) return;
  if(!state.user){ hint.textContent = "Entre com Google para apostar."; return; }
  if(state.wallet < BET_COST){ hint.textContent = `Saldo insuficiente para apostar (precisa de ${BET_COST} CCIP).`; return; }
  if(!matchId || !pick){ hint.textContent = "Selecione a partida e o palpite para ver o retorno estimado."; return; }
  const m = state.matches.find(x=>x.id===matchId);
  if(!m){ hint.textContent = "Partida inválida."; return; }
  const { payout } = payoutForPick(m, pick);
  const lucro = Math.max(0, payout - BET_COST);
  hint.innerHTML = `Retorno estimado: <b>${payout}</b> CCIP (Lucro: <b>${lucro}</b>)`;
}
["change","input"].forEach(evt=>{
  $("#bet-match")?.addEventListener(evt, updateOddsHint);
  $("#bet-pick")?.addEventListener(evt, updateOddsHint);
});

function listenBets(){
  if(state.listeners.bets) state.listeners.bets();
  if(!state.user){ state.bets=[]; renderBetsTable(); renderBetsSelect(); renderWalletCard(); return; }
  state.listeners.bets = onSnapshot(
    query(collection(db,C_BETS), where("uid","==",state.user.uid)),
    (qs)=>{
      const list = qs.docs.map(d=>{
        const data = d.data();
        const ts = data.createdAt?.toMillis ? data.createdAt.toMillis()
                 : data.createdAt?.seconds ? data.createdAt.seconds*1000 : 0;
        return { id:d.id, __ts:ts, ...data };
      }).sort((a,b)=> b.__ts - a.__ts);
      state.bets = list;
      renderBetsTable(); renderBetsSelect(); renderWalletCard(); renderMatches();
    },
    (err)=> console.error("listenBets error:", err)
  );
}
function renderBetsTable(){
  const tbody = $("#bets-list"); if(!tbody) return;
  const thead = tbody.closest("table")?.querySelector("thead");
  if(thead){
    thead.innerHTML = `
      <tr>
        <th>Partida</th>
        <th>Etapa</th>
        <th>Palpite</th>
        <th>Data/Hora</th>
        <th>Status</th>
        <th>Retorno</th>
      </tr>`;
  }
  if(!state.bets.length){
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Sem apostas.</td></tr>`;
    return;
  }
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  tbody.innerHTML = state.bets.map(b=>{
    const m = state.matches.find(x=>x.id===b.matchId);
    const name = m ? `${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}` : "(partida removida)";
    const etapa = m ? `${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}` : stageLabel(m.stage)}` : "—";
    const created = b.__ts ? fmtLocalDateStr(new Date(b.__ts)) : "—";
    const statusStr = formatBetStatus(b);
    const retorno = (b.status==="ganhou" ? (b.settledPayout ?? b.payoutPoints ?? 0) : (b.payoutPoints ?? 0));
    return `<tr>
      <td>${name}</td>
      <td>${etapa}</td>
      <td>${b.pick==="A"?"Vitória A": b.pick==="B"?"Vitória B":"Empate"}</td>
      <td>${created}</td>
      <td>${statusStr}</td>
      <td>${retorno} CCIP</td>
    </tr>`;
  }).join("");
}
function renderBetsSelect(){
  const sel = $("#bet-match"); if(!sel) return;
  const already = new Set(state.bets.map(b=> b.matchId));
  const upcoming = state.matches.filter(m=>{
    if(!state.user) return false;
    if(m.result) return false;
    if(already.has(m.id)) return false;
    const d = parseLocalDate(m.date);
    return !d || d.getTime() > Date.now();
  });
  const pn = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  sel.innerHTML = `<option value="">— selecione —</option>` + upcoming.map(m=>
    `<option value="${m.id}">${pn[m.aId]||"?"} × ${pn[m.bId]||"?"} — ${stageLabel(m.stage)}${m.group?` ${m.group}`:""} ${m.code?`(${m.code})`:""}</option>`
  ).join("");
  $("#bet-pick")?.style.setProperty("width","100%");
  $("#bet-match")?.style.setProperty("width","100%");
  updateOddsHint();
}
function formatBetStatus(b){
  const lucro = Math.max(0, (b.payoutPoints||0) - (b.stake||BET_COST));
  if(!b.status || b.status === "pendente"){
    return `Pendente – Lucro: ${lucro}`;
  }
  if(b.status === "ganhou"){
    const ret = Number.isFinite(b.settledPayout) ? b.settledPayout : (b.payoutPoints||0);
    const luc = Math.max(0, ret - (b.stake||BET_COST));
    return `Ganhou +${ret} (Lucro: ${luc})`;
  }
  if(b.status === "perdeu")  return `Perdeu`;
  if(b.status === "postponed" || b.status==="adiada") return `Adiada`;
  return b.status;
}

/* ===== Undo da aposta ===== */
function ensureUndoBar(){
  if($("#bet-undo-bar")) return $("#bet-undo-bar");
  const card = $("#apostas .grid-2 .card:nth-child(2)"); if(!card) return null;
  const bar = document.createElement("div");
  bar.id = "bet-undo-bar";
  bar.style.cssText = "margin-top:8px;padding:8px;border:1px dashed #999;border-radius:8px;display:none;align-items:center;justify-content:space-between;gap:8px";
  bar.innerHTML = `
    <div id="bet-undo-text" class="muted">Aposta registrada.</div>
    <div style="display:flex;gap:8px;align-items:center">
      <span id="bet-undo-count" class="badge">5s</span>
      <button id="bet-undo-btn" class="btn danger small">Desfazer</button>
    </div>
  `;
  card.appendChild(bar);
  $("#bet-undo-btn")?.addEventListener("click", undoLastBet);
  return bar;
}
function showUndoBar(msg){
  const bar = ensureUndoBar(); if(!bar) return;
  $("#bet-undo-text").innerHTML = msg;
  $("#bet-undo-count").textContent = `5s`;
  bar.style.display = "flex";
}
function hideUndoBar(){ const bar = $("#bet-undo-bar"); if(bar) bar.style.display = "none"; }
async function undoLastBet(){
  if(!undoState) return;
  if(Date.now() > undoState.until) { hideUndoBar(); undoState=null; return; }
  try{
    await runTransaction(db, async (tx)=>{
      const walRef = doc(db,C_WALLETS,state.user.uid);
      const betRef = doc(db,C_BETS, undoState.id);
      const [betSnap, walSnap] = await Promise.all([tx.get(betRef), tx.get(walRef)]);
      if(!betSnap.exists()) throw new Error("Aposta já removida.");
      const cur = _coercePoints(walSnap.exists() ? walSnap.data().points : 0);
      tx.delete(betRef);
      tx.set(walRef, { points: cur + (undoState.refund||BET_COST), updatedAt: serverTimestamp() }, { merge:true });
    });
    if(undoState.feedKey){ try{ await rtdbRemove(rtdbRef(rtdb, `betsFeed/${undoState.feedKey}`)); }catch(_){ } }
    alert("Aposta desfeita e CCIP devolvidos.");
  }catch(err){
    console.error("undo bet:", err);
    alert(err?.message || "Não foi possível desfazer.");
  }finally{
    if(undoState?.timer) clearInterval(undoState.timer);
    undoState = null; hideUndoBar();
  }
}
function startUndoCountdown(){
  if(!undoState) return;
  const tick = ()=> {
    if(!undoState) return;
    const left = Math.max(0, Math.ceil((undoState.until - Date.now())/1000));
    $("#bet-undo-count") && ($("#bet-undo-count").textContent = `${left}s`);
    if(left <= 0){
      if(undoState?.timer) clearInterval(undoState.timer);
      undoState = null; hideUndoBar();
    }
  };
  tick();
  undoState.timer = setInterval(tick, 200);
}

/* ===== Submit Aposta ===== */
function bindBetForm(){
  $("#bet-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();

    const submitBtn = e.target.querySelector('[type="submit"]');
    if(submitBtn) submitBtn.disabled = true;

    try{
      if(!state.user) return alert("Entre com Google para apostar.");
      if(state.wallet < BET_COST) return alert("Saldo insuficiente."); // reforço front

      const matchId = $("#bet-match").value;
      const pick = $("#bet-pick").value;
      if(!matchId || !pick) return;

      const match = state.matches.find(m=>m.id===matchId);
      if(!match) return alert("Partida inválida.");

      const d = parseLocalDate(match.date);
      if(d && d.getTime() <= Date.now()) return alert("Apostas só antes do horário da partida.");

      const { probPct, payout } = payoutForPick(match, pick);
      const betDocId = `bet_${state.user.uid}_${matchId}`;
      const feedKey = betDocId;

      await runTransaction(db, async (tx)=>{
        const walRef = doc(db,C_WALLETS,state.user.uid);
        const betRef = doc(db,C_BETS, betDocId);
        const [betExisting, walSnap] = await Promise.all([tx.get(betRef), tx.get(walRef)]);
        if(betExisting.exists()) throw new Error("Você já apostou nesta partida.");

        let curPts = MIN_SEED_POINTS;
        if(walSnap.exists()){
          curPts = _coercePoints(walSnap.data().points);
        }else{
          tx.set(walRef, { points: curPts, email: state.user.email||null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge:true });
        }
        if(curPts < BET_COST) throw new Error("Saldo insuficiente para apostar.");

        tx.set(betRef, {
          uid: state.user.uid, matchId, pick,
          stake: BET_COST, pickProb: probPct, payoutPoints: payout,
          createdAt: serverTimestamp(), status: "pendente", tournament: state.tournamentId||1
        });
        tx.update(walRef, { points: curPts - BET_COST, updatedAt: serverTimestamp() });
      });

      // Feed (RTDB)
      let profile = null;
      try{
        const ps = await getDoc(doc(db,"profiles", state.user.uid));
        if(ps.exists()) profile = ps.data();
      }catch(_){}
      const fullName = profile?.displayName || state.user.displayName || state.user.email || "Usuário";
      const userId = deriveUserId({ profile, email: state.user.email, uid: state.user.uid });

      const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
      await rtdbSet(rtdbRef(rtdb, `betsFeed/${feedKey}`), {
        uid: state.user.uid,
        email: state.user.email || "",
        name: fullName,
        userId,
        matchId,
        aName: mapP[match.aId]||"?",
        bName: mapP[match.bId]||"?",
        stage: match.stage || "groups",
        group: match.group || null,
        pick,
        payout,
        stake: BET_COST,
        ts: Date.now()
      });

      undoState = { id: betDocId, matchId, stake: BET_COST, refund: BET_COST, until: Date.now() + UNDO_WINDOW_MS, timer: null, feedKey };
      showUndoBar(`Aposta registrada em <b>${mapP[match.aId]||"?"} × ${mapP[match.bId]||"?"}</b>. Você pode <b>desfazer</b> em até 5s.`);
      startUndoCountdown();

      updateBetFormEnabled();
      e.target.reset(); updateOddsHint();
    }catch(err){
      console.error("bet add", err);
      alert(err?.message || "Erro ao registrar aposta. Verifique regras/permissões.");
    }finally{
      if(submitBtn) submitBtn.disabled = false;
    }
  });
}
async function settleBetsIfFinished(){
  if(!state.user) return;
  const write = writeBatch(db);
  let changed = false;
  for(const b of state.bets){
    if(b.status && b.status!=="pendente") continue;
    const m = state.matches.find(x=>x.id===b.matchId);
    if(!m || !m.result || m.result==="postponed") continue;
    const ok = (b.pick==="draw" && m.result==="draw") || (b.pick==="A" && m.result==="A") || (b.pick==="B" && m.result==="B");
    const credit = ok ? Math.max(2, Number.isFinite(b.payoutPoints)? b.payoutPoints : 2) : 0;
    write.update(doc(db,C_BETS,b.id), { status: ok?"ganhou":"perdeu", settledAt: serverTimestamp(), settledPayout: credit });
    if(ok){
      write.set(doc(db,C_WALLETS,state.user.uid), { points: increment(credit), updatedAt: serverTimestamp() }, { merge:true });
    }
    changed = true;
  }
  if(changed) await write.commit();
}

/* ==================== Feed RTDB (Apostas Recentes) ==================== */
function ensureBetsFeedUI(){
  if($("#bets-feed")) return;
  const apSec = $("#apostas"); if(!apSec) return;
  const card = document.createElement("div");
  card.className = "card"; card.id = "bets-feed";
  card.innerHTML = `
    <h2>Apostas recentes (tempo real)</h2>
    <div class="table">
      <table>
        <thead>
          <tr>
            <th>Usuário</th>
            <th>Partida</th>
            <th>Etapa</th>
            <th>Palpite</th>
            <th>Data/Hora</th>
            <th>Status</th>
            <th>Retorno</th>
          </tr>
        </thead>
        <tbody id="bets-feed-tbody">
          <tr><td class="muted" colspan="7">Sem apostas no feed.</td></tr>
        </tbody>
      </table>
    </div>
  `;
  apSec.appendChild(card);
}
function feedRowStatusAndReturn(v){
  const m = state.matches.find(x=>x.id===v.matchId);
  if(!m || !m.result) return { status:"Pendente", retorno:(v.payout??"-")+" CCIP" };
  if(m.result==="postponed") return { status:"Adiada", retorno:"-" };
  const won = (v.pick==="draw" && m.result==="draw") || (v.pick==="A" && m.result==="A") || (v.pick==="B" && m.result==="B");
  return { status: won?"Ganhou":"Perdeu", retorno: won?(v.payout+" CCIP"):"-" };
}
function addFeedRow(key, v){
  const tbody = $("#bets-feed-tbody"); if(!tbody) return;
  const ph = tbody.querySelector(".muted"); if(ph) ph.closest("tr")?.remove();

  const when = new Date(v.ts||Date.now());
  const { status, retorno } = feedRowStatusAndReturn(v);
  const etapa = v.stage==="groups" ? `F. Grupos${v.group?` ${v.group}`:""}` : stageLabel(v.stage);

  const userId = v.userId || (v.email ? v.email.split("@")[0] : (v.uid ? String(v.uid).slice(0,6) : "—"));

  const tr = document.createElement("tr");
  tr.id = `betfeed-${key}`;
  tr.innerHTML = `
    <td title="${esc(v.name||userId)}">${esc(userId)}</td>
    <td>${esc(v.aName||"?")} × ${esc(v.bName||"?")}</td>
    <td>${esc(etapa)}</td>
    <td>${v.pick==="A"?"Vitória A": v.pick==="B"?"Vitória B":"Empate"}</td>
    <td>${fmtLocalDateStr(when)}</td>
    <td>${esc(status)}</td>
    <td>${esc(retorno)}</td>
  `;
  tbody.prepend(tr);
  state.feedRowsData[key] = v;
}
function updateFeedRow(key){
  const v = state.feedRowsData[key]; if(!v) return;
  const tr = $(`#betfeed-${key}`); if(!tr) return;
  const { status, retorno } = feedRowStatusAndReturn(v);
  const tds = tr.querySelectorAll("td");
  if(tds.length>=7){ tds[5].textContent = status; tds[6].textContent = retorno; }
}
function updateFeedStatuses(){ Object.keys(state.feedRowsData).forEach(updateFeedRow); }

async function verifyFeedBetExists(key, v){
  try{
    const snap = await getDoc(doc(db,C_BETS, key));
    if(!snap.exists() || (v?.uid && snap.data()?.uid !== v.uid)){
      await rtdbRemove(rtdbRef(rtdb, `betsFeed/${key}`));
      delete state.feedRowsData[key];
    }
  }catch(err){
    console.warn("verifyFeedBetExists:", err?.message);
  }
}
function listenBetsFeed(){
  ensureBetsFeedUI();
  const tbody = $("#bets-feed-tbody");
  if(state.listeners.betsFeed) state.listeners.betsFeed();
  const ref = rtdbRef(rtdb, "betsFeed");

  state.listeners.betsFeed = onChildAdded(ref, async (snap)=> {
    const key = snap.key; const v = snap.val();
    addFeedRow(key, v);
    await verifyFeedBetExists(key, v);
  });
  onChildRemoved(ref, (snap)=> {
    const key = snap.key;
    delete state.feedRowsData[key];
    $(`#betfeed-${key}`)?.remove();
    if(!tbody.querySelector("tr")) {
      tbody.innerHTML = `<tr><td class="muted" colspan="7">Sem apostas no feed.</td></tr>`;
    }
  });
}

/* ==================== Rankings ==================== */
function ensureRankingsUI(){
  if($("#rankings-card")) return;
  const apSec = $("#apostas"); if(!apSec) return;
  const card = document.createElement("div");
  card.className = "card"; card.id = "rankings-card";
  card.innerHTML = `
    <h2>Rankings (Top 10)</h2>
    <div class="row" style="gap:8px;align-items:center">
      <label style="font-weight:600">Mostrar:</label>
      <select id="rk-filter" style="padding:8px 10px;border:1px solid #D1D5DB;border-radius:10px;background:#F9FAFB;outline:none">
        <option value="best">Melhor Apostador (ganhas)</option>
        <option value="points">Mais CCIP</option>
        <option value="bets">Mais Apostas</option>
      </select>
    </div>
    <div class="table" style="margin-top:8px">
      <table>
        <thead id="rk-head"></thead>
        <tbody id="rk-body"></tbody>
      </table>
    </div>
    <p class="muted" id="rk-footnote" style="margin-top:6px"></p>
  `;
  apSec.appendChild(card);
  $("#rk-filter").addEventListener("change", renderRankingsTable);
}
async function rebuildRankings(){
  ensureRankingsUI();
  const [betsSnap, walletsSnap, profilesSnap] = await Promise.all([
    getDocs(collection(db,C_BETS)),
    getDocs(collection(db,C_WALLETS)),
    getDocs(collection(db,"profiles")).catch(()=>({forEach:()=>{}}))
  ]);

  const profilesMap = {}; profilesSnap.forEach(d=> profilesMap[d.id] = d.data());
  const walletsMap = {};  walletsSnap.forEach(d=> walletsMap[d.id] = d.data());

  const byUser = {};
  betsSnap.forEach(d=>{
    const b = d.data(); const uid = b.uid; if(!uid) return;
    if(!byUser[uid]) byUser[uid] = { total:0, wins:0 };
    byUser[uid].total++;
    const m = state.matches.find(x=>x.id===b.matchId);
    if(m && m.result && m.result!=="postponed"){
      const ok = (b.pick==="draw" && m.result==="draw") || (b.pick==="A" && m.result==="A") || (b.pick==="B" && m.result==="B");
      if(ok) byUser[uid].wins++;
    }
  });

  const bestByWins = Object.entries(byUser)
    .map(([uid,v])=> ({ uid, wins:v.wins, total:v.total, rate: v.total? v.wins/v.total : 0 }))
    .sort((a,b)=> (b.wins - a.wins) || (b.rate - a.rate) || (b.total - a.total))
    .slice(0,10);

  const mostPoints = Object.entries(walletsMap)
    .map(([uid,w])=> {
      const p = _coercePoints(w.points);
      return { uid, pts: p, email: w.email||profilesMap[uid]?.email||"" };
    })
    .sort((a,b)=> b.pts - a.pts)
    .slice(0,10);

  const mostBets = Object.entries(byUser)
    .map(([uid,v])=>({ uid, total:v.total }))
    .sort((a,b)=> b.total - a.total)
    .slice(0,10);

  state.rankings = { bestByWins, mostPoints, mostBets, profilesMap, walletsMap };
  renderRankingsTable();
}
function niceName(uid, profilesMap, walletsMap){
  const p = profilesMap[uid];
  if(p?.displayName) return p.displayName;
  const w = walletsMap[uid];
  return (p?.email || w?.email || uid)?.split("@")[0] || uid.slice(0,6);
}
function renderRankingsTable(){
  const head = $("#rk-head");
  const body = $("#rk-body");
  const note = $("#rk-footnote");
  if(!head || !body) return;
  const mode = $("#rk-filter")?.value || "best";
  const { profilesMap, walletsMap } = state.rankings;

  if(mode==="best"){
    head.innerHTML = `<tr><th>Nome</th><th>E-mail</th><th>Usuário</th><th>Apostas Ganhas</th><th>Total</th><th>Taxa</th></tr>`;
    body.innerHTML = state.rankings.bestByWins.map(r=>{
      const email = profilesMap[r.uid]?.email || walletsMap[r.uid]?.email || "—";
      const display = profilesMap[r.uid]?.displayName || niceName(r.uid, profilesMap, walletsMap);
      const username = deriveUserIdFromMaps(r.uid, profilesMap, walletsMap);
      return `<tr>
        <td>${esc(display)}</td>
        <td>${esc(email)}</td>
        <td>${esc(username)}</td>
        <td>${r.wins}</td>
        <td>${r.total}</td>
        <td>${Math.round(r.rate*100)}%</td>
      </tr>`;
    }).join("") || `<tr><td class="muted" colspan="6">Sem dados.</td></tr>`;
    note.textContent = "Critério: maior número de apostas ganhas (desempate por taxa de acerto e total de apostas).";
  }else if(mode==="points"){
    head.innerHTML = `<tr><th>Nome</th><th>E-mail</th><th>Usuário</th><th>CCIP</th></tr>`;
    body.innerHTML = state.rankings.mostPoints.map(r=>{
      const email = r.email || profilesMap[r.uid]?.email || "—";
      const display = profilesMap[r.uid]?.displayName || niceName(r.uid, profilesMap, walletsMap);
      const username = deriveUserIdFromMaps(r.uid, profilesMap, walletsMap);
      return `<tr>
        <td>${esc(display)}</td>
        <td>${esc(email)}</td>
        <td>${esc(username)}</td>
        <td>${r.pts}</td>
      </tr>`;
    }).join("") || `<tr><td class="muted" colspan="4">Sem dados.</td></tr>`;
    note.textContent = "Saldo atual de CCIP.";
  }else{
    head.innerHTML = `<tr><th>Nome</th><th>E-mail</th><th>Usuário</th><th>Apostas</th></tr>`;
    body.innerHTML = state.rankings.mostBets.map(r=>{
      const email = profilesMap[r.uid]?.email || walletsMap[r.uid]?.email || "—";
      const display = profilesMap[r.uid]?.displayName || niceName(r.uid, profilesMap, walletsMap);
      const username = deriveUserIdFromMaps(r.uid, profilesMap, walletsMap);
      return `<tr>
        <td>${esc(display)}</td>
        <td>${esc(email)}</td>
        <td>${esc(username)}</td>
        <td>${r.total}</td>
      </tr>`;
    }).join("") || `<tr><td class="muted" colspan="4">Sem dados.</td></tr>`;
    note.textContent = "Quantidade total de apostas realizadas.";
  }
}

/* ==================== Semis / Comunicados / Campeões ==================== */
async function autoCreateSemisIfDone(){
  const groupsDone = ["A","B"].every(g=>{
    const ms = state.matches.filter(m=>m.stage==="groups" && m.group===g);
    if(!ms.length) return false;
    return ms.every(m=> !!m.result);
  });
  if(!groupsDone) return;
  if(state.matches.some(m=> m.stage==="semifinal")) return;

  const rank = g=>{
    return state.players.filter(p=>p.group===g).map(p=>{
      const s = computePlayerStats(p.id);
      return { id:p.id, name:p.name, ...s };
    }).sort((a,b)=> (b.points-a.points) || (b.wins-a.wins) || a.name.localeCompare(b.name))
      .slice(0,2).map(x=>x.id);
  };
  const [a1,a2]=rank("A"); const [b1,b2]=rank("B");
  if(!(a1&&a2&&b1&&b2)) return;

  await addDoc(collection(db,"matches"), { aId:a1, bId:b2, stage:"semifinal", group:null, code:"SF1", result:null, date:null, createdAt: serverTimestamp() });
  await addDoc(collection(db,"matches"), { aId:b1, bId:a2, stage:"semifinal", group:null, code:"SF2", result:null, date:null, createdAt: serverTimestamp() });

  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  await addDoc(collection(db,"posts"), {
    title: "Semifinais definidas",
    body: `Semifinal 1 (SF1): ${mapP[a1]} × ${mapP[b2]}\nSemifinal 2 (SF2): ${mapP[b1]} × ${mapP[a2]}`,
    createdAt: serverTimestamp(),
    authorName: "Sistema",
    authorEmail: "sistema@champions"
  });
}
async function generateResultPostsForFinished(){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const existing = {};
  state.posts.forEach(p=> { if(p.matchId && (p.type==="result" || !p.type)) existing[p.matchId] = true; });

  let created = 0;
  for(const m of state.matches){
    if(!m.result || m.result==="postponed") continue;
    if(existing[m.id]) continue;
    const when = fmtLocalDateStr(m.date||null);
    const etapa = m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}` : stageLabel(m.stage);
    const title = (m.result==="draw") ? `Empate: ${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}`
                                     : `Vitória de ${(m.result==="A"?mapP[m.aId]:mapP[m.bId])||"?"}`;
    const body = [
      `Etapa: ${etapa}${m.code?` • Código: ${m.code}`:""}`,
      `Data/Hora: ${when}`,
      `Confronto: ${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}`
    ].join("\n");
    await addDoc(collection(db,"posts"), {
      title, body, type: "result", matchId: m.id,
      createdAt: serverTimestamp(),
      authorUid: state.user?.uid||null, authorEmail: state.user?.email||null, authorName: state.user?.displayName||"Admin"
    });
    created++;
  }
  alert(created ? `Publicados ${created} comunicado(s) de resultados.` : "Nenhum comunicado pendente de resultado.");
}
async function autoPostponeOverdue(){
  const now = Date.now();
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  for(const m of state.matches){
    if(m.result) continue;
    if(!m.date) continue;
    const d = parseLocalDate(m.date);
    if(!d) continue;
    if((now - d.getTime()) < ONE_DAY_MS) continue;

    await updateDoc(doc(db,"matches",m.id), { result:"postponed", updatedAt: serverTimestamp() });

    const has = state.posts.some(p=> p.matchId===m.id && p.type==="postponed");
    if(!has){
      await addDoc(collection(db,"posts"), {
        title: "Partida adiada",
        body: `Etapa: ${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}`: stageLabel(m.stage)}${m.code?` • Código: ${m.code}`:""}
Data/Hora original: ${fmtLocalDateStr(m.date)}
Confronto: ${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}
Motivo: expiração de 24h sem resultado registrado.`,
        type: "postponed",
        matchId: m.id,
        createdAt: serverTimestamp(),
        authorName: "Sistema",
        authorEmail: "sistema@champions"
      });
    }
  }
}
async function ensureChampionRecorded(){
  try{
    const finals = state.matches.filter(m=> m.stage==="final" && (m.result==="A" || m.result==="B"));
    if(!finals.length) return;
    const m = finals[0];
    const existing = await getDocs(query(collection(db,"winners"), where("tournament","==", state.tournamentId), limit(1)));
    if(!existing.empty) return;

    const champ = m.result==="A" ? m.aId : m.bId;
    const vice  = m.result==="A" ? m.bId : m.aId;

    const campaign = state.matches
      .filter(x=> x.aId===champ || x.bId===champ)
      .map(x=> ({ aId:x.aId, bId:x.bId, stage: x.stage==="groups" ? `F. Grupos${x.group?` ${x.group}`:""}` : stageLabel(x.stage), date:x.date||null, code:x.code||null, result:x.result||null }));

    await addDoc(collection(db,"winners"), {
      tournament: state.tournamentId, champion: champ, runnerUp: vice, campaign, createdAt: serverTimestamp()
    });
  }catch(err){ console.warn("ensureChampionRecorded (ignorado):", err?.message); }
}

/* ==================== Ferramentas Admin ==================== */
function organizeAdminTools(){
  if(!state.admin) return;
  const adminView = $("#admin"); if(!adminView) return;

  const toolsCard = Array.from(adminView.querySelectorAll(".card")).find(c => /Ferramentas/i.test(c.textContent || ""));
  if(!toolsCard) return;

  let panel = toolsCard.querySelector("#admin-tools-panel");
  if(!panel){
    panel = document.createElement("div");
    panel.id = "admin-tools-panel";
    panel.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;";
    toolsCard.appendChild(panel);
  }else{ panel.innerHTML = ""; }

  const mkBtn = (id, text, cls="btn", onClick=()=>{})=>{
    const b = document.createElement("button");
    b.id = id; b.className = cls; b.textContent = text; b.addEventListener("click", onClick);
    return b;
  };

  const btnPublishResults = mkBtn("btn-publish-results", "Publicar resultados (pendentes)", "btn", generateResultPostsForFinished);
  const btnPublishPostponed = mkBtn("btn-publish-postponed", "Publicar adiamentos (pendentes)", "btn ghost", generatePostponedPostsForOverdue);
  const btnDeletePosts = mkBtn("btn-delete-all-posts", "Apagar TODOS os comunicados", "btn danger", async ()=>{
    if(!confirm("Apagar TODOS os comunicados?")) return;
    const qs = await getDocs(collection(db,"posts"));
    const b = writeBatch(db); qs.forEach(d=> b.delete(d.ref)); await b.commit();
    alert("Todos os comunicados foram apagados.");
  });
  const btnResetWallets = mkBtn("btn-reset-wallets", "Resetar saldos (todos)", "btn danger", async ()=>{
    if(!confirm("Resetar saldos de todos para 6 CCIP?")) return;
    const qs = await getDocs(collection(db,C_WALLETS));
    const b = writeBatch(db); qs.forEach(d=> b.set(d.ref, { points: MIN_SEED_POINTS, updatedAt: serverTimestamp() }, { merge:true }));
    await b.commit(); alert("Saldos resetados.");
  });
  const btnResetBets = mkBtn("btn-reset-bets", "Resetar apostas e ranking", "btn danger", async ()=>{
    if(!confirm("Apagar TODAS as apostas e limpar feed?")) return;
    const qs = await getDocs(collection(db,C_BETS));
    const b = writeBatch(db); qs.forEach(d=> b.delete(d.ref)); await b.commit();
    try { await rtdbRemove(rtdbRef(rtdb,"betsFeed")); } catch(_){}
    alert("Apostas e feed foram resetados."); rebuildRankings();
  });
  const btnResetAll = mkBtn("btn-reset-all", "Resetar Torneio (TUDO)", "btn danger", async ()=>{
    if(!confirm("Isto vai APAGAR partidas, apostas, comunicados, limpar feed de apostas e resetar saldos. Continuar?")) return;

    // captura edição atual e calcula próxima
    let nextEdition = (state.tournamentId||1) + 1;
    try{
      const st = await getDoc(doc(db,C_SETTINGS,"global"));
      const cur = st.exists() ? Number(st.data()?.tournamentId||state.tournamentId||1) : (state.tournamentId||1);
      nextEdition = cur + 1;
    }catch(_){}

    const b = writeBatch(db);
    (await getDocs(collection(db,"matches"))).forEach(d=> b.delete(d.ref));
    (await getDocs(collection(db,"posts"))).forEach(d=> b.delete(d.ref));
    (await getDocs(collection(db,C_BETS))).forEach(d=> b.delete(d.ref));
    (await getDocs(collection(db,C_WALLETS))).forEach(d=> b.set(d.ref, { points: MIN_SEED_POINTS, updatedAt: serverTimestamp() }, { merge:true }));
    await b.commit();
    try { await rtdbRemove(rtdbRef(rtdb,"betsFeed")); } catch(_){}

    // atualiza edição do torneio
    try{
      await setDoc(doc(db,C_SETTINGS,"global"), { tournamentId: nextEdition, updatedAt: serverTimestamp() }, { merge:true });
      state.tournamentId = nextEdition;
      ensureTournamentBadge();
    }catch(err){
      console.warn("Falha ao salvar edição do torneio:", err?.message);
    }

    alert(`Torneio resetado. Nova edição: #${nextEdition}.`);
    rebuildRankings();
    renderHome();
  });

  [btnPublishResults, btnPublishPostponed, btnDeletePosts, btnResetWallets, btnResetBets, btnResetAll]
    .forEach(x=> panel.appendChild(x));
}
async function generatePostponedPostsForOverdue(){
  if(!state.admin) return alert("Apenas admin.");
  let created = 0;
  const now = Date.now();
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  for(const m of state.matches){
    if(m.result) continue;
    if(!m.date) continue;
    const d = parseLocalDate(m.date);
    if(!d || (now - d.getTime()) < ONE_DAY_MS) continue;

    await updateDoc(doc(db,"matches",m.id), { result:"postponed", updatedAt: serverTimestamp() });

    const has = state.posts.some(p=> p.matchId===m.id && p.type==="postponed");
    if(!has){
      await addDoc(collection(db,"posts"), {
        title: "Partida adiada",
        body: `Etapa: ${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}`: stageLabel(m.stage)}${m.code?` • Código: ${m.code}`:""}
Data/Hora original: ${fmtLocalDateStr(m.date)}
Confronto: ${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}
Motivo: expiração de 24h sem resultado registrado.`,
        type: "postponed",
        matchId: m.id,
        createdAt: serverTimestamp(),
        authorName: "Sistema",
        authorEmail: "sistema@champions"
      });
      created++;
    }
  }
  alert(created ? `Publicados ${created} comunicado(s) de adiamento.` : "Nenhum adiamento pendente.");
}

/* ==================== Winners (leitura) ==================== */
function ensureWinnersTab(){
  if($("#vencedores")) return;
  const navCenter = document.querySelector(".nav-center");
  if(navCenter && !navCenter.querySelector('[data-tab="vencedores"]')){
    const btn = document.createElement("button");
    btn.className = "tab"; btn.dataset.tab = "vencedores"; btn.textContent = "Vencedores";
    btn.addEventListener("click", ()=> showTab("vencedores")); navCenter.appendChild(btn);
  }
  const main = document.querySelector("main.container");
  const sec = document.createElement("section");
  sec.id = "vencedores"; sec.className = "view";
  sec.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <h2 style="margin:0">Campeões</h2>
        <span class="badge-small">Edição atual: #<span id="winners-cur-ed">${state.tournamentId}</span></span>
      </div>
      <div id="winners-views" style="margin-top:10px">
        <div id="winners-by-tournament">
          <div class="table">
            <table>
              <thead><tr><th>Edição</th><th>Campeão</th><th>Vice</th><th>Ver campanha</th></tr></thead>
              <tbody id="winners-body"><tr><td class="muted" colspan="4">Sem registros.</td></tr></tbody>
            </table>
          </div>
        </div>
        <div id="winners-rank" style="display:none">
          <div class="table">
            <table>
              <thead><tr><th>Jogador</th><th>Títulos</th></tr></thead>
              <tbody id="winners-rank-body"><tr><td class="muted" colspan="2">Sem registros.</td></tr></tbody>
            </table>
          </div>
        </div>
        <div style="margin-top:8px">
          <select id="winners-filter" style="padding:8px 10px;border:1px solid #D1D5DB;border-radius:10px;background:#F9FAFB;outline:none">
            <option value="byTournament">Por Torneio</option>
            <option value="rankChampions">Ranking de Campeões</option>
          </select>
        </div>
      </div>
    </div>
  `;
  main?.appendChild(sec);
  $("#winners-filter")?.addEventListener("change", ()=>{
    const v = $("#winners-filter").value;
    $("#winners-by-tournament").style.display = (v==="byTournament") ? "block" : "none";
    $("#winners-rank").style.display       = (v==="rankChampions") ? "block" : "none";
  });
}
function listenWinners(){
  ensureWinnersTab();
  try{
    onSnapshot(query(collection(db,"winners"), orderBy("tournament","desc")), (qs)=>{
      state.winners = qs.docs.map(d=>({id:d.id, ...d.data()}));
      renderWinners(); renderWinnersRank();
      const ed = $("#winners-cur-ed"); if(ed) ed.textContent = String(state.tournamentId);
    }, (_e)=>{ /* ignorar erros */ });
  }catch(_){}
}
function renderWinners(){
  const tbody = $("#winners-body"); if(!tbody) return;
  if(!state.winners.length){ tbody.innerHTML = `<tr><td class="muted" colspan="4">Sem registros.</td></tr>`; return; }
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  tbody.innerHTML = state.winners.map(w=>{
    const champ = mapP[w.champion]||"—";
    const vice  = mapP[w.runnerUp]||"—";
    return `<tr>
      <td>#${w.tournament}</td>
      <td>${champ}</td>
      <td>${vice}</td>
      <td><button class="btn small" data-campaign="${w.id}">Ver campanha</button></td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("button[data-campaign]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-campaign");
      const w = state.winners.find(x=>x.id===id);
      if(!w){ alert("Registro não encontrado."); return; }
      showCampaignModal(w);
    });
  });
}
function renderWinnersRank(){
  const tbody = $("#winners-rank-body"); if(!tbody) return;
  if(!state.winners.length){ tbody.innerHTML = `<tr><td class="muted" colspan="2">Sem registros.</td></tr>`; return; }
  const tally = {}; state.winners.forEach(w=> { tally[w.champion] = (tally[w.champion]||0)+1; });
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const rows = Object.entries(tally).map(([pid, n])=>({ name: mapP[pid]||pid, n }))
    .sort((a,b)=> b.n - a.n).slice(0, 20)
    .map(r=> `<tr><td>${r.name}</td><td>${r.n}</td></tr>`).join("");
  tbody.innerHTML = rows || `<tr><td class="muted" colspan="2">Sem registros.</td></tr>`;
}
function showCampaignModal(w){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const rows = (w.campaign||[]).map(c=>{
    return `<tr>
      <td>${c.stage}</td>
      <td>${fmtLocalDateStr(c.date)}</td>
      <td>${mapP[c.aId]||"?"} × ${mapP[c.bId]||"?"}</td>
      <td>${c.result==="A"?mapP[c.aId] : c.result==="B"? mapP[c.bId] : c.result==="draw" ? "Empate" : c.result}</td>
      <td>${c.code||"—"}</td>
    </tr>`;
  }).join("") || `<tr><td class="muted" colspan="5">Sem dados.</td></tr>`;

  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999;";
  modal.innerHTML = `
    <div style="background:#fff;max-width:780px;width:100%;border-radius:12px;padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h3 style="margin:0">Campanha do Campeão — Edição #${w.tournament}</h3>
        <button id="camp-close" class="btn ghost small">Fechar</button>
      </div>
      <div class="table" style="margin-top:8px;max-height:60vh;overflow:auto">
        <table>
          <thead><tr><th>Etapa</th><th>Data/Hora</th><th>Partida</th><th>Resultado</th><th>Código</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector("#camp-close")?.addEventListener("click", ()=> modal.remove());
}

/* ==================== Player de Música ==================== */
function ensureMusicPlayerUI(){
  if(state.audioUI) return state.audioUI;

  // estilo
  const style = document.createElement("style");
  style.textContent = `
    .music-player{position:fixed;right:16px;bottom:16px;background:#111827;color:#F9FAFB;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:10px 12px;display:flex;align-items:center;gap:10px;z-index:9998}
    .mp-title{font-weight:700;font-size:12px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
    .mp-btn{appearance:none;border:none;outline:none;background:#1F2937;color:#F9FAFB;border-radius:10px;padding:8px 10px;cursor:pointer;font-weight:700}
    .mp-btn:hover{background:#374151}
    .mp-bar{height:6px;background:#374151;border-radius:999px;overflow:hidden;flex:1;min-width:120px}
    .mp-fill{height:100%;background:#60A5FA;width:0%}
    .mp-time{font-size:11px;opacity:.8;min-width:70px;text-align:right}
  `;
  document.head.appendChild(style);

  // container
  const box = document.createElement("div");
  box.className = "music-player";
  box.innerHTML = `
    <div class="mp-title">🎵 Joy Crookes - Feet Don't Fail Me Now</div>
    <button id="mp-play" class="mp-btn">▶︎</button>
    <button id="mp-fwd" class="mp-btn">+10s</button>
    <div class="mp-bar"><div id="mp-fill" class="mp-fill"></div></div>
    <div id="mp-time" class="mp-time">0:00 / 0:00</div>
  `;
  document.body.appendChild(box);

  // Áudio
  const audio = new Audio(TRACK_SRC);
  audio.loop = true;
  state.audio = audio;

  // eventos UI
  const btnPlay = box.querySelector("#mp-play");
  const btnFwd  = box.querySelector("#mp-fwd");
  const fill    = box.querySelector("#mp-fill");
  const timeEl  = box.querySelector("#mp-time");

  const fmt = (sec)=> {
    if(!Number.isFinite(sec)) return "0:00";
    const m = Math.floor(sec/60), s = Math.floor(sec%60);
    return `${m}:${s<10?"0":""}${s}`;
    };
  const sync = ()=>{
    const cur = audio.currentTime||0, dur = audio.duration||0;
    const pct = dur? Math.min(100,(cur/dur)*100):0;
    fill.style.width = `${pct}%`;
    timeEl.textContent = `${fmt(cur)} / ${fmt(dur)}`;
    btnPlay.textContent = audio.paused ? "▶︎" : "⏸";
  };
  audio.addEventListener("timeupdate", sync);
  audio.addEventListener("play", sync);
  audio.addEventListener("pause", sync);
  audio.addEventListener("loadedmetadata", sync);

  btnPlay.addEventListener("click", async ()=>{
    try{
      if(audio.paused){ await audio.play(); state.audioStarted = true; }
      else { audio.pause(); }
    }catch(err){
      console.warn("Autoplay bloqueado:", err?.message);
    }finally{ sync(); }
  });
  btnFwd.addEventListener("click", ()=>{
    try{
      audio.currentTime = Math.min((audio.currentTime||0)+10, (audio.duration||audio.currentTime||0));
    }catch(_){}
  });

  // tenta iniciar após primeira interação
  const tryStart = async ()=>{
    if(state.audioStarted) return;
    try{ await audio.play(); state.audioStarted = true; }
    catch(_){ /* usuário precisa clicar */ }
    finally{ sync(); document.removeEventListener("click", tryStart, true); }
  };
  document.addEventListener("click", tryStart, true);

  state.audioUI = box;
  return box;
}

/* ==================== Auth listeners ==================== */
function bindAuthButtons(){
  $("#btn-open-login")?.addEventListener("click", loginGoogle);
  $("#btn-logout")?.addEventListener("click", logout);
}

onAuthStateChanged(auth, async (user)=>{
  state.user = user || null;

  listenAdmin(user);
  if(user){
    await ensureWalletInit(user.uid);
    await loadProfileIntoState(user.uid);
  }
  updateAuthUI();
  fillProfile();

  listenBets();
  listenWallet(user?.uid||null);
  listenBetsFeed();
  ensureWinnersTab();
  listenWinners();
  rebuildRankings();
});

/* ==================== Init ==================== */
function init(){
  bindAuthButtons();
  initTabs();
  listenSettings();          // Edição do torneio
  ensureTournamentBadge();   // badge inicial
  ensureMusicPlayerUI();     // player de música

  listenPlayers();
  listenMatches();
  listenPosts();
  initChat();
  bindPostForm();
  bindMatchForm();
  bindProfileForm();
  bindBetForm();

  const rk = $("#rk-filter"); if(rk) rk.style.cssText = "padding:8px 10px;border:1px solid #D1D5DB;border-radius:10px;background:#F9FAFB;outline:none";

  renderWalletCard();
  if(!_bootShown){ _bootShown = true; showTab("home"); }
}
init();
