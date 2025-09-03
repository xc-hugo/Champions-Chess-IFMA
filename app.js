// app.js
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
  getDatabase, ref as rtdbRef, push, onChildAdded, onChildRemoved, remove
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

// ===== Helpers DOM
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmt2 = n => n < 10 ? `0${n}` : `${n}`;

function fmtLocalDateStr(val){
  if(!val) return "—";
  const d = parseLocalDate(val);
  if(!d) return "—";
  return `${fmt2(d.getDate())}/${fmt2(d.getMonth()+1)}/${d.getFullYear()} ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function fmtTime(val){
  if(!val) return "—";
  const d = parseLocalDate(val);
  if(!d) return "—";
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}
function parseLocalDate(input){
  // aceita datetime-local (yyyy-mm-ddThh:mm) e ISO padrão
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
const clamp01 = x => Math.max(0, Math.min(1, x));
const clampPct = x => Math.max(0, Math.min(100, x));

// ===== Firebase config
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
const db = getFirestore(app);
const rtdb = getDatabase(app);

// ===== Admin config
const ADMIN_EMAILS = [
  // adicione seus e-mails admin aqui, por exemplo:
  // "voce@ifma.edu.br"
];

// ===== Estado
const state = {
  user: null,
  admin: false,
  players: [],
  matches: [],
  posts: [],
  bets: [],
  wallet: 0,
  // observações internas
  listeners: { players: null, matches: null, posts: null, bets: null, wallet: null, chat: null },
};

// ===== Abas
function showTab(tab){
  $$(".view").forEach(v=>v.classList.remove("visible"));
  $$(".tab").forEach(b=>b.classList.remove("active"));
  const el = $(`#${tab}`);
  if(el){ el.classList.add("visible"); }
  const btn = $(`.tab[data-tab="${tab}"]`);
  if(btn){ btn.classList.add("active"); }
  // ir pro topo sempre que trocar
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initTabs(){
  $$(".tab").forEach(btn=>{
    btn.onclick = ()=>{
      const tab = btn.dataset.tab;
      showTab(tab);
    };
  });
  // chip do usuário abre PERFIL
  const chip = $("#user-chip");
  if(chip){
    chip.onclick = ()=> showTab("perfil");
  }
}

// ===== Auth
async function loginGoogle(){
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}
async function logout(){
  await signOut(auth);
}

async function checkAdmin(user){
  if(!user) return false;
  if(ADMIN_EMAILS.includes(user.email)) return true;
  // fallback: Firestore doc admins/{uid}
  try{
    const ad = await getDoc(doc(db, "admins", user.uid));
    return ad.exists() && ad.data()?.isAdmin === true;
  }catch(_){ return false; }
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
  }else{
    chip?.classList.add("hidden");
    btnLogin?.classList.remove("hidden");
    btnOut?.classList.add("hidden");
    adminBadge?.classList.add("hidden");
    tabAdmin?.classList.add("hidden");
  }

  // aposta só logado
  const betForm = $("#bet-form");
  if(betForm){
    const inputs = betForm.querySelectorAll("input,select,button,textarea");
    inputs.forEach(i=> i.disabled = !state.user);
  }
}

