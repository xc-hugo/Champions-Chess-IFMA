// app.js — Champions Chess IFMA (ESM; usa firebase.js do projeto)

import {
  auth, db,
  loginWithGoogle, logout, watchAuth, isAdmin, setDisplayName,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp, runTransaction
} from "./firebase.js";

/* ========================= Helpers ========================= */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function confirmAction(msg){
  return new Promise(res=> res(window.confirm(msg)));
}

// Trata strings "YYYY-MM-DDTHH:mm" como horário LOCAL (sem fuso)
function parseLocalDate(str){
  if(!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str);
  if(!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], 0, 0); // local
}
function fmtLocalDateStr(str){
  const d = parseLocalDate(str);
  return d ? d.toLocaleString("pt-BR") : "—";
}
function fmtTS(ts){
  try{
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : (ts ? new Date(ts) : null));
    return d ? d.toLocaleString("pt-BR") : "—";
  }catch{ return "—"; }
}

function stageLabel(s){
  switch((s||"").toLowerCase()){
    case "groups":    return "F. Grupos";
    case "semifinal": return "Semifinal";
    case "final":     return "Final";
    case "third":     return "3º Lugar";
    default:          return s || "—";
  }
}

function slugifyName(name){
  return (name || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 20) || "user";
}
function shortUid(uid){ return (uid || "").slice(-4) || Math.floor(Math.random()*9999).toString().padStart(4,"0"); }

/* ===== Navbar fixa: compensação e scroll pro topo ===== */
function applyTopbarOffset(){
  const header = document.querySelector(".topbar");
  const h = header ? header.offsetHeight : 0;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
  document.documentElement.style.scrollPaddingTop = `${h}px`;
}
function showTab(id){
  if(!id) id = "home";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".view").forEach(v => v.classList.toggle("visible", v.id === id));
  if(location.hash.replace("#","") !== id) location.hash = id;
  applyTopbarOffset();
  // sobe pro topo sem "parar antes"
  window.scrollTo({ top: 0, behavior: "auto" });
}
window.addEventListener("load", applyTopbarOffset);
window.addEventListener("resize", applyTopbarOffset);
window.addEventListener("hashchange", ()=> showTab(location.hash.replace("#","") || "home"));
$$(".tab").forEach(b => {
  b.addEventListener("click", (e)=>{
    e.preventDefault();
    showTab(b.dataset.tab);
  });
});
showTab(location.hash.replace("#","") || "home");

// scroll helper pra gerenciador de partidas
function scrollToManageMatches(){
  const target = document.querySelector("#admin-matches, #manage-matches, #match-form");
  if(!target) return;
  const header = document.querySelector(".topbar");
  const offset = (header ? header.offsetHeight : 0) + 12;
  const y = target.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: y, behavior: "smooth" });
  setTimeout(()=>{
    const focusable = target.querySelector("select, input, textarea, button");
    focusable && focusable.focus();
  }, 300);
}
function ensureAndScrollToManage(){
  let tries = 0;
  const t = setInterval(()=>{
    const ok = document.querySelector("#admin-matches, #manage-matches, #match-form");
    if(ok){ clearInterval(t); scrollToManageMatches(); }
    if(++tries > 20) clearInterval(t);
  }, 50);
}

/* ========================= Estado ========================= */
let state = {
  user: null,
  admin: false,
  profile: null,
  players: [],
  matches: [],
  posts: [],
  chat: []
};

// guarda último resultado conhecido pra anunciar vit/emp/der
const prevResults = new Map();

/* ========================= Auth ========================= */
$("#btn-open-login")?.addEventListener("click", async ()=>{
  try { await loginWithGoogle(); }
  catch(err){ alert("Erro ao entrar com Google: " + err.message); }
});
$("#btn-logout")?.addEventListener("click", async ()=> { await logout(); });

async function loadProfile(uid){
  if(!uid){ state.profile=null; renderProfile(); return; }
  const snap = await getDoc(doc(db,"profiles",uid));
  state.profile = snap.exists() ? snap.data() : null;
  renderProfile();
}

/* ===== Admin realtime + timer de adiamento ===== */
let unsubscribeAdminWatch = null;
let postponeTimer = null;

function scheduleAutoPostponeTimer(enabled){
  if(postponeTimer){ clearInterval(postponeTimer); postponeTimer=null; }
  if(enabled){
    postponeTimer = setInterval(autoPostponeOverdueMatches, 5*60*1000);
    autoPostponeOverdueMatches();
  }
}
function setAdminFlag(flag){
  const changed = state.admin !== flag;
  state.admin = flag;
  $("#admin-badge")?.classList.toggle("hidden", !flag);
  $("#tab-admin")?.classList.toggle("hidden", !flag);
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !flag));
  scheduleAutoPostponeTimer(flag);
  if (changed) { renderPosts(); renderChat(); renderMatches(); renderHome(); renderAdminSemisList(); }
}

