// app.js (completo, com odds em tempo real, feed RTDB completo, undo fix, rankings, resets)
// Firebase v12 (modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, orderBy, serverTimestamp, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
  getDatabase, ref as rtdbRef, set as rtdbSet, onChildAdded, onChildRemoved, remove as rtdbRemove, get as rtdbGet
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

/* ==================== Helpers DOM ==================== */
const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmt2 = n => (n < 10 ? `0${n}` : `${n}`);

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
  const d = parseLocalDate(val);
  if(!d) return "—";
  return `${fmt2(d.getDate())}/${fmt2(d.getMonth()+1)}/${d.getFullYear()} ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function fmtTime(val){
  const d = parseLocalDate(val);
  if(!d) return "—";
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
const clamp01 = x => Math.max(0, Math.min(1, x));
const clampPct = x => Math.max(0, Math.min(100, x));

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

// Admins fixos (opcional)
const ADMIN_EMAILS = [
  // "seu.email@ifma.edu.br",
];

// Apostas
const BET_COST   = 2;
const MIN_SEED_POINTS = 6;
const ONE_DAY_MS = 24*60*60*1000;
const UNDO_WINDOW_MS = 5000;

/* ==================== Estado ==================== */
const state = {
  user: null,
  admin: false,
  players: [],
  matches: [],
  posts: [],
  bets: [],
  wallet: 0,
  listeners: {
    players:null, matches:null, posts:null, bets:null, wallet:null, chat:null, admin:null, betsFeed:null,
    rankBets:null, rankWallets:null, rankUsers:null
  },
  feedRows: {},         // chaves no feed
  feedRowsData: {},     // key -> { ...dados do feed }
};

let _bootShown = false;
let _autoPostponeLock = false;

// Undo state
let undoState = null; // { id, matchId, stake, refund, until, timer, feedKey }

/* ==================== Abas ==================== */
function showTab(tab){
  $$(".view").forEach(v=>v.classList.remove("visible"));
  $$(".tab").forEach(b=>b.classList.remove("active"));
  const el = $(`#${tab}`);
  if(el) el.classList.add("visible");
  const btn = $(`.tab[data-tab="${tab}"]`);
  if(btn) btn.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function initTabs(){
  $$(".tab").forEach(btn=>{
    btn.addEventListener("click", ()=> showTab(btn.dataset.tab));
  });
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener("click", (e)=>{
      const id = a.getAttribute("href").slice(1);
      if($(`#${id}`)){
        e.preventDefault();
        showTab(id);
      }
    });
  });
  $("#user-chip")?.addEventListener("click", ()=> showTab("perfil"));
}

/* ==================== Auth ==================== */
async function loginGoogle(){
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}
async function logout(){
  await signOut(auth);
}
async function ensureAdminBootstrap(user){
  if(!user) return;
  try{
    const qs = await getDocs(collection(db,"admins"));
    if(qs.empty){
      await setDoc(doc(db,"admins", user.uid), {
        isAdmin: true, active : true, bootstrap: true,
        email: user.email || null, name : user.displayName || null,
        createdAt: serverTimestamp()
      }, { merge:true });
    }
  }catch(e){ console.warn("ensureAdminBootstrap:", e); }
}
function applyAdminUI(){
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !state.admin));
  updateAuthUI();
  renderMatches();
  renderPosts();
  ensureAdminToolsButtons();
}
function listenAdmin(user){
  if(state.listeners.admin) state.listeners.admin();
  if(!user){ state.admin=false; applyAdminUI(); return; }
  const adminsRef = doc(db,"admins", user.uid);
  const refreshBy = async (docData) => {
    const byList = ADMIN_EMAILS.includes(user.email);
    const byDoc  = !!(docData && (docData.active === true || docData.isAdmin === true));
    let byClaim  = false;
    try { const tk = await user.getIdTokenResult(true); byClaim = !!tk.claims?.admin; } catch(_) {}
    state.admin = !!(byList || byDoc || byClaim);
    applyAdminUI();
  };
  state.listeners.admin = onSnapshot(adminsRef, (snap)=>{
    refreshBy(snap.exists() ? snap.data() : null);
  }, async (_err)=>{
    const tk = await user.getIdTokenResult(true).catch(()=>({claims:{}}));
    const byClaim = !!tk.claims?.admin;
    state.admin = ADMIN_EMAILS.includes(user.email) || byClaim;
    applyAdminUI();
  });
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
    if(email) email.textContent = state.user.displayName || state.user.email;
    btnLogin?.classList.add("hidden");
    btnOut?.classList.remove("hidden");
    if(state.admin){ adminBadge?.classList.remove("hidden"); tabAdmin?.classList.remove("hidden"); }
    else { adminBadge?.classList.add("hidden"); tabAdmin?.classList.add("hidden"); }
  }else{
    chip?.classList.add("hidden");
    btnLogin?.classList.remove("hidden");
    btnOut?.classList.add("hidden");
    adminBadge?.classList.add("hidden");
    tabAdmin?.classList.add("hidden");
  }

  const betForm = $("#bet-form");
  if(betForm){ betForm.querySelectorAll("input,select,button,textarea").forEach(i=> i.disabled = !state.user); }
}