// ===== Carteira / Wallet
async function ensureWalletInit(uid){
  if(!uid) return;
  const refWal = doc(db, "wallets", uid);
  try{
    await runTransaction(db, async (tx)=>{
      const snap = await tx.get(refWal);
      if(!snap.exists()){
        tx.set(refWal, { points: 6, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }else{
        const cur = snap.data() || {};
        const hasNum = typeof cur.points === "number";
        const newPts = hasNum ? Math.max(6, cur.points) : 6;  // mínimo 6
        if(!hasNum || newPts !== cur.points){
          tx.update(refWal, { points: newPts, updatedAt: serverTimestamp() });
        }
      }
    });
  }catch(err){
    // fallback
    try{
      await setDoc(refWal, { points: 6, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
    }catch(e){ console.error("ensureWalletInit fallback failed:", e); }
  }
}

function listenWallet(uid){
  if(state.listeners.wallet) state.listeners.wallet(); // unsubscribe
  if(!uid){
    state.wallet = 0;
    $("#wallet-points") && ($("#wallet-points").textContent = "0");
    return;
  }
  const refWal = doc(db, "wallets", uid);
  state.listeners.wallet = onSnapshot(refWal, (snap)=>{
    const data = snap.data();
    state.wallet = (data && typeof data.points === "number") ? data.points : 0;
    $("#wallet-points") && ($("#wallet-points").textContent = String(state.wallet));
  });
}

// ===== Chat (Realtime Database)
function initChat(){
  const list = $("#chat-list");
  const form = $("#chat-form");
  const input = $("#chat-text");

  // listeners únicos
  if(state.listeners.chat) return;

  const chatRef = rtdbRef(rtdb, "chat");
  const renderItem = (id, msg) => {
    // ignorar mensagens mais antigas que 24h (apenas no render)
    const now = Date.now();
    if(msg.ts && (now - msg.ts) > 24*60*60*1000) return;

    const item = document.createElement("div");
    item.className = "chat-item";
    item.id = `chat-${id}`;
    const time = new Date(msg.ts || Date.now());
    const hh = fmt2(time.getHours()), mm = fmt2(time.getMinutes());
    const canDel = !!state.admin || (state.user && state.user.uid === msg.uid);
    item.innerHTML = `
      <div class="meta"><b>${msg.name||"—"}</b> &lt;${msg.email||"—"}&gt; • ${hh}:${mm}</div>
      <div>${(msg.text||"").replace(/</g,"&lt;")}</div>
      ${canDel? `<div style="margin-top:8px"><button class="btn danger small btn-del-chat" data-id="${id}">🗑 Apagar</button></div>` : ""}
    `;
    list?.appendChild(item);

    if(canDel){
      item.querySelector(".btn-del-chat")?.addEventListener("click", async ()=>{
        if(!confirm("Apagar esta mensagem do chat?")) return;
        await remove(rtdbRef(rtdb, `chat/${id}`));
      });
    }
  };

  onChildAdded(chatRef, (snap)=> renderItem(snap.key, snap.val()));
  onChildRemoved(chatRef, (snap)=>{
    const el = $(`#chat-${snap.key}`);
    el?.remove();
  });

  form?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    if(!state.user) return alert("Entre com Google para enviar.");
    const text = (input?.value||"").trim();
    if(!text) return;
    await push(chatRef, {
      uid: state.user.uid,
      name: state.user.displayName || state.user.email,
      email: state.user.email || "",
      text,
      ts: Date.now()
    });
    input.value = "";
  });

  // dica login
  $("#chat-login-hint")?.classList.toggle("hidden", !!state.user);
}

// ===== Players
function listenPlayers(){
  if(state.listeners.players) state.listeners.players();
  state.listeners.players = onSnapshot(query(collection(db,"players"), orderBy("name","asc")), (qs)=>{
    state.players = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderPlayers();
    renderPlayerSelects();
    renderTables();
    renderBetsSelect();
    renderHome(); // nomes nas próximas partidas
  });
}

function renderPlayers(){
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

  // clique abre detalhes e botão "Abrir perfil"
  $$("#players .player-card").forEach(card=>{
    card.onclick = ()=>{
      const id = card.dataset.id;
      const p = state.players.find(x=>x.id===id);
      if(!p) return;
      // destacar
      $$("#players .player-card").forEach(c=>c.classList.remove("selected"));
      card.classList.add("selected");
      renderPlayerDetails(p.id);
    };
  });
}

function renderPlayerSelects(){
  const sel = $("#player-select");
  if(sel){
    sel.innerHTML = state.players.map(p=> `<option value="${p.id}">${p.name}</option>`).join("");
    sel.onchange = ()=> renderPlayerDetails(sel.value);
  }
  // selects do formulário de partidas + semis
  const sA = $("#match-a"), sB = $("#match-b");
  if(sA && sB){
    sA.innerHTML = state.players.map(p=> `<option value="${p.id}">${p.name}</option>`).join("");
    sB.innerHTML = sA.innerHTML;
  }
  const s1a=$("#semi1-a"), s1b=$("#semi1-b"), s2a=$("#semi2-a"), s2b=$("#semi2-b");
  [s1a,s1b,s2a,s2b].forEach(sel=>{
    if(sel) sel.innerHTML = state.players.map(p=> `<option value="${p.id}">${p.name}</option>`).join("");
  });
}

function buildPlayerProfileHTML(p){
  const stats = computePlayerStats(p.id);
  const hist = state.matches
    .filter(m=> m.aId===p.id || m.bId===p.id)
    .sort((x,y)=> (parseLocalDate(y.date)||0) - (parseLocalDate(x.date)||0));

  const mapP=Object.fromEntries(state.players.map(pl=>[pl.id,pl.name]));
  const rows = hist.map(m=>{
    const opp = m.aId===p.id ? m.bId : m.aId;
    let res = "—";
    if(m.result==="draw") res = "Empate";
    else if(m.result==="A") res = (m.aId===p.id?"Vitória":"Derrota");
    else if(m.result==="B") res = (m.bId===p.id?"Vitória":"Derrota");
    else if(m.result==="postponed") res = "Adiado";
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
      <div>
        <button class="btn ghost" id="btn-open-player-profile" data-id="${p.id}">Abrir perfil</button>
      </div>
    </div>
  `);

  $("#btn-open-player-profile")?.addEventListener("click", ()=>{
    const sec = $("#player-profile");
    if(sec) sec.innerHTML = buildPlayerProfileHTML(p);
    showTab("player-profile");
  });
}

// ===== Pontuação / Standings (só fase de grupos)
function computePlayerStats(playerId){
  const groupMatches = state.matches.filter(m=> m.stage==="groups" && (m.aId===playerId || m.bId===playerId));
  let points=0,w=0,d=0,l=0,played=0;
  for(const m of groupMatches){
    if(!m.result) continue;
    if(m.result==="postponed") continue;
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
function renderTables(){
  const groups = ["A","B"];
  for(const g of groups){
    const players = state.players.filter(p=>p.group===g);
    const rows = players.map(p=>{
      const st = computePlayerStats(p.id);
      return { id:p.id, name:p.name, ...st };
    }).sort((a,b)=>{
      if(b.points!==a.points) return b.points-a.points;
      if(b.wins!==a.wins) return b.wins-a.wins;
      return a.name.localeCompare(b.name);
    });

    const html = `
      <div class="table">
        <table>
          <thead>
            <tr><th>#</th><th>Jogador</th><th>J</th><th>V</th><th>E</th><th>D</th><th>Pts</th></tr>
          </thead>
          <tbody>
            ${rows.map((r,idx)=>`
              <tr class="${idx===0?'pos-1': idx===1?'pos-2':''}">
                <td>${idx+1}</td>
                <td>${r.name}</td>
                <td>${r.played}</td>
                <td>${r.wins}</td>
                <td>${r.draws}</td>
                <td>${r.losses}</td>
                <td><b>${r.points}</b></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
    $(`#table-${g}`)?.replaceChildren();
    $(`#table-${g}`) && ($(`#table-${g}`).innerHTML = html);
  }
}

// ===== Partidas
function stageLabel(s){
  if(s==="semifinal") return "Semifinal";
  if(s==="final") return "Final";
  if(s==="third") return "3º Lugar";
  if(s==="groups") return "F. Grupos";
  return s||"—";
}

function listenMatches(){
  if(state.listeners.matches) state.listeners.matches();
  state.listeners.matches = onSnapshot(query(collection(db,"matches"), orderBy("date","asc")), (qs)=>{
    state.matches = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderMatches();
    renderTables();
    renderBetsSelect();
    renderHome();
    autoCreatePostsForFinished();
    autoPostponeOverdue();
    autoCreateSemisIfDone();
    settleBetsIfFinished();
  });
}

function probForMatch(m){
  // Probabilidade V/E/D (A/empate/B) — só para exibir na aba Partidas
  // Mistura base de histórico (fase de grupos) + distribuição de apostas existentes
  const sA = computePlayerStats(m.aId);
  const sB = computePlayerStats(m.bId);
  const wpA = (sA.wins + 1) / ((sA.wins + sA.losses) + 2); // suavização
  const wpB = (sB.wins + 1) / ((sB.wins + sB.losses) + 2);
  let baseA = wpA / (wpA + wpB);
  let baseB = 1 - baseA;
  let baseD = 0.15; // empate base
  // distribuição de apostas para este jogo
  const bets = state.bets.filter(b=> b.matchId===m.id);
  const tot = bets.length || 1;
  const shareA = bets.filter(b=>b.pick==="A").length / tot;
  const shareB = bets.filter(b=>b.pick==="B").length / tot;
  const shareD = bets.filter(b=>b.pick==="draw").length / tot;

  // mistura 55% histórico, 45% apostas (empate mistura 15% base + shareD/2)
  let pA = clamp01(0.55*baseA + 0.45*shareA);
  let pB = clamp01(0.55*baseB + 0.45*shareB);
  let pD = clamp01(0.30*baseD + 0.70*shareD*0.7); // segura empate

  // normaliza para somar 1
  const s = pA + pB + pD || 1;
  pA/=s; pB/=s; pD/=s;

  // porcentagens
  return {
    A: Math.round(clampPct(pA*100)),
    D: Math.round(clampPct(pB*100)), // "D" = Derrota de A (vitória de B)
    E: Math.round(clampPct(pD*100))
  };
}

function renderMatches(){
  // atualizar opções do filtro se necessário
  const filterSel = $("#filter-stage");
  if(filterSel && !filterSel.dataset.patched){
    filterSel.innerHTML = `
      <option value="groups">Fase de grupos</option>
      <option value="groupA">Grupo A</option>
      <option value="groupB">Grupo B</option>
      <option value="semifinal">Semifinal</option>
      <option value="all">Todas</option>`;
    filterSel.dataset.patched = "1";
  }
  const filter = $("#filter-stage")?.value || "groups";

  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const GA = state.matches.filter(m=>m.stage==="groups" && m.group==="A");
  const GB = state.matches.filter(m=>m.stage==="groups" && m.group==="B");
  const KO = state.matches.filter(m=>m.stage!=="groups");

  const resLabel = (m)=>{
    if(m.result==="A") return mapP[m.aId]||"?";
    if(m.result==="B") return mapP[m.bId]||"?";
    if(m.result==="draw") return "Empate";
    if(m.result==="postponed") return "Adiado";
    return "Pendente";
  };
  const mkRow = (m)=> {
    const p = probForMatch(m);
    return `
      <tr data-id="${m.id}">
        <td><span class="chip chip--stage">${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}` : stageLabel(m.stage)}</span></td>
        <td><b>${mapP[m.aId]||"?"}</b> × <b>${mapP[m.bId]||"?"}</b></td>
        <td>${fmtLocalDateStr(m.date)}</td>
        <td>
          <span class="badge-small">V ${p.A}%</span>
          <span class="badge-small">E ${p.E}%</span>
          <span class="badge-small">D ${p.D}%</span>
        </td>
        <td><span class="chip chip--code">${m.code||"-"}</span></td>
        <td><span class="chip chip--res">${resLabel(m)}</span></td>
        ${state.admin? `<td><button class="btn ghost btn-edit" data-id="${m.id}">Editar</button></td>` : ""}
      </tr>
    `;
  };
  const mkTable = (items)=>`
    <div class="table">
      <table>
        <thead>
          <tr>
            <th>Etapa/Grupo</th>
            <th>Partida</th>
            <th>Data/Hora</th>
            <th>Prob. (V/E/D)</th>
            <th>Código</th>
            <th>Resultado</th>
            ${state.admin?`<th>Ações</th>`:""}
          </tr>
        </thead>
        <tbody>
          ${items.map(mkRow).join("")}
        </tbody>
      </table>
    </div>
  `;

  let html = "";
  if(filter==="groups" || filter==="groupA" || filter==="all"){
    if(filter!=="groupB"){
      html += `<div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo A</h3>${mkTable(GA)}</div>`;
    }
  }
  if(filter==="groups" || filter==="groupB" || filter==="all"){
    if(filter!=="groupA"){
      html += `<div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo B</h3>${mkTable(GB)}</div>`;
    }
  }
  if(filter==="semifinal" || filter==="all"){
    const semis = state.matches.filter(m=>m.stage==="semifinal");
    html += `<div class="card"><h3>Semifinais / KO</h3>${mkTable(semis.length?semis:KO)}</div>`;
  }
  $("#matches-list") && ($("#matches-list").innerHTML = html || `<div class="card"><p class="muted">Nenhuma partida.</p></div>`);

  if(state.admin){
    $$(".btn-edit").forEach(b=>{
      b.onclick = ()=> loadMatchToForm(b.dataset.id);
    });
  }
}

function bindMatchForm(){
  const form = $("#match-form");
  const resetBtn = $("#match-reset");
  const delBtn = $("#match-delete");
  const btnResetT = $("#btn-reset-tournament");

  form?.addEventListener("submit", async (e)=>{
    e.preventDefault();
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
    else if(!id){ payload.date = null; } // novo sem data
    // se edição e não alterou horário, mantém o original
    if(id && !dateNew && dateOrig){ payload.date = dateOrig; }

    if(!id){
      await addDoc(collection(db,"matches"), { ...payload, createdAt: serverTimestamp() });
    }else{
      await updateDoc(doc(db,"matches",id), { ...payload, updatedAt: serverTimestamp() });
      // se definiu resultado, cria post automático (sem duplicar)
      if(result && ["A","B","draw"].includes(result)){
        await ensurePostForMatch(id);
      }
    }
    form.reset();
    $("#match-id").value="";
    $("#match-date-orig").value="";
  });

  resetBtn?.addEventListener("click", ()=> {
    form.reset();
    $("#match-id").value="";
    $("#match-date-orig").value="";
  });

  delBtn?.addEventListener("click", async ()=>{
    const id = $("#match-id").value;
    if(!id) return;
    if(!confirm("Excluir esta partida?")) return;
    await deleteDoc(doc(db,"matches",id));
    form.reset();
    $("#match-id").value="";
    $("#match-date-orig").value="";
  });

  btnResetT?.addEventListener("click", async ()=>{
    if(!confirm("Tem certeza que deseja RESETAR o torneio? Isso apaga partidas, posts e apostas.")) return;
    // apaga matches, posts, bets (players ficam)
    const b = writeBatch(db);
    const mqs = await getDocs(collection(db,"matches"));
    mqs.forEach(d=> b.delete(d.ref));
    const pqs = await getDocs(collection(db,"posts"));
    pqs.forEach(d=> b.delete(d.ref));
    const bqs = await getDocs(collection(db,"bets"));
    bqs.forEach(d=> b.delete(d.ref));
    await b.commit();
    alert("Torneio resetado.");
  });

  $("#filter-stage")?.addEventListener("change", renderMatches);
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
    // datetime-local yyyy-MM-ddThh:mm
    const yyyy = d.getFullYear(); const mm = fmt2(d.getMonth()+1); const dd = fmt2(d.getDate());
    const hh = fmt2(d.getHours()); const mi = fmt2(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  })() : "";
  $("#match-date-orig").value = m.date || "";

  // rolar até o form (aba Partidas)
  const formCard = $("#admin-matches") || $("#match-form");
  if(formCard) formCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ===== Home
function renderHome(){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const scheduled=state.matches.filter(m=>!!m.date).slice().sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));
  const today=new Date(); const s=new Date(today); s.setHours(0,0,0,0); const e=new Date(today); e.setHours(23,59,59,999);
  const isSameDay=(d1,d2)=> d1.getFullYear()==d2.getFullYear()&&d1.getMonth()==d2.getMonth()&&d1.getDate()==d2.getDate();
  let pick=scheduled.filter(m=>{const d=parseLocalDate(m.date);return d&&d>=s&&d<=e;});
  if(pick.length===0){
    let nextDay=null; for(const m of scheduled){ const d=parseLocalDate(m.date); if(d&&d>e){ nextDay=d; break; } }
    if(nextDay){ pick=scheduled.filter(m=>{const d=parseLocalDate(m.date); return d&&isSameDay(d,nextDay);}); }
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
      <tbody>${rows||"<tr><td colspan='3'>Sem partidas hoje/próximo dia.</td></tr>"}</tbody>
    </table>
    <div class="home-next-extra">
      <p><b>Como funciona:</b> exibimos até <b>4 partidas</b> do dia atual; se não houver, mostramos as do próximo dia agendado.</p>
      <p>Edite datas e resultados na aba <b>Partidas</b>. Resultados confirmados geram comunicados na aba <b>Post</b>.</p>
      <p>Na <b>Tabela</b>, a pontuação é válida somente para a <b>Fase de Grupos</b> (Vitória 3 · Empate 1 · Derrota 0).</p>
    </div>
  `;
  $("#home-next") && ($("#home-next").innerHTML=table);

  // Últimos comunicados
  const posts = state.posts.slice(0,3).map((p,i)=>renderPostItem(p,i)).join("");
  if($("#home-posts")){
    $("#home-posts").innerHTML = posts || `<p class="muted">Sem comunicados.</p>`;
    if(state.admin){
      $$("#home-posts .btn-del-post").forEach(b=>{
        b.onclick=async ()=>{ if(!confirm("Apagar este comunicado?"))return; await deleteDoc(doc(db,"posts",b.dataset.id)); };
      });
    }
  }
}

// ===== Posts
function listenPosts(){
  if(state.listeners.posts) state.listeners.posts();
  state.listeners.posts = onSnapshot(query(collection(db,"posts"), orderBy("createdAt","desc")), (qs)=>{
    state.posts = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderPosts();
    renderHome();
  });
}
function renderPostItem(p){
  const dt = p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt? new Date(p.createdAt) : new Date());
  const hh = fmt2(dt.getHours()), mm = fmt2(dt.getMinutes());
  const who = p.authorName ? `${p.authorName} <${p.authorEmail||""}>` : (p.authorEmail||"—");
  return `
    <div class="post" id="post-${p.id}">
      <div>
        <div class="meta"><b>${p.title||"Comunicado"}</b> — ${hh}:${mm}</div>
        <div style="margin-top:6px">${(p.body||"").replace(/</g,"&lt;").replace(/\n/g,"<br>")}</div>
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
  const form = $("#post-form");
  form?.addEventListener("submit", async (e)=>{
    e.preventDefault();
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
    form.reset();
  });
}

// ===== Bets
function listenBets(){
  if(state.listeners.bets) state.listeners.bets();
  if(!state.user){ state.bets=[]; renderBets(); return; }
  state.listeners.bets = onSnapshot(query(collection(db,"bets"), where("uid","==",state.user.uid)), (qs)=>{
    state.bets = qs.docs.map(d=>({id:d.id, ...d.data()}));
    renderBets();
    renderMatches(); // atualiza probabilidades
  });
}

function renderBetsSelect(){
  const sel = $("#bet-match");
  if(!sel) return;
  // partidas futuras ou sem resultado
  const upcoming = state.matches.filter(m=>{
    if(m.result) return false;
    const d = parseLocalDate(m.date);
    return !d || d.getTime() > Date.now();
  });
  sel.innerHTML = `<option value="">— selecione —</option>` + upcoming.map(m=>{
    const pn = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
    return `<option value="${m.id}">${pn[m.aId]||"?"} × ${pn[m.bId]||"?"} — ${stageLabel(m.stage)}${m.group?` ${m.group}`:""}</option>`;
  }).join("");
}

function renderBets(){
  const tbody = $("#bets-list");
  if(!tbody) return;
  if(!state.bets.length){
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Sem apostas.</td></tr>`;
    return;
  }
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const rows = state.bets.map(b=>{
    const m = state.matches.find(x=>x.id===b.matchId);
    const name = m ? `${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}` : "(partida removida)";
    const etapa = m ? `${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}` : stageLabel(m.stage)}` : "—";
    return `<tr>
      <td>${name}</td>
      <td>${etapa}</td>
      <td>${b.pick==="A"?"Vitória A": b.pick==="B"?"Vitória B":"Empate"}</td>
      <td>${b.status||"pendente"}</td>
    </tr>`;
  }).join("");
  tbody.innerHTML = rows;
}

function bindBetForm(){
  const form = $("#bet-form");
  form?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    if(!state.user) return alert("Entre com Google para apostar.");
    const matchId = $("#bet-match").value;
    const pick = $("#bet-pick").value;
    if(!matchId || !pick) return;
    // grava aposta; (não descontamos pontos na entrada; prêmio +2 se acertar)
    await addDoc(collection(db,"bets"), {
      uid: state.user.uid,
      matchId, pick,
      createdAt: serverTimestamp(),
      status: "pendente"
    });
    alert("Aposta registrada!");
    form.reset();
  });
}

async function settleBetsIfFinished(){
  // paga apostas se a partida já tiver resultado (A/B/draw)
  const myBets = state.bets;
  const write = writeBatch(db);
  let changed = false;
  for(const b of myBets){
    if(b.status && b.status!=="pendente") continue;
    const m = state.matches.find(x=>x.id===b.matchId);
    if(!m || !m.result || m.result==="postponed") continue;
    const correct = (b.pick==="draw" && m.result==="draw") || (b.pick==="A" && m.result==="A") || (b.pick==="B" && m.result==="B");
    write.update(doc(db,"bets",b.id), { status: correct?"ganhou":"perdeu", settledAt: serverTimestamp() });
    if(correct && state.user && state.user.uid===b.uid){
      // +2 pontos
      write.set(doc(db,"wallets",state.user.uid), { points: Math.max(6, state.wallet) + 2, updatedAt: serverTimestamp() }, { merge: true });
    }
    changed = true;
  }
  if(changed) await write.commit();
}

// ===== Semifinais auto
async function autoCreateSemisIfDone(){
  // Se todas partidas de grupos têm resultado (ou adiadas), define semis (1ºA×2ºB e 1ºB×2ºA) e posta
  const groupsDone = ["A","B"].every(g=>{
    const ms = state.matches.filter(m=>m.stage==="groups" && m.group===g);
    if(!ms.length) return false;
    return ms.every(m=> !!m.result); // pendente? então não
  });
  if(!groupsDone) return;

  // já existem semis?
  const hasSemi = state.matches.some(m=> m.stage==="semifinal");
  if(hasSemi) return;

  // calcula top2
  const rank = g=>{
    const ps = state.players.filter(p=>p.group===g).map(p=>{
      const s = computePlayerStats(p.id);
      return { id:p.id, name:p.name, ...s };
    }).sort((a,b)=>{
      if(b.points!==a.points) return b.points-a.points;
      if(b.wins!==a.wins) return b.wins-a.wins;
      return a.name.localeCompare(b.name);
    });
    return ps.slice(0,2).map(x=>x.id);
  };
  const [a1,a2] = rank("A");
  const [b1,b2] = rank("B");
  if(!(a1&&a2&&b1&&b2)) return;

  // cria semis
  const m1 = { aId:a1, bId:b2, stage:"semifinal", group:null, code:"SF1", result:null, date:null };
  const m2 = { aId:b1, bId:a2, stage:"semifinal", group:null, code:"SF2", result:null, date:null };
  await addDoc(collection(db,"matches"), { ...m1, createdAt: serverTimestamp() });
  await addDoc(collection(db,"matches"), { ...m2, createdAt: serverTimestamp() });

  // post
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  await addDoc(collection(db,"posts"), {
    title: "Semifinais definidas",
    body: `Semifinal 1: ${mapP[a1]} × ${mapP[b2]}\nSemifinal 2: ${mapP[b1]} × ${mapP[a2]}`,
    createdAt: serverTimestamp()
  });
}

// ===== Posts automáticos p/ partidas concluídas (recria se apagarem)
async function ensurePostForMatch(matchId){
  const exists = state.posts.some(p=> p.matchId===matchId);
  if(exists) return;
  const m = state.matches.find(x=>x.id===matchId);
  if(!m || !m.result || m.result==="postponed") return;
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const body = m.result==="draw"
    ? `Empate entre ${mapP[m.aId]} e ${mapP[m.bId]}.`
    : `Vitória de ${m.result==="A"?mapP[m.aId]:mapP[m.bId]} contra ${m.result==="A"?mapP[m.bId]:mapP[m.aId]}.`;
  await addDoc(collection(db,"posts"), { title:"Resultado da partida", body, matchId, createdAt: serverTimestamp() });
}
async function autoCreatePostsForFinished(){
  for(const m of state.matches){
    if(m.result && m.result!=="postponed"){
      const has = state.posts.some(p=> p.matchId===m.id);
      if(!has){ await ensurePostForMatch(m.id); }
    }
  }
}

// ===== Adiamento automático (24h após horário definido)
async function autoPostponeOverdue(){
  const now = Date.now();
  for(const m of state.matches){
    if(m.stage!=="groups") continue; // regra vale pra grupos
    if(m.result) continue; // já tem resultado
    if(!m.date) continue;  // sem data
    const d = parseLocalDate(m.date);
    if(!d) continue;
    if(now - d.getTime() >= 24*60*60*1000){
      // adia somente esta partida
      await updateDoc(doc(db,"matches",m.id), { result:"postponed", updatedAt: serverTimestamp() });
      await addDoc(collection(db,"posts"), {
        title: "Partida adiada",
        body: `A partida ${m.code||""} (${m.stage==="groups" ? `F. Grupos${m.group?` ${m.group}`:""}`: stageLabel(m.stage)}) foi adiada por expirar o prazo sem resultado.`,
        matchId: m.id,
        createdAt: serverTimestamp()
      });
    }
  }
}

// ===== Admin: Seed
function bindSeed(){
  $("#seed-btn")?.addEventListener("click", async ()=>{
    if(!confirm("Criar seed de exemplo (jogadores + partidas de grupos)?")) return;

    // jogadores se não existirem
    const namesA = ["Hugo", "Eudison", "Rhuan", "Luís Felipe", "Yuri"];
    const namesB = ["Kelvin", "Marcos", "Davi", "Alyson", "Wemerson"];
    const all = [...namesA.map(n=>({name:n,group:"A"})), ...namesB.map(n=>({name:n,group:"B"}))];

    const pSnap = await getDocs(collection(db,"players"));
    if(pSnap.empty){
      const b = writeBatch(db);
      all.forEach(p=>{
        const id = doc(collection(db,"players")).id;
        b.set(doc(db,"players",id), { name:p.name, group:p.group, createdAt: serverTimestamp() });
      });
      await b.commit();
    }

    // partidas de grupos (round-robin com folga 5 jogadores)
    // A
    const a = namesA; const b = namesB;
    const allPlayersSnap = await getDocs(collection(db,"players"));
    const idByName = {};
    allPlayersSnap.forEach(d=> idByName[d.data().name] = d.id);

    const roundsA = [
      // Folga: Hugo
      [{a:"Eudison",b:"Yuri"},{a:"Rhuan",b:"Luís Felipe"}],
      // Folga: Luís Felipe
      [{a:"Hugo",b:"Yuri"},{a:"Eudison",b:"Rhuan"}],
      // Folga: Eudison
      [{a:"Hugo",b:"Luís Felipe"},{a:"Yuri",b:"Rhuan"}],
      // Folga: Yuri
      [{a:"Hugo",b:"Rhuan"},{a:"Luís Felipe",b:"Eudison"}],
      // Folga: Rhuan
      [{a:"Hugo",b:"Eudison"},{a:"Luís Felipe",b:"Yuri"}],
    ];
    const roundsB = [
      // Folga: Kelvin
      [{a:"Marcos",b:"Wemerson"},{a:"Davi",b:"Alyson"}],
      // Folga: Alyson
      [{a:"Kelvin",b:"Wemerson"},{a:"Marcos",b:"Davi"}],
      // Folga: Marcos
      [{a:"Kelvin",b:"Alyson"},{a:"Wemerson",b:"Davi"}],
      // Folga: Wemerson
      [{a:"Kelvin",b:"Davi"},{a:"Alyson",b:"Marcos"}],
      // Folga: Davi
      [{a:"Kelvin",b:"Marcos"},{a:"Alyson",b:"Wemerson"}],
    ];

    const mSnap = await getDocs(collection(db,"matches"));
    if(mSnap.empty){
      const b2 = writeBatch(db);
      let codeN = 1;
      const addRound = (group, arr)=>{
        arr.forEach(pair=>{
          const da = doc(collection(db,"matches"));
          b2.set(da, {
            aId: idByName[pair.a], bId: idByName[pair.b],
            stage: "groups", group,
            date: null, code: `G${group}-${fmt2(codeN++)}`,
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

// ===== Formulários: players
function bindPlayerForm(){
  const form = $("#player-form");
  $("#player-reset")?.addEventListener("click", ()=> {
    form?.reset();
    $("#player-id").value="";
  });
  $("#player-delete")?.addEventListener("click", async ()=>{
    const id = $("#player-id").value;
    if(!id) return;
    if(!confirm("Excluir jogador?")) return;
    await deleteDoc(doc(db,"players",id));
    form?.reset(); $("#player-id").value="";
  });
  form?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const id = $("#player-id").value || null;
    const name = $("#player-name").value.trim();
    const group = $("#player-group").value;
    if(!name || !group) return;
    const payload = { name, group };
    if(!id) await addDoc(collection(db,"players"), { ...payload, createdAt: serverTimestamp() });
    else await updateDoc(doc(db,"players",id), { ...payload, updatedAt: serverTimestamp() });
    form.reset(); $("#player-id").value="";
  });
}

// ===== Perfil do usuário
function bindProfileForm(){
  const form = $("#profile-form");
  form?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    if(!state.user) return;
    const name = $("#profile-name").value.trim();
    if(name){
      // salva em users/{uid}
      await setDoc(doc(db,"users",state.user.uid), {
        displayName: name, email: state.user.email, updatedAt: serverTimestamp()
      }, { merge: true });
      // refletir imediatamente no chip
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

// ===== Admin: criar semifinais manualmente
function bindSemis(){
  $("#semi-autofill")?.addEventListener("click", autoCreateSemisIfDone);
  $("#semi-save")?.addEventListener("click", async ()=>{
    const a1=$("#semi1-a").value, b2=$("#semi1-b").value;
    const b1=$("#semi2-a").value, a2=$("#semi2-b").value;
    const code=$("#semi-code").value.trim()||"SF";
    if(!(a1&&b2&&b1&&a2)) return alert("Selecione todos os jogadores.");
    await addDoc(collection(db,"matches"), { aId:a1, bId:b2, stage:"semifinal", code:`${code}1`, result:null, group:null, createdAt: serverTimestamp() });
    await addDoc(collection(db,"matches"), { aId:b1, bId:a2, stage:"semifinal", code:`${code}2`, result:null, group:null, createdAt: serverTimestamp() });
    alert("Semifinais criadas.");
  });
}

// ===== Home/Posts/Players bindings
function bindPlayersSearch(){
  $("#player-search-btn")?.addEventListener("click", ()=>{
    const q = ($("#player-search")?.value||"").toLowerCase().trim();
    if(!q){ renderPlayers(); return; }
    const res = state.players.filter(p=> (p.name||"").toLowerCase().includes(q));
    const mkCard = p => `
      <div class="player-card" data-id="${p.id}">
        <div class="avatar">${(p.name||"?").slice(0,2).toUpperCase()}</div>
        <div class="player-meta">
          <div class="name">${p.name||"?"}</div>
          <div class="muted">Grupo ${p.group||"—"}</div>
        </div>
      </div>`;
    $("#players-cards-A") && ($("#players-cards-A").innerHTML = res.filter(p=>p.group==="A").map(mkCard).join("") || "<p class='muted'>Sem jogadores.</p>");
    $("#players-cards-B") && ($("#players-cards-B").innerHTML = res.filter(p=>p.group==="B").map(mkCard).join("") || "<p class='muted'>Sem jogadores.</p>");
    $$("#players .player-card").forEach(card=>{
      card.onclick = ()=>{
        const id = card.dataset.id;
        renderPlayerDetails(id);
      };
    });
  });
}

// ===== Auth listeners
function bindAuthButtons(){
  $("#btn-open-login")?.addEventListener("click", loginGoogle);
  $("#btn-logout")?.addEventListener("click", logout);
}

onAuthStateChanged(auth, async (user)=>{
  state.user = user || null;
  state.admin = await checkAdmin(user);
  updateAuthUI();
  fillProfile();
  listenBets();
  listenWallet(user?.uid||null);
  if(user) await ensureWalletInit(user.uid);
});

// ===== Inicialização principal
function init(){
  bindAuthButtons();
  initTabs();
  listenPlayers();
  listenMatches();
  listenPosts();
  initChat();
  bindPostForm();
  bindMatchForm();
  bindPlayerForm();
  bindProfileForm();
  bindSemis();
  bindSeed();

  // por padrão, abrir Home
  showTab("home");
}
init();