// perfil + username único (todas leituras antes das escritas)
$("#profile-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!state.user) return alert("Entre para editar o perfil.");

  const display = $("#profile-name").value.trim();
  const base = slugifyName(display);
  const fallback = `${base}-${shortUid(state.user.uid)}`;

  try{
    await runTransaction(db, async (tx)=>{
      const uid = state.user.uid;

      // leituras
      const profRef = doc(db, "profiles", uid);
      const profSnap = await tx.get(profRef);
      const oldUsername = profSnap.exists() ? (profSnap.data().username || null) : null;

      const tryRef = doc(db, "usernames", base);
      const trySnap = await tx.get(tryRef);

      let chosen = base;
      let fbRef = null, fbSnap = null;
      if(trySnap.exists()){
        chosen = fallback;
        fbRef = doc(db, "usernames", chosen);
        fbSnap = await tx.get(fbRef);
        if(fbSnap.exists()) throw new Error("USERNAME_TAKEN_FALLBACK");
      }

      let oldRef = null, oldSnap = null;
      if(oldUsername){
        oldRef = doc(db, "usernames", oldUsername);
        oldSnap = await tx.get(oldRef);
      }

      // escritas
      if(oldRef && oldSnap?.exists() && oldSnap.data().uid === uid){
        tx.delete(oldRef);
      }
      if(chosen === base) tx.set(tryRef, { uid, createdAt: serverTimestamp() });
      else                tx.set(fbRef,  { uid, createdAt: serverTimestamp() });

      tx.set(profRef, {
        displayName: display,
        username: chosen,
        email: state.user.email,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    await setDisplayName(state.user, display);
    const snap = await getDoc(doc(db,"profiles",state.user.uid));
    state.profile = snap.exists() ? snap.data() : null;
    renderProfile();
    alert("Perfil atualizado!");
  }catch(err){
    if(err.message === "USERNAME_TAKEN_FALLBACK"){
      alert("Não foi possível reservar um username único. Tente novamente.");
    }else if(err.code === "permission-denied"){
      alert("Sem permissão para salvar (verifique as REGRAS do Firestore).");
    }else{
      alert("Erro ao salvar perfil: " + err.message);
    }
  }
});

// watch auth
watchAuth(async (user)=>{
  state.user = user;

  $("#btn-open-login")?.classList.toggle("hidden", !!user);
  $("#btn-logout")?.classList.toggle("hidden", !user);
  $("#user-chip")?.classList.toggle("hidden", !user);
  if($("#user-email")) $("#user-email").textContent = user ? (user.displayName || user.email) : "";

  $("#chat-form")?.classList.toggle("hidden", !user);
  $("#chat-login-hint")?.classList.toggle("hidden", !!user);

  await loadProfile(user?.uid || null);

  setAdminFlag(false);
  if (unsubscribeAdminWatch) unsubscribeAdminWatch();
  if (user) {
    const adminRef = doc(db, "admins", user.uid);
    unsubscribeAdminWatch = onSnapshot(adminRef, (snap)=>{
      const active = snap.exists() && !!snap.data().active;
      setAdminFlag(active);
    });
  }

  renderPosts(); renderChat(); renderMatches(); renderHome(); renderAdminSemisList();
});

/* ========================= Firestore listeners ========================= */
const colPlayers = collection(db, "players");
const colMatches = collection(db, "matches");
const colPosts   = collection(db, "posts");
const colChat    = collection(db, "chat");

onSnapshot(query(colPlayers, orderBy("name")), snap=>{
  state.players = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderPlayers(); fillPlayersSelects(); renderTables(); renderPlayerSelect(); renderHome(); renderAdminSemisList();
});

onSnapshot(query(colMatches, orderBy("date")), async (snap)=>{
  const newMatches = snap.docs.map(d => ({ id:d.id, ...d.data() }));

  // anunciar vit/emp/der automaticamente (diff com prevResults)
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  for(const m of newMatches){
    const old = prevResults.get(m.id);
    const now = m.result;
    const wasFinal   = old === "A" || old === "B" || old === "draw";
    const isNowFinal = now === "A" || now === "B" || now === "draw";
    if(!wasFinal && isNowFinal){
      const aName = mapP[m.aId] || "?";
      const bName = mapP[m.bId] || "?";
      let title = "", body = "";
      if(now === "A"){ title = `Vitória de ${aName} (${m.code||""})`; body = `${aName} venceu ${bName} ${m.group?`(Grupo ${m.group}) `:""}na ${stageLabel(m.stage)}.`; }
      if(now === "B"){ title = `Vitória de ${bName} (${m.code||""})`; body = `${bName} venceu ${aName} ${m.group?`(Grupo ${m.group}) `:""}na ${stageLabel(m.stage)}.`; }
      if(now === "draw"){ title = `Empate: ${aName} × ${bName} (${m.code||""})`; body = `${aName} e ${bName} empataram ${m.group?`(Grupo ${m.group}) `:""}na ${stageLabel(m.stage)}.`; }
      try{
        await addDoc(colPosts, { title, body, createdAt: serverTimestamp(), author:"Sistema", authorEmail:"" });
      }catch{}
    }
  }
  // atualiza cache
  prevResults.clear(); newMatches.forEach(m => prevResults.set(m.id, m.result || null));

  state.matches = newMatches;
  renderMatches(); renderTables(); renderPlayerDetails(); renderHome(); renderAdminSemisList();

  autoPostponeOverdueMatches(); // adiar 24h após data
  checkAndAutoCreateSemis();    // criar semis + post quando F. Grupos terminar
});

onSnapshot(query(colPosts, orderBy("createdAt","desc")), snap=>{
  state.posts = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderPosts(); renderHome();
});

onSnapshot(query(colChat, orderBy("createdAt","desc")), snap=>{
  const now = Date.now();
  state.chat = snap.docs
    .map(d => ({ id:d.id, ...d.data() }))
    .filter(m => !m.expireAt || (m.expireAt.toDate ? m.expireAt.toDate().getTime() : new Date(m.expireAt).getTime()) > now);
  renderChat();
});

/* ========================= Lógicas de pontos ========================= */
function statsFromMatches(){
  const stats = {};
  for(const p of state.players){
    stats[p.id] = { id:p.id, name:p.name, group:p.group, points:0, wins:0, draws:0, losses:0, games:0, winsOver:{} };
  }
  for(const m of state.matches){
    if(m.stage !== "groups") continue;
    const a = stats[m.aId], b = stats[m.bId];
    if(!a || !b) continue;
    if(m.result === "A"){
      a.points+=3; a.wins++; a.games++; b.losses++; b.games++;
      a.winsOver[b.name] = (a.winsOver[b.name]||0)+1;
    }else if(m.result === "B"){
      b.points+=3; b.wins++; b.games++; a.losses++; a.games++;
      b.winsOver[a.name] = (b.winsOver[a.name]||0)+1;
    }else if(m.result === "draw"){
      a.points+=1; b.points+=1; a.draws++; b.draws++; a.games++; b.games++;
    }
  }
  return stats;
}

/* ========================= Home (4 próximas do dia) ========================= */
function renderHome(){
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const scheduled = state.matches.filter(m => !!m.date).slice();

  const today = new Date(); const s = new Date(today); s.setHours(0,0,0,0);
  const e   = new Date(today); e.setHours(23,59,59,999);
  const isSameDay = (d1,d2)=> d1.getFullYear()==d2.getFullYear() && d1.getMonth()==d2.getMonth() && d1.getDate()==d2.getDate();

  let pick = scheduled.filter(m=>{ const d = parseLocalDate(m.date); return d && d>=s && d<=e; });
  if(pick.length===0){
    let nextDay = null;
    for(const m of scheduled){
      const d = parseLocalDate(m.date);
      if(d && d > e){ nextDay = d; break; }
    }
    if(nextDay){ pick = scheduled.filter(m => { const d=parseLocalDate(m.date); return d && isSameDay(d, nextDay); }); }
  }
  pick = pick.slice(0,4);

  const rows = pick.map(m=>`
    <tr>
      <td>${stageLabel(m.stage)}</td>
      <td>${m.group || "-"}</td>
      <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
      <td>${fmtLocalDateStr(m.date)}</td>
      <td>${m.code || "-"}</td>
    </tr>
  `).join("");
  const table = `
    <table>
      <thead><tr><th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data</th><th>Código</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>Sem partidas hoje/próximo dia.</td></tr>"}</tbody>
    </table>`;
  $("#home-next") && ($("#home-next").innerHTML = table);

  const posts = state.posts.slice(0,3).map(p=> renderPostItem(p)).join("");
  if($("#home-posts")) {
    $("#home-posts").innerHTML = posts || `<p class="muted">Sem comunicados.</p>`;
    if (state.admin) {
      document.querySelectorAll("#home-posts .btn-del-post").forEach(b=>{
        b.onclick = async ()=>{
          if(!(await confirmAction("Apagar este comunicado?"))) return;
          await deleteDoc(doc(db,"posts", b.dataset.id));
        };
      });
    }
  }
}

/* ========================= Players ========================= */
function renderPlayers(){
  const stats = statsFromMatches();
  const byGroup = { A:[], B:[] };
  for(const p of state.players){
    const s = stats[p.id];
    const initials = (p.name||"?").split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase();
    const card = `
      <div class="player-card" data-id="${p.id}">
        <div class="avatar">${initials}</div>
        <div class="player-meta">
          <div class="name">${p.name} <span class="badge-small">Grupo ${p.group}</span></div>
          <div class="muted">Pts: <b>${s.points}</b> · J:${s.games} · V:${s.wins} · E:${s.draws} · D:${s.losses}</div>
        </div>
      </div>`;
    (byGroup[p.group] || byGroup.A).push(card);
  }
  $("#players-cards-A") && ($("#players-cards-A").innerHTML = byGroup.A.join("") || `<p class="muted">Sem jogadores.</p>`);
  $("#players-cards-B") && ($("#players-cards-B").innerHTML = byGroup.B.join("") || `<p class="muted">Sem jogadores.</p>`);

  $$("#players-cards-A .player-card, #players-cards-B .player-card").forEach(c=>{
    c.onclick = ()=>{
      $$(".player-card").forEach(x=>x.classList.remove("selected"));
      c.classList.add("selected");
      const id = c.dataset.id;
      const sel = $("#player-select");
      if(sel){ sel.value = id; renderPlayerDetails(); }
      showTab("players");
    };
  });
}
$("#player-search-btn")?.addEventListener("click", ()=>{
  const q = ($("#player-search")?.value||"").toLowerCase();
  const found = state.players.find(p => p.name.toLowerCase().includes(q));
  if(found){
    const sel = $("#player-select"); if(sel){ sel.value = found.id; renderPlayerDetails(); }
    $$(".player-card").forEach(x=>x.classList.toggle("selected", x.dataset.id===found.id));
  }else{
    alert("Jogador não encontrado.");
  }
});

function renderPlayerSelect(){
  const sel = $("#player-select"); if(!sel) return;
  sel.innerHTML = "";
  option(sel, "", "— selecione —");
  state.players.forEach(p => option(sel, p.id, p.name));
  sel.onchange = renderPlayerDetails;
}
function renderPlayerDetails(){
  const sel = $("#player-select"); if(!sel) return;
  const id = sel.value;
  const box = $("#player-details"); if(!box) return;
  if(!id){ box.innerHTML = `<p class="muted">Selecione um jogador para ver detalhes.</p>`; return; }
  const stats = statsFromMatches();
  const s = stats[id];
  if(!s){ box.innerHTML = `<p class="muted">Sem dados.</p>`; return; }
  const wins = Object.entries(s.winsOver).map(([name,c])=>`<span class="pill">Venceu ${name} ×${c}</span>`).join("") || "<span class='muted'>Sem vitórias registradas.</span>";
  box.innerHTML = `
    <p><b>${s.name}</b> — Grupo ${s.group}</p>
    <p>Pontos: <b>${s.points}</b> · Jogos: <b>${s.games}</b> · V: <b>${s.wins}</b> · E: <b>${s.draws}</b> · D: <b>${s.losses}</b></p>
    <div>${wins}</div>
  `;
}

/* ========================= Tabela ========================= */
function renderTables(){
  const stats = statsFromMatches();
  const groups = {A:[], B:[]};
  for(const id in stats){ const s = stats[id]; (groups[s.group]||[]).push(s); }
  ["A","B"].forEach(g=>{
    const arr = (groups[g]||[]).sort((x,y)=>{
      if(y.points!==x.points) return y.points - x.points;
      if(y.wins!==x.wins) return y.wins - x.wins;
      return x.name.localeCompare(y.name);
    });
    const rows = arr.map((s,i)=>`
      <tr class="pos-${i+1}">
        <td>${i+1}</td>
        <td>${s.name}</td>
        <td>${s.points}</td>
        <td>${s.games}</td>
        <td>${s.wins}</td>
        <td>${s.draws}</td>
        <td>${s.losses}</td>
      </tr>`).join("");
    const html = `
      <table>
        <thead><tr>
          <th>#</th><th>Jogador</th><th>Pts</th><th>J</th><th>V</th><th>E</th><th>D</th>
        </tr></thead>
        <tbody>${rows || ""}</tbody>
      </table>`;
    const box = $(`#table-${g}`); if(box) box.innerHTML = html;
  });
}

/* ========================= Partidas ========================= */
function renderMatches(){
  const stageF = $("#filter-stage")?.value || "all";
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));

  let arr = state.matches.slice();
  if(stageF !== "all") arr = arr.filter(m => m.stage === stageF);

  const gA = arr.filter(m => m.stage==="groups" && m.group==="A");
  const gB = arr.filter(m => m.stage==="groups" && m.group==="B");
  const ko = arr.filter(m => m.stage!=="groups");

  const makeTable = (items)=>`
    <table>
      <thead><tr><th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data/Hora</th><th>Código</th><th>Resultado</th>${state.admin?`<th>Ações</th>`:""}</tr></thead>
      <tbody>
        ${items.map(m=>{
          const res = m.result==="A" ? mapP[m.aId]
                  : m.result==="B" ? mapP[m.bId]
                  : m.result==="draw" ? "Empate"
                  : m.result==="postponed" ? "Adiado"
                  : "Pendente";
          return `<tr data-id="${m.id}">
            <td>${stageLabel(m.stage)}</td>
            <td>${m.group||"-"}</td>
            <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
            <td>${fmtLocalDateStr(m.date)}</td>
            <td>${m.code||"-"}</td>
            <td>${res}</td>
            ${state.admin?`<td><button class="btn ghost btn-edit" data-id="${m.id}">Editar</button></td>`:""}
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;

  const html = `
    <div class="card" style="margin-bottom:12px">
      <h3>Fase de Grupos – Grupo A</h3>
      <div class="table">${makeTable(gA)}</div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <h3>Fase de Grupos – Grupo B</h3>
      <div class="table">${makeTable(gB)}</div>
    </div>
    <div class="card">
      <h3>Mata-mata (Semifinais/Final/3º)</h3>
      <div class="table">${makeTable(ko)}</div>
    </div>
  `;
  const box = $("#matches-list");
  if(box){
    box.innerHTML = html;
    if(state.admin){
      $$(".btn-edit").forEach(b => b.onclick = () => loadMatchToForm(b.dataset.id));
    }
  }
}
$("#filter-stage")?.addEventListener("change", renderMatches);

/* ===== Adiamento automático (24h após a data) ===== */
async function autoPostponeOverdueMatches(){
  if(!state.admin) return;
  const now = Date.now();
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const tasks = [];

  for(const m of state.matches){
    if(!m?.date) continue;
    if(m?.result) continue; // já decidido
    const due = (parseLocalDate(m.date)?.getTime() || 0) + 24*60*60*1000;
    if(now >= due){
      tasks.push(runTransaction(db, async (tx)=>{
        const ref = doc(db,"matches", m.id);
        const snap = await tx.get(ref);
        if(!snap.exists()) return;
        const cur = snap.data();
        if(cur.result) return;
        if(cur.postponedNotice) return;

        tx.update(ref, {
          result: "postponed",
          postponedAt: serverTimestamp(),
          postponedNotice: true
        });

        const postsRef = doc(collection(db,"posts"));
        const aName = mapP[cur.aId] || "?";
        const bName = mapP[cur.bId] || "?";
        const title = `Partida adiada: ${aName} × ${bName}`;
        const body  = `A partida ${cur.code ? `(${cur.code}) ` : ""}${aName} × ${bName}, marcada para ${fmtLocalDateStr(cur.date)}, foi automaticamente marcada como **ADIADA** por falta de atualização do resultado após 24 horas. Favor remarcar com a organização.`;
        tx.set(postsRef, { title, body, createdAt: serverTimestamp(), author: "Sistema", authorEmail: "" });
      }));
    }
  }
  if(tasks.length) await Promise.allSettled(tasks);
}

/* ===== Semifinais automáticas ao concluir F. Grupos + post ===== */
async function checkAndAutoCreateSemis(){
  // precisa estar tudo concluído na F. Grupos (A/B/draw); 'postponed' NÃO conta
  const groupMatches = state.matches.filter(m => m.stage==="groups");
  if(groupMatches.length === 0) return;

  const allDone = groupMatches.every(m => ["A","B","draw"].includes(m.result));
  if(!allDone) return;

  const existingSemis = state.matches.filter(m => m.stage==="semifinal");
  if(existingSemis.length >= 2) return; // já existem

  // monta top-2 por grupo
  const stats = statsFromMatches();
  const byGroup = { A:[], B:[] };
  Object.values(stats).forEach(s => (byGroup[s.group]||[]).push(s));
  const sort = a=>a.sort((x,y)=> y.points-x.points || y.wins-x.wins || x.name.localeCompare(y.name));
  sort(byGroup.A); sort(byGroup.B);
  const a1 = byGroup.A[0], a2 = byGroup.A[1], b1 = byGroup.B[0], b2 = byGroup.B[1];
  if(!(a1 && a2 && b1 && b2)) return;

  // cria semis + post
  const pairs = [
    { a:a1.id, b:b2.id, code:"SF-1" },
    { a:b1.id, b:a2.id, code:"SF-2" },
  ];
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  for(const p of pairs){
    await addDoc(collection(db,"matches"), {
      aId:p.a, bId:p.b, stage:"semifinal", date:null, group:null, code:p.code, result:null
    });
  }
  const title = `Semifinais definidas`;
  const body  = `Semifinal 1: ${mapP[a1.id]} × ${mapP[b2.id]} (SF-1)\nSemifinal 2: ${mapP[b1.id]} × ${mapP[a2.id]} (SF-2). Boa sorte!`;
  await addDoc(collection(db,"posts"), { title, body, createdAt: serverTimestamp(), author:"Sistema", authorEmail:"" });
}

/* ========================= Admin: Players ========================= */
function option(el, value, label){ const o=document.createElement("option"); o.value=value; o.textContent=label; el.appendChild(o); }
function fillPlayersSelects(){
  const selects = ["match-a","match-b","semi1-a","semi1-b","semi2-a","semi2-b"];
  selects.forEach(id=>{
    const el = $("#"+id);
    if(!el) return;
    el.innerHTML = "";
    option(el, "", "— selecione —");
    state.players.forEach(p => option(el, p.id, `${p.name} (${p.group})`));
  });
  const listSel = $("#player-select");
  if(listSel && !listSel.value) renderPlayerSelect();
}
$("#player-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  const id = $("#player-id").value;
  const data = { name: $("#player-name").value.trim(), group: $("#player-group").value };
  try{
    if(id) await updateDoc(doc(db,"players",id), data);
    else await addDoc(collection(db,"players"), data);
    $("#player-form").reset(); $("#player-id").value = "";
  }catch(err){ alert("Erro: "+err.message); }
});
$("#player-reset")?.addEventListener("click", ()=>{ $("#player-form").reset(); $("#player-id").value = ""; });
$("#player-delete")?.addEventListener("click", async ()=>{
  const id = $("#player-id").value;
  if(!id) return;
  if(!(await confirmAction("Excluir jogador?"))) return;
  await deleteDoc(doc(db,"players",id));
  $("#player-form").reset(); $("#player-id").value = "";
});