/* ==================== Carteira ==================== */
async function ensureWalletInit(uid){
  if(!uid) return;
  const refWal = doc(db, "wallets", uid);
  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(refWal);
      if(!snap.exists()){
        tx.set(refWal, { points: MIN_SEED_POINTS, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
    });
  }catch(e){
    try{
      const snap = await getDoc(refWal);
      if(!snap.exists()){
        await setDoc(refWal, { points: MIN_SEED_POINTS, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
    }catch(err){ console.error("ensureWalletInit fallback:", err); }
  }
}
function listenWallet(uid){
  if(state.listeners.wallet) state.listeners.wallet();
  if(!uid){
    state.wallet = 0;
    $("#wallet-points") && ($("#wallet-points").textContent="0");
    return;
  }
  state.listeners.wallet = onSnapshot(doc(db,"wallets",uid),(snap)=>{
    const pts = (snap.exists() && typeof snap.data().points==="number") ? snap.data().points : 0;
    state.wallet = pts;
    $("#wallet-points") && ($("#wallet-points").textContent = String(state.wallet));
  });
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

  $("#chat-login-hint")?.classList.toggle("hidden", !!state.user);
}

/* ==================== Players ==================== */
function listenPlayers(){
  if(state.listeners.players) state.listeners.players();
  state.listeners.players = onSnapshot(query(collection(db,"players"), orderBy("name","asc")), (qs)=>{
    state.players = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderPlayers();
    renderPlayerSelects();
    renderTables();
    renderBetsSelect();
    renderHome();
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

  $$("#players .player-card").forEach(card=>{
    card.onclick = ()=> renderPlayerDetails(card.dataset.id);
  });
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

/* ==================== Standings ==================== */
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
function probVED(m){
  const sA = computePlayerStats(m.aId);
  const sB = computePlayerStats(m.bId);
  const wpA = (sA.wins + 1) / ((sA.wins + sA.losses) + 2);
  const wpB = (sB.wins + 1) / ((sB.wins + sB.losses) + 2);
  let baseA = wpA / (wpA + wpB);
  let baseB = 1 - baseA;
  let baseE = 0.15;

  const bets = state.bets.filter(b=> b.matchId===m.id);
  const tot = bets.length || 1;
  const shareA = bets.filter(b=>b.pick==="A").length / tot;
  const shareB = bets.filter(b=>b.pick==="B").length / tot;
  const shareE = bets.filter(b=>b.pick==="draw").length / tot;

  let pA = clamp01(0.55*baseA + 0.45*shareA);
  let pB = clamp01(0.55*baseB + 0.45*shareB);
  let pE = clamp01(0.30*baseE + 0.70*shareE*0.7);

  const s = pA+pB+pE || 1;
  pA/=s; pB/=s; pE/=s;

  return {
    A: Math.round(clampPct(pA*100)),
    E: Math.round(clampPct(pE*100)),
    D: Math.round(clampPct(pB*100))
  };
}
function payoutForPick(m, pick){
  const p = probVED(m);
  const probPct = pick==="A" ? p.A : pick==="B" ? p.D : p.E;
  let pr = probPct/100;
  if(pr <= 0) pr = 0.01;
  const dec = Math.max(1.5, Math.min(5.0, 0.9*(1/pr)));
  const payout = Math.max(2, Math.round(BET_COST * dec));
  return { probPct, payout };
}

/* ===== filtros partidas ===== */
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
  if(m.result === "A" || m.result === "B" || m.result === "draw") return "finished";
  return "pending";
}

function listenMatches(){
  if(state.listeners.matches) state.listeners.matches();
  state.listeners.matches = onSnapshot(query(collection(db,"matches"), orderBy("date","asc")), async (qs)=>{
    state.matches = qs.docs.map(d=>({id:d.id, ...d.data()}));
    buildOrMountStatusFilter();
    renderMatches();
    renderTables();
    renderBetsSelect();
    renderHome();

    if(!_autoPostponeLock){
      _autoPostponeLock = true;
      try { await autoPostponeOverdue(); } finally { _autoPostponeLock = false; }
    }

    autoCreateSemisIfDone();
    settleBetsIfFinished();     // minhas apostas
    updateFeedStatuses();       // atualiza status/retorno do feed RTDB conforme resultados
    rebuildRankings();          // ranking depende de resultados
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

  items = items.filter(m=>{
    if(statusFilter==="all") return true;
    return matchStatus(m) === statusFilter;
  });

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

  if(state.admin){
    $$(".btn-edit").forEach(b=>{
      b.onclick = ()=> loadMatchToForm(b.dataset.id);
    });
  }

  $("#filter-stage")?.addEventListener("change", renderMatches, { once:true });
}

/* ===== Form Partida ===== */
function bindMatchForm(){
  const form = $("#match-form");
  const resetBtn = $("#match-reset");
  const delBtn = $("#match-delete");
  const btnResetT = $("#btn-reset-tournament");

  form?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
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

      if(!id){
        await addDoc(collection(db,"matches"), { ...payload, createdAt: serverTimestamp() });
      }else{
        await updateDoc(doc(db,"matches",id), { ...payload, updatedAt: serverTimestamp() });
      }
      form.reset();
      $("#match-id").value="";
      $("#match-date-orig").value="";
    }catch(err){
      console.error("Salvar partida:", err);
      alert("Erro ao salvar partida. Verifique permissões.");
    }
  });

  resetBtn?.addEventListener("click", ()=> {
    form.reset(); $("#match-id").value=""; $("#match-date-orig").value="";
  });

  delBtn?.addEventListener("click", async ()=>{
    const id = $("#match-id").value;
    if(!id) return;
    if(!confirm("Excluir esta partida?")) return;
    await deleteDoc(doc(db,"matches",id));
    form.reset(); $("#match-id").value=""; $("#match-date-orig").value="";
  });

  btnResetT?.addEventListener("click", async ()=>{
    if(!confirm("Tem certeza que deseja RESETAR o torneio? Isso apaga partidas, posts e apostas.")) return;
    const b = writeBatch(db);
    (await getDocs(collection(db,"matches"))).forEach(d=> b.delete(d.ref));
    (await getDocs(collection(db,"posts"))).forEach(d=> b.delete(d.ref));
    (await getDocs(collection(db,"bets"))).forEach(d=> b.delete(d.ref));
    await b.commit();
    alert("Torneio resetado.");
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
    const yyyy = d.getFullYear(), mm=fmt2(d.getMonth()+1), dd=fmt2(d.getDate()), hh=fmt2(d.getHours()), mi=fmt2(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  })() : "";
  $("#match-date-orig").value = m.date || "";
  $("#admin-matches")?.scrollIntoView({ behavior:"smooth", block:"start" });
}

/* ==================== Home ==================== */
function renderHome(){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const pendingScheduled = state.matches
    .filter(m=> !m.result && !!m.date)
    .slice()
    .sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));

  const today=new Date(); const s=new Date(today); s.setHours(0,0,0,0); const e=new Date(today); e.setHours(23,59,59,999);
  const isSameDay=(d1,d2)=> d1.getFullYear()==d2.getFullYear()&&d1.getMonth()==d2.getMonth()&&d1.getDate()==d2.getDate();

  let pick = pendingScheduled.filter(m=>{const d=parseLocalDate(m.date);return d&&d>=s&&d<=e;});
  if(pick.length===0){
    let nextDay=null; 
    for(const m of pendingScheduled){ const d=parseLocalDate(m.date); if(d && d>e){ nextDay=d; break; } }
    if(nextDay){ pick=pendingScheduled.filter(m=>{const d=parseLocalDate(m.date); return d&&isSameDay(d,nextDay);}); }
  }
  pick=pick.slice(0,4);

  const stageText = (m)=>{
    if(m.stage==="groups") return `F. Grupos${m.group?` ${m.group}`:""}`;
    if(m.stage==="semifinal") return "Semifinal";
    if(m.stage==="final") return "Final";
    if(m.stage==="third") return "3º Lugar";
    return m.stage||"—";
  };

  const rows=pick.map(m=>`
    <tr>
      <td>${stageText(m)}</td>
      <td>${fmtTime(m.date)}</td>
      <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
    </tr>
  `).join("");

  const table=`
    <table>
      <thead><tr><th>Etapa</th><th>Hora</th><th>Partida</th></tr></thead>
      <tbody>${rows||"<tr><td colspan='3'>Sem partidas pendentes hoje/próximo dia.</td></tr>"}</tbody>
    </table>
    <div class="home-next-extra">
      <p><b>Como funciona:</b> exibimos até <b>4 partidas pendentes</b> do dia atual; se não houver, mostramos as pendentes do próximo dia agendado.</p>
      <p>Edite datas e resultados na aba <b>Partidas</b>. Adiamentos acontecem automaticamente 24h após o horário sem resultado.</p>
      <p>Na <b>Tabela</b>, a pontuação é válida somente para a <b>Fase de Grupos</b> (Vitória 3 · Empate 1 · Derrota 0).</p>
    </div>
  `;
  $("#home-next") && ($("#home-next").innerHTML=table);

  document.querySelectorAll('a[href="#players"]').forEach(a=>{
    a.addEventListener("click", (e)=>{ e.preventDefault(); showTab("players"); });
  });

  const posts = state.posts.slice(0,3).map(p=>renderPostItem(p)).join("");
  $("#home-posts") && ($("#home-posts").innerHTML = posts || `<p class="muted">Sem comunicados.</p>`);
  if(state.admin){
    $$("#home-posts .btn-del-post").forEach(b=>{
      b.onclick=async ()=>{ if(!confirm("Apagar este comunicado?"))return; await deleteDoc(doc(db,"posts",b.dataset.id)); };
    });
  }
}

/* ==================== Posts ==================== */
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

/* ==================== Apostas: UI Odds ==================== */
function ensureOddsHint(){
  if($("#bet-odds-hint")) return $("#bet-odds-hint");
  const form = $("#bet-form");
  if(!form) return null;
  const p = document.createElement("p");
  p.id = "bet-odds-hint";
  p.className = "muted";
  p.style.marginTop = "8px";
  form.appendChild(p);
  return p;
}
function updateOddsHint(){
  const matchId = $("#bet-match")?.value;
  const pick = $("#bet-pick")?.value;
  const hint = ensureOddsHint();
  if(!hint) return;
  if(!matchId || !pick){
    hint.textContent = "Selecione a partida e o palpite para ver o retorno estimado.";
    return;
  }
  const m = state.matches.find(x=>x.id===matchId);
  if(!m){
    hint.textContent = "Partida inválida.";
    return;
  }
  const { payout } = payoutForPick(m, pick);
  const lucro = Math.max(0, payout - BET_COST);
  hint.innerHTML = `Retorno estimado: <b>${payout}</b> (Lucro: <b>${lucro}</b>)`;
}
["change","input"].forEach(evt=>{
  $("#bet-match")?.addEventListener(evt, updateOddsHint);
  $("#bet-pick")?.addEventListener(evt, updateOddsHint);
});

/* ==================== Apostas (Minhas) ==================== */
function listenBets(){
  if(state.listeners.bets) state.listeners.bets();
  if(!state.user){ state.bets=[]; renderBetsTable(); renderBetsSelect(); return; }

  state.listeners.bets = onSnapshot(
    query(collection(db,"bets"), where("uid","==",state.user.uid)),
    (qs)=>{
      const list = qs.docs.map(d=>{
        const data = d.data();
        const ts = data.createdAt?.toMillis ? data.createdAt.toMillis()
                 : data.createdAt?.seconds ? data.createdAt.seconds*1000
                 : 0;
        return { id:d.id, __ts:ts, ...data };
      });
      state.bets = list.sort((a,b)=> b.__ts - a.__ts);
      renderBetsTable();
      renderBetsSelect();
      renderMatches();
    },
    (err)=> console.error("listenBets error:", err)
  );
}
function renderBetsTable(){
  const tbody = $("#bets-list");
  if(!tbody) return;
  // Ajusta cabeçalho para 6 colunas (Partida, Etapa, Palpite, Data/Hora, Status, Retorno)
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
      <td>${retorno}</td>
    </tr>`;
  }).join("");
}
function renderBetsSelect(){
  const sel = $("#bet-match");
  if(!sel) return;
  const already = new Set(state.bets.map(b=> b.matchId));
  const upcoming = state.matches.filter(m=>{
    if(m.result) return false;
    if(already.has(m.id)) return false;
    const d = parseLocalDate(m.date);
    return !d || d.getTime() > Date.now();
  });
  sel.innerHTML = `<option value="">— selecione —</option>` + upcoming.map(m=>{
    const pn = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
    return `<option value="${m.id}">${pn[m.aId]||"?"} × ${pn[m.bId]||"?"} — ${stageLabel(m.stage)}${m.group?` ${m.group}`:""}</option>`;
  }).join("");
  $("#bet-pick")?.style.setProperty("width","100%");
  $("#bet-match")?.style.setProperty("width","100%");
  updateOddsHint();
}
function formatBetStatus(b){
  const lucro = Math.max(0, (b.payoutPoints||0) - (b.stake||BET_COST));
  if(!b.status || b.status === "pendente"){
    return `Pendente – Lucro: ${lucro}${b.payoutPoints?` (Retorno: ${b.payoutPoints})`:""}`;
  }
  if(b.status === "ganhou"){
    const ret = Number.isFinite(b.settledPayout) ? b.settledPayout : (b.payoutPoints||0);
    const luc = Math.max(0, ret - (b.stake||BET_COST));
    return `Ganhou +${ret} (Lucro: ${luc})`;
  }
  if(b.status === "perdeu"){
    return `Perdeu`;
  }
  if(b.status === "adiada" || b.status === "postponed"){
    return `Adiada`;
  }
  return b.status;
}

/* ==================== Undo Bar ==================== */
function ensureUndoBar(){
  if($("#bet-undo-bar")) return $("#bet-undo-bar");
  const card = $("#apostas .grid-2 .card:nth-child(2)");
  if(!card) return null;
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
function showUndoBar(msg, seconds){
  const bar = ensureUndoBar();
  if(!bar) return;
  $("#bet-undo-text").innerHTML = msg;
  $("#bet-undo-count").textContent = `${seconds}s`;
  bar.style.display = "flex";
}
function hideUndoBar(){
  const bar = $("#bet-undo-bar");
  if(bar) bar.style.display = "none";
}
async function undoLastBet(){
  if(!undoState) return;
  if(Date.now() > undoState.until) { hideUndoBar(); undoState=null; return; }
  try{
    await runTransaction(db, async (tx)=>{
      const walRef = doc(db,"wallets",state.user.uid);
      const betRef = doc(db,"bets", undoState.id);

      // === LEITURAS PRIMEIRO ===
      const [betSnap, walSnap] = await Promise.all([tx.get(betRef), tx.get(walRef)]);
      if(!betSnap.exists()) throw new Error("Aposta já removida.");

      const cur = walSnap.exists() && typeof walSnap.data().points==="number" ? walSnap.data().points : 0;

      // === ESCRITAS DEPOIS ===
      tx.delete(betRef);
      tx.set(walRef, { points: cur + (undoState.refund||BET_COST), updatedAt: serverTimestamp() }, { merge:true });
    });
    if(undoState.feedKey){
      await rtdbRemove(rtdbRef(rtdb, `betsFeed/${undoState.feedKey}`)).catch(()=>{});
    }
    alert("Aposta desfeita e pontos devolvidos.");
  }catch(err){
    console.error("undo bet:", err);
    alert(err?.message || "Não foi possível desfazer.");
  }finally{
    if(undoState?.timer) clearInterval(undoState.timer);
    undoState = null;
    hideUndoBar();
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
      undoState = null;
      hideUndoBar();
    }
  };
  tick();
  undoState.timer = setInterval(tick, 250);
}

/* ==================== Submit Aposta ==================== */
function bindBetForm(){
  $("#bet-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
    try{
      if(!state.user) return alert("Entre com Google para apostar.");
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
        const walRef = doc(db,"wallets",state.user.uid);
        const betRef = doc(db,"bets", betDocId);

        // LEITURAS
        const [betExisting, walSnap] = await Promise.all([tx.get(betRef), tx.get(walRef)]);
        if(betExisting.exists()) throw new Error("Você já apostou nesta partida.");

        let curPts = 0;
        if(walSnap.exists() && typeof walSnap.data().points==="number"){
          curPts = walSnap.data().points;
        }else{
          curPts = MIN_SEED_POINTS;
          tx.set(walRef, { points: curPts, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge:true });
        }
        if(curPts < BET_COST) throw new Error("Saldo insuficiente para apostar.");

        // ESCRITAS
        tx.set(betRef, {
          uid: state.user.uid, matchId, pick,
          stake: BET_COST,
          pickProb: probPct,
          payoutPoints: payout,
          createdAt: serverTimestamp(), status: "pendente"
        });
        tx.update(walRef, { points: curPts - BET_COST, updatedAt: serverTimestamp() });
      });

      const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
      await rtdbSet(rtdbRef(rtdb, `betsFeed/${feedKey}`), {
        uid: state.user.uid,
        name: state.user.displayName || state.user.email || "Usuário",
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

      undoState = {
        id: betDocId, matchId, stake: BET_COST, refund: BET_COST,
        until: Date.now() + UNDO_WINDOW_MS, timer: null, feedKey
      };
      showUndoBar(`Aposta registrada em <b>${mapP[match.aId]||"?"} × ${mapP[match.bId]||"?"}</b>. Você pode <b>desfazer</b> em até 5s.`, 5);
      startUndoCountdown();

      // ajuste otimista do saldo
      const el = $("#wallet-points");
      if(el){ const nowPts = Math.max(0, (parseInt(el.textContent||"0",10)||0) - BET_COST); el.textContent = String(nowPts); }
      e.target.reset();
      updateOddsHint();
    }catch(err){
      console.error("bet add", err);
      alert(err?.message || "Erro ao registrar aposta. Verifique regras/permissões.");
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
    write.update(doc(db,"bets",b.id), { status: ok?"ganhou":"perdeu", settledAt: serverTimestamp(), settledPayout: credit });
    if(ok){
      write.set(doc(db,"wallets",state.user.uid), { points: state.wallet + credit, updatedAt: serverTimestamp() }, { merge:true });
    }
    changed = true;
  }
  if(changed) await write.commit();
}

/* ==================== Feed RTDB (Apostas Recentes) ==================== */
function ensureBetsFeedUI(){
  if($("#bets-feed")) return;
  const apSec = $("#apostas");
  if(!apSec) return;
  const card = document.createElement("div");
  card.className = "card";
  card.id = "bets-feed";
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
  // Calcula status/retorno a partir de state.matches
  const m = state.matches.find(x=>x.id===v.matchId);
  if(!m || !m.result) return { status:"Pendente", retorno:v.payout||"-" };
  if(m.result==="postponed") return { status:"Adiada", retorno:"-" };
  const won = (v.pick==="draw" && m.result==="draw") || (v.pick==="A" && m.result==="A") || (v.pick==="B" && m.result==="B");
  return { status: won?"Ganhou":"Perdeu", retorno: won?(v.payout||"-"):"-" };
}
function addFeedRow(key, v){
  const tbody = $("#bets-feed-tbody");
  if(!tbody) return;
  const ph = tbody.querySelector(".muted");
  if(ph) ph.closest("tr")?.remove();

  const when = new Date(v.ts||Date.now());
  const { status, retorno } = feedRowStatusAndReturn(v);
  const etapa = v.stage==="groups" ? `F. Grupos${v.group?` ${v.group}`:""}` : stageLabel(v.stage);

  const tr = document.createElement("tr");
  tr.id = `betfeed-${key}`;
  tr.innerHTML = `
    <td>${(v.name||"—").replace(/</g,"&lt;")}</td>
    <td>${(v.aName||"?")} × ${(v.bName||"?")}</td>
    <td>${etapa}</td>
    <td>${v.pick==="A"?"Vitória A": v.pick==="B"?"Vitória B":"Empate"}</td>
    <td>${fmt2(when.getDate())}/${fmt2(when.getMonth()+1)}/${when.getFullYear()} ${fmt2(when.getHours())}:${fmt2(when.getMinutes())}</td>
    <td>${status}</td>
    <td>${retorno}</td>
  `;
  tbody.prepend(tr);
}
function updateFeedRow(key){
  const v = state.feedRowsData[key];
  if(!v) return;
  const tr = $(`#betfeed-${key}`);
  if(!tr) return;
  const { status, retorno } = feedRowStatusAndReturn(v);
  const tds = tr.querySelectorAll("td");
  if(tds.length>=7){
    tds[5].textContent = status;
    tds[6].textContent = retorno;
  }
}
function updateFeedStatuses(){
  Object.keys(state.feedRowsData).forEach(updateFeedRow);
}
function listenBetsFeed(){
  ensureBetsFeedUI();
  const tbody = $("#bets-feed-tbody");
  if(state.listeners.betsFeed) state.listeners.betsFeed();
  const ref = rtdbRef(rtdb, "betsFeed");

  state.listeners.betsFeed = onChildAdded(ref, (snap)=> {
    const key = snap.key;
    const v = snap.val();
    state.feedRows[key] = true;
    state.feedRowsData[key] = v;
    addFeedRow(key, v);
  });
  onChildRemoved(ref, (snap)=> {
    const key = snap.key;
    delete state.feedRows[key];
    delete state.feedRowsData[key];
    $(`#betfeed-${key}`)?.remove();
    if(Object.keys(state.feedRows).length===0){
      tbody.innerHTML = `<tr><td class="muted" colspan="7">Sem apostas no feed.</td></tr>`;
    }
  });
}

/* ==================== Rankings ==================== */
function ensureRankingsUI(){
  if($("#rankings-card")) return;
  const apSec = $("#apostas");
  if(!apSec) return;
  const card = document.createElement("div");
  card.className = "card";
  card.id = "rankings-card";
  card.innerHTML = `
    <h2>Rankings (Top 10)</h2>
    <div class="grid-3">
      <div>
        <h3>Melhor Apostador</h3>
        <ol id="rk-best-bettor" class="list"></ol>
        <p class="muted">Critério: maior taxa de acerto (min. 3 apostas; desempate por nº de acertos).</p>
      </div>
      <div>
        <h3>Mais Pontos</h3>
        <ol id="rk-most-points" class="list"></ol>
      </div>
      <div>
        <h3>Mais Apostas</h3>
        <ol id="rk-most-bets" class="list"></ol>
      </div>
    </div>
  `;
  apSec.appendChild(card);
}
function niceName(uid, usersMap, walletsMap){
  const u = usersMap[uid];
  if(u?.displayName) return u.displayName;
  if(walletsMap[uid]?.email) return walletsMap[uid].email;
  return uid.slice(0,6);
}
async function rebuildRankings(){
  ensureRankingsUI();
  // snapshots
  const [betsSnap, walletsSnap, usersSnap] = await Promise.all([
    getDocs(collection(db,"bets")),
    getDocs(collection(db,"wallets")),
    getDocs(collection(db,"users")).catch(()=>({forEach:()=>{}})) // users pode não existir
  ]);

  const usersMap = {};
  usersSnap.forEach(d=> usersMap[d.id] = d.data());

  const walletsMap = {};
  walletsSnap.forEach(d=> walletsMap[d.id] = d.data());

  // contagem aposta e acertos (inferidos pelas partidas!)
  const byUser = {}; // uid -> {total,wins}
  betsSnap.forEach(d=>{
    const b = d.data();
    const uid = b.uid; if(!uid) return;
    if(!byUser[uid]) byUser[uid] = { total:0, wins:0 };
    byUser[uid].total++;

    const m = state.matches.find(x=>x.id===b.matchId);
    if(m && m.result && m.result!=="postponed"){
      const ok = (b.pick==="draw" && m.result==="draw") || (b.pick==="A" && m.result==="A") || (b.pick==="B" && m.result==="B");
      if(ok) byUser[uid].wins++;
    }
  });

  // Melhor Apostador
  const best = Object.entries(byUser)
    .filter(([,v])=> v.total>=3)
    .map(([uid,v])=> ({ uid, rate: v.total? v.wins/v.total : 0, wins:v.wins, total:v.total }))
    .sort((a,b)=> (b.rate - a.rate) || (b.wins - a.wins))
    .slice(0,10);

  const elBest = $("#rk-best-bettor");
  if(elBest){
    elBest.innerHTML = best.length ? best.map((r,i)=>{
      const nm = niceName(r.uid, usersMap, walletsMap);
      return `<li><b>${nm}</b> — ${(r.rate*100).toFixed(0)}% (${r.wins}/${r.total})</li>`;
    }).join("") : `<li class="muted">Sem dados suficientes.</li>`;
  }

  // Mais pontos (carteira)
  const mostPoints = Object.entries(walletsMap)
    .map(([uid,w])=> ({ uid, pts: (typeof w.points==="number"?w.points:0) }))
    .sort((a,b)=> b.pts - a.pts)
    .slice(0,10);
  const elPts = $("#rk-most-points");
  if(elPts){
    elPts.innerHTML = mostPoints.length ? mostPoints.map(r=>{
      const nm = niceName(r.uid, usersMap, walletsMap);
      return `<li><b>${nm}</b> — ${r.pts} pts</li>`;
    }).join("") : `<li class="muted">Sem dados.</li>`;
  }

  // Mais apostas
  const mostBets = Object.entries(byUser)
    .map(([uid,v])=>({ uid, total:v.total }))
    .sort((a,b)=> b.total - a.total)
    .slice(0,10);
  const elMB = $("#rk-most-bets");
  if(elMB){
    elMB.innerHTML = mostBets.length ? mostBets.map(r=>{
      const nm = niceName(r.uid, usersMap, walletsMap);
      return `<li><b>${nm}</b> — ${r.total} apostas</li>`;
    }).join("") : `<li class="muted">Sem dados.</li>`;
  }
}

/* ==================== Semis + Publicações manuais ==================== */
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
    body: `Semifinal 1: ${mapP[a1]} × ${mapP[b2]}\nSemifinal 2: ${mapP[b1]} × ${mapP[a2]}`,
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
    const title = (m.result==="draw")
      ? `Empate entre ${mapP[m.aId]||"?"} e ${mapP[m.bId]||"?"}`
      : `Vitória de ${(m.result==="A"?mapP[m.aId]:mapP[m.bId])||"?"} contra ${(m.result==="A"?mapP[m.bId]:mapP[m.aId])||"?"}`;
    await addDoc(collection(db,"posts"), {
      title, body: "", type: "result", matchId: m.id,
      createdAt: serverTimestamp(),
      authorUid: state.user?.uid||null, authorEmail: state.user?.email||null, authorName: state.user?.displayName||"Admin"
    });
    created++;
  }
  alert(created ? `Publicados ${created} comunicado(s) de resultados.` : "Nenhum comunicado pendente de resultado.");
}
async function autoPostponeOverdue(){
  const now = Date.now();
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
        body: `A partida ${m.code||""} (${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}`: stageLabel(m.stage)}) foi adiada por expirar o prazo sem resultado.`,
        type: "postponed",
        matchId: m.id,
        createdAt: serverTimestamp(),
        authorName: "Sistema",
        authorEmail: "sistema@champions"
      });
    }
  }
}

/* ==================== Ferramentas Admin ==================== */
function ensureAdminToolsButtons(){
  if(!state.admin) return;
  const adminView = $("#admin");
  if(!adminView) return;
  const toolsCard = Array.from(adminView.querySelectorAll(".card"))
    .find(c => /Ferramentas/i.test(c.textContent || ""));
  if(!toolsCard) return;

  if(!toolsCard.querySelector("#btn-publish-results")){
    const btn = document.createElement("button");
    btn.id = "btn-publish-results";
    btn.className = "btn";
    btn.style.marginRight = "8px";
    btn.textContent = "Publicar resultados (pendentes)";
    btn.addEventListener("click", generateResultPostsForFinished);
    toolsCard.querySelector("h2")?.after(btn);
  }
  if(!toolsCard.querySelector("#btn-publish-postponed")){
    const btn2 = document.createElement("button");
    btn2.id = "btn-publish-postponed";
    btn2.className = "btn ghost";
    btn2.style.marginRight = "8px";
    btn2.textContent = "Publicar adiamentos (pendentes)";
    btn2.addEventListener("click", generatePostponedPostsForOverdue);
    toolsCard.querySelector("#btn-publish-results")?.after(btn2);
  }
  // Apagar todos os comunicados
  if(!toolsCard.querySelector("#btn-delete-all-posts")){
    const btn3 = document.createElement("button");
    btn3.id = "btn-delete-all-posts";
    btn3.className = "btn danger";
    btn3.style.marginLeft = "8px";
    btn3.textContent = "Apagar TODOS os comunicados";
    btn3.addEventListener("click", async ()=>{
      if(!confirm("Tem certeza que deseja APAGAR TODOS os comunicados?")) return;
      const qs = await getDocs(collection(db,"posts"));
      const b = writeBatch(db);
      qs.forEach(d=> b.delete(d.ref));
      await b.commit();
      alert("Todos os comunicados foram apagados.");
    });
    toolsCard.querySelector("#btn-publish-postponed")?.after(btn3);
  }
  // Resetar saldos
  if(!toolsCard.querySelector("#btn-reset-wallets")){
    const btn4 = document.createElement("button");
    btn4.id = "btn-reset-wallets";
    btn4.className = "btn danger";
    btn4.style.marginLeft = "8px";
    btn4.textContent = "Resetar saldos (todos)";
    btn4.addEventListener("click", async ()=>{
      if(!confirm("Resetar saldos de todos para 6 pontos?")) return;
      const qs = await getDocs(collection(db,"wallets"));
      const b = writeBatch(db);
      qs.forEach(d=> b.set(d.ref, { points: MIN_SEED_POINTS, updatedAt: serverTimestamp() }, { merge:true }));
      await b.commit();
      alert("Saldos resetados.");
    });
    toolsCard.querySelector("#btn-delete-all-posts")?.after(btn4);
  }
  // Resetar apostas e ranking
  if(!toolsCard.querySelector("#btn-reset-bets")){
    const btn5 = document.createElement("button");
    btn5.id = "btn-reset-bets";
    btn5.className = "btn danger";
    btn5.style.marginLeft = "8px";
    btn5.textContent = "Resetar apostas e ranking";
    btn5.addEventListener("click", async ()=>{
      if(!confirm("Apagar TODAS as apostas e limpar feed?")) return;
      const qs = await getDocs(collection(db,"bets"));
      const b = writeBatch(db);
      qs.forEach(d=> b.delete(d.ref));
      await b.commit();
      // limpa feed RTDB
      try { await rtdbRemove(rtdbRef(rtdb,"betsFeed")); } catch(_){}
      alert("Apostas e feed foram resetados.");
      rebuildRankings();
    });
    toolsCard.querySelector("#btn-reset-wallets")?.after(btn5);
  }
}
async function generatePostponedPostsForOverdue(){
  let created = 0;
  const now = Date.now();
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
        body: `A partida ${m.code||""} (${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}`: stageLabel(m.stage)}) foi adiada por expirar o prazo sem resultado.`,
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

/* ==================== Perfil ==================== */
function bindProfileForm(){
  $("#profile-form")?.addEventListener("submit", async (e)=>{
    e.preventDefault(); e.stopPropagation();
    if(!state.user) return;
    const name = $("#profile-name").value.trim();
    if(name){
      await setDoc(doc(db,"users",state.user.uid), {
        displayName: name, email: state.user.email, updatedAt: serverTimestamp()
      }, { merge:true });
      state.user.displayName = name;
      updateAuthUI();
      alert("Perfil salvo!");
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

/* ==================== Auth listeners ==================== */
function bindAuthButtons(){
  $("#btn-open-login")?.addEventListener("click", loginGoogle);
  $("#btn-logout")?.addEventListener("click", logout);
}

onAuthStateChanged(auth, async (user)=>{
  state.user = user || null;
  if(user) await ensureAdminBootstrap(user);
  if(user) await ensureWalletInit(user.uid);

  listenAdmin(user);
  updateAuthUI();
  fillProfile();
  listenBets();
  listenWallet(user?.uid||null);
  listenBetsFeed();
  rebuildRankings();
});

/* ==================== Init ==================== */
function init(){
  bindAuthButtons();
  initTabs();
  listenPlayers();
  listenMatches();
  listenPosts();
  initChat();
  bindPostForm();
  bindMatchForm();
  bindProfileForm();
  bindBetForm();
  bindSeed();
  ensureRankingsUI();
  if(!_bootShown){ _bootShown = true; showTab("home"); }
}
init();

/* ==================== Seed (players/matches) ==================== */
function bindSeed(){
  $("#seed-btn")?.addEventListener("click", async ()=>{
    if(!confirm("Criar seed de exemplo (jogadores + partidas de grupos)?")) return;

    const namesA = ["Hugo", "Eudison", "Rhuan", "Luís Felipe", "Yuri"];
    const namesB = ["Kelvin", "Marcos", "Davi", "Alyson", "Wemerson"];
    const got = await getDocs(collection(db,"players"));
    if(got.empty){
      const b = writeBatch(db);
      [...namesA.map(n=>({name:n,group:"A"})), ...namesB.map(n=>({name:n,group:"B"}))].forEach(p=>{
        const id = doc(collection(db,"players")).id;
        b.set(doc(db,"players",id), { name:p.name, group:p.group, createdAt: serverTimestamp() });
      });
      await b.commit();
    }

    const allPlayersSnap = await getDocs(collection(db,"players"));
    const idByName = {}; allPlayersSnap.forEach(d=> idByName[d.data().name] = d.id);

    const roundsA = [
      [{a:"Eudison",b:"Yuri"},{a:"Rhuan",b:"Luís Felipe"}],
      [{a:"Hugo",b:"Yuri"},{a:"Eudison",b:"Rhuan"}],
      [{a:"Hugo",b:"Luís Felipe"},{a:"Yuri",b:"Rhuan"}],
      [{a:"Hugo",b:"Rhuan"},{a:"Luís Felipe",b:"Eudison"}],
      [{a:"Hugo",b:"Eudison"},{a:"Luís Felipe",b:"Yuri"}],
    ];
    const roundsB = [
      [{a:"Marcos",b:"Wemerson"},{a:"Davi",b:"Alyson"}],
      [{a:"Kelvin",b:"Wemerson"},{a:"Marcos",b:"Davi"}],
      [{a:"Kelvin",b:"Alyson"},{a:"Wemerson",b:"Davi"}],
      [{a:"Kelvin",b:"Davi"},{a:"Alyson",b:"Marcos"}],
      [{a:"Kelvin",b:"Marcos"},{a:"Alyson",b:"Wemerson"}],
    ];

    const mSnap = await getDocs(collection(db,"matches"));
    if(mSnap.empty){
      const b2 = writeBatch(db);
      let codeN = 1;
      const addRound = (group, arr)=>{
        arr.forEach(pair=>{
          const id = doc(collection(db,"matches")).id;
          b2.set(doc(db,"matches",id), {
            aId: idByName[pair.a], bId: idByName[pair.b],
            stage: "groups", group, date: null, code: `G${group}-${fmt2(codeN++)}`,
            result: null, createdAt: serverTimestamp()
          });
        });
      };
      roundsA.forEach(r=> addRound("A", r));
      roundsB.forEach(r=> addRound("B", r));
      await b2.commit();
    }
    alert("Seed criado.");
  });
}