/* ========================= Admin: Matches ========================= */
async function loadMatchToForm(id){
  const m = state.matches.find(x=>x.id===id);
  if(!m) return;

  $("#match-id").value = m.id;
  $("#match-a").value = m.aId || "";
  $("#match-b").value = m.bId || "";
  $("#match-stage").value = m.stage || "groups";
  $("#match-group").value = m.group || "";
  $("#match-date").value = m.date || "";
  $("#match-date-orig").value = m.date || "";
  $("#match-date").dataset.dirty = "false";
  $("#match-date").oninput = ()=> $("#match-date").dataset.dirty = "true";
  $("#match-code").value = m.code || "";
  $("#match-result").value = m.result || "";

  showTab("partidas");
  ensureAndScrollToManage();
}
$("#match-reset")?.addEventListener("click", ()=>{ $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false"; });
$("#match-delete")?.addEventListener("click", async ()=>{
  const id = $("#match-id").value;
  if(!id) return;
  if(!(await confirmAction("Excluir partida?"))) return;
  await deleteDoc(doc(db,"matches",id));
  $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false";
});
$("#match-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  const payload = {
    aId: $("#match-a").value,
    bId: $("#match-b").value,
    stage: $("#match-stage").value,
    group: $("#match-group").value || null,
    code: $("#match-code").value || null,
    result: $("#match-result").value || null
  };
  const isEdit = !!$("#match-id").value;
  const dateDirty = $("#match-date").dataset.dirty === "true";
  const dateVal = $("#match-date").value || null;
  if(!isEdit){ payload.date = dateVal; }
  else if(dateDirty){ payload.date = dateVal; }

  try{
    const id = $("#match-id").value;
    if(id) await updateDoc(doc(db,"matches",id), payload);
    else await addDoc(collection(db,"matches"), payload);
    $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false";
  }catch(err){ alert("Erro: "+err.message); }
});

/* ========================= Posts ========================= */
$("#post-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  const title = $("#post-title").value.trim();
  const body  = $("#post-body").value.trim();
  try{
    await addDoc(collection(db,"posts"), {
      title, body,
      createdAt: serverTimestamp(),
      author: state.profile?.displayName || auth.currentUser?.displayName || auth.currentUser?.email || "admin",
      authorEmail: auth.currentUser?.email || ""
    });
    $("#post-form").reset();
  }catch(err){ alert("Erro ao publicar: "+err.message); }
});
function renderPostItem(p){
  const by = `${p.authorEmail || ""} — ${p.author || ""}`;
  return `
    <div class="post" data-id="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <h3>${p.title}</h3>
          <p class="muted" style="margin-top:-6px">${by} · ${fmtTS(p.createdAt)}</p>
          <p>${(p.body||"").replace(/\n/g,"<br>")}</p>
        </div>
        ${state.admin ? `<button class="btn danger small btn-del-post" data-id="${p.id}">Apagar</button>` : ""}
      </div>
    </div>
  `;
}
function renderPosts(){
  const html = state.posts.map(renderPostItem).join("");
  if($("#posts-list")) {
    $("#posts-list").innerHTML = html || `<p class="muted">Sem comunicados.</p>`;
    if(state.admin){
      $$(".btn-del-post").forEach(b=>{
        b.onclick = async ()=>{
          if(!(await confirmAction("Apagar este comunicado?"))) return;
          await deleteDoc(doc(db,"posts", b.dataset.id));
        };
      });
    }
  }
}

/* ========================= Chat ========================= */
$("#chat-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!auth.currentUser){ alert("Entre para enviar mensagens."); return; }
  const text = $("#chat-text").value.trim();
  if(!text) return;
  const expireAt = new Date(Date.now() + 24*60*60*1000);
  await addDoc(collection(db,"chat"), {
    text,
    author: state.profile?.displayName || auth.currentUser.displayName || auth.currentUser.email,
    authorEmail: auth.currentUser?.email || "",
    username: state.profile?.username || null,
    createdAt: serverTimestamp(),
    expireAt
  });
  $("#chat-text").value = "";
});
function renderChat(){
  const html = state.chat.map(m=>{
    const who = m.username ? `${m.author} (@${m.username})` : m.author;
    const by  = `${m.authorEmail || ""} — ${who}`;
    return `<div class="chat-item" data-id="${m.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div>
          <div class="meta">${by} · ${fmtTS(m.createdAt)}</div>
          <div>${(m.text||"").replace(/\n/g,"<br>")}</div>
        </div>
        ${state.admin ? `<button class="btn danger small btn-del-chat" data-id="${m.id}">Apagar</button>` : ""}
      </div>
    </div>`;
  }).join("");
  if($("#chat-list")) {
    $("#chat-list").innerHTML = html || `<p class="muted">Sem mensagens nas últimas 24h.</p>`;
    if(state.admin){
      $$(".btn-del-chat").forEach(b=>{
        b.onclick = async ()=>{
          if(!(await confirmAction("Apagar esta mensagem do chat?"))) return;
          await deleteDoc(doc(db,"chat", b.dataset.id));
        };
      });
    }
  }
}

/* ========================= Perfil ========================= */
function renderProfile(){
  if(!$("#profile-form")) return;
  const u = state.user;
  $("#profile-email").value = u?.email || "";
  $("#profile-name").value = (state.profile?.displayName) || (u?.displayName) || "";
  const userTag = state.profile?.username ? `@${state.profile.username}` : "—";
  const el = $("#profile-username");
  if(el) el.textContent = userTag;
}

/* ========================= Admin: Semifinais ========================= */
$("#semi-autofill")?.addEventListener("click", ()=>{
  const stats = statsFromMatches();
  const groups = {A:[], B:[]};
  for(const id in stats){ const s=stats[id]; (groups[s.group]||[]).push(s); }
  const sort = a=>a.sort((x,y)=> y.points-x.points || y.wins-x.wins || x.name.localeCompare(y.name));
  sort(groups.A); sort(groups.B);
  const a1 = groups.A[0], a2 = groups.A[1], b1 = groups.B[0], b2 = groups.B[1];
  if(a1 && b2){ $("#semi1-a").value = a1.id; $("#semi1-b").value = b2.id; }
  if(b1 && a2){ $("#semi2-a").value = b1.id; $("#semi2-b").value = a2.id; }
  alert("Semifinais preenchidas pelos Top 2 (não criou ainda; clique em Criar Semifinais).");
});
$("#semi-save")?.addEventListener("click", async ()=>{
  const pairs = [
    { a: $("#semi1-a").value, b: $("#semi1-b").value, code: $("#semi-code").value ? $("#semi-code").value+"-1" : "SF-1" },
    { a: $("#semi2-a").value, b: $("#semi2-b").value, code: $("#semi-code").value ? $("#semi-code").value+"-2" : "SF-2" },
  ];
  for(const p of pairs){
    if(!p.a || !p.b) continue;
    await addDoc(collection(db,"matches"), { aId:p.a, bId:p.b, stage:"semifinal", date:null, group:null, code:p.code, result:null });
  }
  alert("Semifinais criadas. Ajuste datas/resultados em Partidas.");
});
function renderAdminSemisList(){
  const list = state.matches.filter(m=> m.stage==="semifinal");
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const rows = list.map(m=>`
    <tr>
      <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
      <td>${fmtLocalDateStr(m.date)}</td>
      <td>${m.code||"-"}</td>
      <td>${m.result||"Pendente"}</td>
    </tr>
  `).join("");
  const html = `
    <table>
      <thead><tr><th>Semifinal</th><th>Data</th><th>Código</th><th>Resultado</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='4'>Nenhuma semifinal cadastrada.</td></tr>"}</tbody>
    </table>`;
  $("#semi-list") && ($("#semi-list").innerHTML = html);
}

/* ========================= Admin: Reset Torneio ========================= */
$("#btn-reset-tournament")?.addEventListener("click", async ()=>{
  if(!state.admin) return alert("Apenas admins.");
  if(!(await confirmAction("Tem certeza que deseja RESETAR o torneio? (apaga partidas, posts e chat)"))) return;

  async function wipe(colName){
    const snap = await getDocs(collection(db, colName));
    const ops = snap.docs.map(d => deleteDoc(doc(db, colName, d.id)));
    await Promise.allSettled(ops);
  }
  try{
    await wipe("matches");
    await wipe("posts");
    await wipe("chat");
    alert("Torneio resetado! (Players foram mantidos)");
  }catch(err){
    alert("Erro ao resetar: " + err.message);
  }
});

/* ========================= Seed (Admin) ========================= */
$("#seed-btn")?.addEventListener("click", async ()=>{
  if(!state.admin){ alert("Apenas admins."); return; }
  if(!(await confirmAction("Adicionar dados de exemplo?"))) return;

  // players
  const players = [
    ["Hugo","A"],["Eudison","A"],["Rhuan","A"],["Luís Felipe","A"],["Yuri","A"],
    ["Kelvin","B"],["Marcos","B"],["Davi","B"],["Alyson","B"],["Wemerson","B"]
  ];
  const nameToId = {};
  for(const [name,group] of players){
    const q = await getDocs(query(collection(db,"players"), where("name","==",name)));
    if(q.empty){ nameToId[name] = (await addDoc(collection(db,"players"),{name,group})).id; }
    else { nameToId[name] = q.docs[0].id; }
  }

  // gera string local "YYYY-MM-DDTHH:mm"
  const pad = n => String(n).padStart(2,"0");
  function localStrPlusHours(h){
    const d = new Date(); d.setHours(d.getHours()+h);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const roundsA = [
    ["Eudison","Yuri"],["Rhuan","Luís Felipe"],
    ["Hugo","Yuri"],["Eudison","Rhuan"],
    ["Hugo","Luís Felipe"],["Yuri","Rhuan"],
    ["Hugo","Rhuan"],["Luís Felipe","Eudison"],
    ["Hugo","Eudison"],["Luís Felipe","Yuri"]
  ];
  const roundsB = [
    ["Marcos","Wemerson"],["Davi","Alyson"],
    ["Kelvin","Wemerson"],["Marcos","Davi"],
    ["Kelvin","Alyson"],["Wemerson","Davi"],
    ["Kelvin","Davi"],["Alyson","Marcos"],
    ["Kelvin","Marcos"],["Alyson","Wemerson"]
  ];

  let i=0;
  for(const [a,b] of roundsA){
    await addDoc(collection(db,"matches"),{
      aId:nameToId[a], bId:nameToId[b], stage:"groups", group:"A",
      date: localStrPlusHours(i++), code:`GA-${i}`, result:null
    });
  }
  for(const [a,b] of roundsB){
    await addDoc(collection(db,"matches"),{
      aId:nameToId[a], bId:nameToId[b], stage:"groups", group:"B",
      date: localStrPlusHours(i++), code:`GB-${i}`, result:null
    });
  }

  await addDoc(collection(db,"posts"), { title:"Bem-vindos!", body:"Início do campeonato. Boa sorte a todos!", createdAt: serverTimestamp(), author: auth.currentUser?.displayName || auth.currentUser?.email || "admin", authorEmail: auth.currentUser?.email || "" });
  await addDoc(collection(db,"posts"), { title:"Regras", body:"Pontuação 3-1-0 (fase de grupos). Top-2 avança (G2).", createdAt: serverTimestamp(), author: auth.currentUser?.displayName || auth.currentUser?.email || "admin", authorEmail: auth.currentUser?.email || "" });

  const expireAt = new Date(Date.now() + 24*60*60*1000);
  await addDoc(collection(db,"chat"), { text:"Chat aberto! Respeito e esportividade. ♟️", author: auth.currentUser?.displayName || auth.currentUser?.email || "admin", authorEmail: auth.currentUser?.email || "", username: state.profile?.username || null, createdAt: serverTimestamp(), expireAt });

  alert("Seed concluído!");
});
