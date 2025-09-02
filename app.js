// app.js — Champions Chess IFMA (versão ajustada)

/* ========= IMPORTS ========= */
import {
  app,
  auth, db,
  loginWithGoogle, logout, watchAuth, setDisplayName,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp, runTransaction
} from "./firebase.js";

/* ========= HELPERS ========= */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function confirmAction(msg){ return window.confirm(msg); }

function slugifyName(name){
  return (name||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,20)||"user";
}
function shortUid(uid){ return (uid||"").slice(-4)||Math.floor(Math.random()*9999).toString().padStart(4,"0"); }

function stageLabel(s){
  switch((s||"").toLowerCase()){
    case "groups": return "F. Grupos";
    case "semifinal": return "Semifinal";
    case "final": return "Final";
    case "third": return "3º Lugar";
    default: return s||"—";
  }
}

function parseLocalDate(str){
  if(!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([Zz]|[+\-]\d{2}:\d{2})?$/.exec(str);
  if(m){
    if(m[7]){ const d=new Date(str); return isNaN(d)?null:d; }
    return new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0),0);
  }
  const d = new Date(str); return isNaN(d)?null:d;
}
const fmtLocalDateStr = s => { const d=parseLocalDate(s); return d?d.toLocaleString("pt-BR"):"—"; };
const fmtTS = ts => { try{ const d=ts?.toDate?ts.toDate():(ts instanceof Date?ts:(ts?new Date(ts):null)); return d?d.toLocaleString("pt-BR"):"—"; }catch{ return "—"; } };
const clamp = (x,min,max)=> Math.max(min, Math.min(max, x));

/* ========= NAV / TABS ========= */
function showTab(id){
  if(!id) id = "home";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".view").forEach(v => v.classList.toggle("visible", v.id === id));
  if(location.hash.replace("#","") !== id) location.hash = id;
  window.scrollTo({ top: 0, behavior: "auto" });
}
window.addEventListener("hashchange", ()=> showTab(location.hash.replace("#","") || "home"));
$$(".tab").forEach(b => b.addEventListener("click", (e)=>{ e.preventDefault(); showTab(b.dataset.tab); }));
// Esconde a aba "Perfil" se ainda existir no HTML
const perfilTabBtn = document.querySelector('.tab[data-tab="perfil"]');
if(perfilTabBtn) perfilTabBtn.style.display = "none";
showTab(location.hash.replace("#","") || "home");

// “nome do usuário na navbar” abre Perfil:
$("#user-chip")?.addEventListener("click", () => showTab("perfil"));

// delegação global “Abrir perfil” em botões/links data-open-profile
document.addEventListener("click", (ev)=>{
  const btn = ev.target.closest("[data-open-profile]");
  if(btn){
    const id = btn.getAttribute("data-open-profile");
    if(id) openPlayerProfile(id);
  }
});

/* ========= STATE ========= */
let state = {
  user:null, admin:false, profile:null,
  players:[], matches:[], posts:[], chat:[],
  bets:[], wallets:[]
};
const prevResults = new Map();

/* ========= ADMIN ========= */
async function refreshAdminStatus(){
  let ok = false;
  if(auth.currentUser){
    try{
      const tok = await auth.currentUser.getIdTokenResult(true);
      ok = !!tok.claims?.admin;
    }catch{}
    if(!ok){
      const snap = await getDoc(doc(db,"admins",auth.currentUser.uid));
      ok = snap.exists() && !!snap.data().active;
    }
  }
  setAdminFlag(ok);
  return ok;
}
function setAdminFlag(flag){
  const changed = state.admin !== flag;
  state.admin = flag;
  $("#admin-badge")?.classList.toggle("hidden", !flag);
  $("#tab-admin")?.classList.toggle("hidden", !flag);
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !flag));
  if(changed){ renderPosts(); renderChat(); renderMatches(); renderHome(); renderAdminSemisList(); }
}
async function requireAdmin(){
  const ok = await refreshAdminStatus();
  if(!ok) alert("Ação restrita ao admin.");
  return ok;
}

/* ========= AUTH / PERFIL ========= */
async function loadProfile(uid){
  if(!uid){ state.profile=null; return renderProfile(); }
  const snap = await getDoc(doc(db,"profiles",uid));
  state.profile = snap.exists()?snap.data():null;
  renderProfile();
}
function renderProfile(){
  if(!state.user){
    $("#profile-email") && ($("#profile-email").value = "");
    $("#profile-name") && ($("#profile-name").value = "");
    $("#profile-username") && ($("#profile-username").textContent = "—");
    return;
  }
  $("#profile-email") && ($("#profile-email").value = state.user.email || "");
  $("#profile-name") && ($("#profile-name").value = state.profile?.displayName || state.user.displayName || "");
  $("#profile-username") && ($("#profile-username").textContent = state.profile?.username || "—");
}

$("#btn-open-login")?.addEventListener("click", async ()=>{ try{ await loginWithGoogle(); }catch(e){ alert("Erro: "+e.message); } });
$("#btn-logout")?.addEventListener("click", async ()=>{ await logout(); });

$("#profile-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!state.user) return alert("Entre para editar o perfil.");
  const display = $("#profile-name").value.trim();
  const base = slugifyName(display);
  const fallback = `${base}-${shortUid(state.user.uid)}`;
  try{
    await runTransaction(db, async tx=>{
      const uid = state.user.uid;
      const profRef = doc(db,"profiles",uid);
      const profSnap = await tx.get(profRef);
      const oldUsername = profSnap.exists()? (profSnap.data().username||null) : null;

      const tryRef = doc(db,"usernames",base);
      const trySnap = await tx.get(tryRef);
      let chosen = base, fbRef=null, fbSnap=null;
      if(trySnap.exists()){
        chosen=fallback;
        fbRef=doc(db,"usernames",chosen);
        fbSnap=await tx.get(fbRef);
        if(fbSnap.exists()) throw new Error("USERNAME_TAKEN_FALLBACK");
      }

      let oldRef=null, oldSnap=null;
      if(oldUsername){ oldRef=doc(db,"usernames",oldUsername); oldSnap=await tx.get(oldRef); }

      if(oldRef && oldSnap?.exists() && oldSnap.data().uid===uid) tx.delete(oldRef);
      if(chosen===base) tx.set(tryRef,{uid,createdAt:serverTimestamp()});
      else tx.set(fbRef,{uid,createdAt:serverTimestamp()});

      tx.set(profRef,{displayName:display,username:chosen,email:state.user.email,updatedAt:serverTimestamp()},{merge:true});
    });
    await setDisplayName(state.user, display);
    await loadProfile(state.user.uid);
    alert("Perfil atualizado!");
  }catch(err){
    alert(err.message==="USERNAME_TAKEN_FALLBACK" ? "Não foi possível reservar um username único." : "Erro ao salvar perfil: "+err.message);
  }
});

// carteira inicial 6 pts para quem loga
async function ensureWalletInit(uid){
  if(!uid) return;
  const refWal = doc(db, "wallets", uid);
  await runTransaction(db, async (tx)=>{
    const snap = await tx.get(refWal);
    if(!snap.exists()){
      tx.set(refWal, { points: 6, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }else{
      const cur = snap.data() || {};
      if(typeof cur.points !== "number"){
        tx.update(refWal, { points: 6, updatedAt: serverTimestamp() });
      }
    }
  });
}

watchAuth(async (user)=>{
  state.user=user;

  $("#btn-open-login")?.classList.toggle("hidden",!!user);
  $("#btn-logout")?.classList.toggle("hidden",!user);
  $("#user-chip")?.classList.toggle("hidden",!user);
  if($("#user-email")) $("#user-email").textContent = user ? (user.displayName||user.email) : "";

  $("#chat-form")?.classList.toggle("hidden",!user);
  $("#chat-login-hint")?.classList.toggle("hidden",!!user);

  // apostas só para logados (desabilita o form visivelmente)
  const betForm = $("#bet-form");
  if(betForm){
    betForm.querySelectorAll("select,button,input").forEach(el => el.disabled = !user);
    betForm.style.opacity = user ? "1" : ".6";
  }

  await loadProfile(user?.uid||null);
  await refreshAdminStatus();

  if (user) { await ensureWalletInit(user.uid); }

  renderPosts(); renderChat(); renderMatches(); renderHome(); renderAdminSemisList();
  if(user) initRealtimeChat();

  // preencher ainda mais o bloco “Bem-vindo...” (complemento de texto)
  enrichHomeWelcomeBlock();
});

/* ========= COLLECT ========== */
const colPlayers = collection(db,"players");
const colMatches = collection(db,"matches");
const colPosts   = collection(db,"posts");
const colBets    = collection(db,"bets");
const colWallets = collection(db,"wallets");

/* ========= SNAPSHOTS ========= */
onSnapshot(query(colPlayers, orderBy("name")), snap=>{
  state.players = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPlayers(); fillPlayersSelects(); renderTables(); renderPlayerSelect(); renderHome(); renderAdminSemisList();
  populateBetOptions();
});

onSnapshot(query(colMatches, orderBy("date")), async snap=>{
  const newMatches = snap.docs.map(d=>({id:d.id,...d.data()}));

  // anúncio de resultado (anti-duplicado) — só admin
  if(await refreshAdminStatus()){
    const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
    for(const m of newMatches){
      const isFinal = ["A","B","draw"].includes(m.result);
      if(!isFinal) continue;
      if(m.resultAnnounced) continue;
      try{
        await runTransaction(db, async tx=>{
          const ref=doc(db,"matches",m.id);
          const curSnap=await tx.get(ref);
          if(!curSnap.exists()) return;
          const cur=curSnap.data();
          if(!["A","B","draw"].includes(cur.result) || cur.resultAnnounced) return;

          const aName = mapP[cur.aId]||"?";
          const bName = mapP[cur.bId]||"?";
          let title="", body="";
          if(cur.result==="A"){ title=`Vitória de ${aName} (${cur.code||""})`; body=`${aName} venceu ${bName} ${cur.group?`(Grupo ${cur.group}) `:""}na ${stageLabel(cur.stage)}.`; }
          if(cur.result==="B"){ title=`Vitória de ${bName} (${cur.code||""})`; body=`${bName} venceu ${aName} ${cur.group?`(Grupo ${cur.group}) `:""}na ${stageLabel(cur.stage)}.`; }
          if(cur.result==="draw"){ title=`Empate: ${aName} × ${bName} (${cur.code||""})`; body=`${aName} e ${bName} empataram ${cur.group?`(Grupo ${cur.group}) `:""}na ${stageLabel(cur.stage)}.`; }

          tx.update(ref,{ resultAnnounced:true, resultAnnouncedAt:serverTimestamp() });
          const postRef = doc(collection(db,"posts"));
          tx.set(postRef,{ title, body, createdAt:serverTimestamp(), author:"Sistema", authorEmail:"" });
        });
      }catch{}
    }
  }

  prevResults.clear(); newMatches.forEach(m=>prevResults.set(m.id,m.result||null));

  state.matches = newMatches;
  renderMatches(); renderTables(); renderPlayers(); renderPlayerDetails(); renderHome(); renderAdminSemisList();
  populateBetOptions();

  if(state.admin){
    await autoPostponeOverdueMatches();  // adia só a vencida (24h)
    await checkAndAutoCreateSemis();     // cria semis quando grupos acabam
    await settleFinishedMatchesBets();   // liquida apostas
  }
});

onSnapshot(query(colPosts, orderBy("createdAt","desc")), snap=>{
  state.posts = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPosts(); renderHome();
});

onSnapshot(query(colBets, orderBy("createdAt","desc")), snap=>{
  state.bets = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderBets();
});
onSnapshot(colWallets, snap=>{
  state.wallets = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderWallet();
});

/* ========= STATS / TABLES ========= */
function statsFromMatches(){
  const stats={};
  for(const p of state.players){ stats[p.id]={ id:p.id, name:p.name, group:p.group, points:0, wins:0, draws:0, losses:0, games:0, winsOver:{} }; }
  for(const m of state.matches){
    if(m.stage!=="groups") continue;
    const a=stats[m.aId], b=stats[m.bId]; if(!a||!b) continue;
    if(m.result==="A"){ a.points+=3; a.wins++; a.games++; b.losses++; b.games++; a.winsOver[b.name]=(a.winsOver[b.name]||0)+1; }
    else if(m.result==="B"){ b.points+=3; b.wins++; b.games++; a.losses++; a.games++; b.winsOver[a.name]=(b.winsOver[a.name]||0)+1; }
    else if(m.result==="draw"){ a.points+=1; b.points+=1; a.draws++; b.draws++; a.games++; b.games++; }
  }
  return stats;
}

/* ========= HOME ========= */
function enrichHomeWelcomeBlock(){
  // Enche mais o texto do bloco “Bem-vindo...” sem mexer no HTML
  const welcomeH2 = $("#home .card h2");
  if(!welcomeH2 || !/Bem-vindo/i.test(welcomeH2.textContent)) return;
  const card = welcomeH2.closest(".card");
  const list = card?.querySelector(".list");
  if(!list) return;
  // adiciona detalhes extras (se ainda não inseridos)
  if(!card.dataset.enriched){
    list.insertAdjacentHTML("beforeend", `
      <li><b>Transmissão e registros:</b> sempre que possível, publicar prints e comentários em <i>Post</i> e no <i>Chat</i>;</li>
      <li><b>Fair play:</b> uso de motores durante a partida é proibido; dúvidas com a organização;</li>
      <li><b>Apostas:</b> cada usuário começa com <b>6 pontos</b> na carteira e pode palpitar antes do horário da partida;</li>
      <li><b>Probabilidades:</b> calculadas por votos + desempenho anterior, e mostradas em <i>Partidas</i> e na Home;</li>
      <li><b>Semifinais:</b> definidas automaticamente quando a Fase de Grupos concluir; anúncios saem em <i>Post</i>.</li>
    `);
    card.dataset.enriched = "1";
  }
}

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

  const rows=pick.map(m=>{
    const { probs } = computeProbabilitiesAndOdds(m);
    const A = clamp(probs.A,0,100), B = clamp(probs.B,0,100), D = clamp(probs.D,0,100);
    const prob = `<span class="prob-pill" title="V(A): vitória do Jogador A · E: empate · V(B): vitória do Jogador B">
      V(A) ${A}% · E ${D}% · V(B) ${B}%
    </span>`;
    return `<tr>
      <td>${stageLabel(m.stage)}</td>
      <td>${m.group||"-"}</td>
      <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"} ${prob}</td>
      <td>${fmtLocalDateStr(m.date)}</td>
      <td>${m.code||"-"}</td>
    </tr>`;
  }).join("");

  const table=`<table style="font-size:13px; line-height:1.25">
    <thead><tr><th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data</th><th>Código</th></tr></thead>
    <tbody>${rows||"<tr><td colspan='5'>Sem partidas hoje/próximo dia.</td></tr>"}</tbody>
  </table>`;
  $("#home-next") && ($("#home-next").innerHTML=table);

  const posts = state.posts.slice(0,3).map(p=>renderPostItem(p)).join("");
  if($("#home-posts")){
    $("#home-posts").innerHTML = posts || `<p class="muted">Sem comunicados.</p>`;
    if(state.admin){
      $$("#home-posts .btn-del-post").forEach(b=>{
        b.onclick=async ()=>{ if(!(await confirmAction("Apagar este comunicado?")))return; await deleteDoc(doc(db,"posts",b.dataset.id)); };
      });
    }
  }
}

/* ========= PLAYERS / PERFIL ========= */
function renderPlayers(){
  const stats=statsFromMatches();
  const groups={A:[],B:[]};
  for(const p of state.players){
    const s=stats[p.id]; const initials=(p.name||"?").split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase();
    const card=`
      <div class="player-card" data-id="${p.id}">
        <div class="avatar">${initials}</div>
        <div class="player-meta">
          <div class="name">${p.name} <span class="badge-small">Grupo ${p.group}</span></div>
          <div class="muted">Pts:<b>${s.points}</b> · J:${s.games} · V:${s.wins} · E:${s.draws} · D:${s.losses}</div>
        </div>
      </div>`;
    (groups[p.group]||(groups.A=[])).push(card);
  }
  $("#players-cards-A") && ($("#players-cards-A").innerHTML = groups.A.join("")||`<p class="muted">Sem jogadores.</p>`);
  $("#players-cards-B") && ($("#players-cards-B").innerHTML = groups.B.join("")||`<p class="muted">Sem jogadores.</p>`);

  // clique abre perfil dedicado
  $$("#players-cards-A .player-card, #players-cards-B .player-card").forEach(c=>{
    c.onclick=()=>{ openPlayerProfile(c.dataset.id); };
  });
}
function renderPlayerSelect(){
  const sel=$("#player-select"); if(!sel) return;
  sel.innerHTML=""; const o=document.createElement("option"); o.value=""; o.textContent="— selecione —"; sel.appendChild(o);
  state.players.forEach(p=>{ const op=document.createElement("option"); op.value=p.id; op.textContent=p.name; sel.appendChild(op); });
  sel.onchange=renderPlayerDetails;
}
function buildPlayerDetailsHTML(id){
  const p=state.players.find(x=>x.id===id); const stats=statsFromMatches(); const s=stats[id];
  const history = state.matches
    .filter(m=> m.aId===id || m.bId===id)
    .map(m=>{
      const opp = m.aId===id ? state.players.find(x=>x.id===m.bId)?.name : state.players.find(x=>x.id===m.aId)?.name;
      const youWin = (m.result==="A" && m.aId===id) || (m.result==="B" && m.bId===id);
      const youDraw = m.result==="draw";
      const res = youWin? "Vitória" : youDraw? "Empate" : (["A","B"].includes(m.result)?"Derrota":"Pendente");
      return `<tr><td>${stageLabel(m.stage)} ${m.group?`/ ${m.group}`:""}</td><td>${opp||"?"}</td><td>${fmtLocalDateStr(m.date)}</td><td>${res}</td><td>${m.code||"-"}</td></tr>`;
    }).join("");
  return `
    <p><b>${s?.name||p?.name||"?"}</b> — Grupo ${p?.group||"-"}</p>
    <p>Pontos: <b>${s?.points||0}</b> · Jogos: <b>${s?.games||0}</b> · V:${s?.wins||0} · E:${s?.draws||0} · D:${s?.losses||0}</p>
    <div style="margin:6px 0 10px 0">
      ${Object.entries(s?.winsOver||{}).map(([n,c])=>`<span class="pill">Venceu ${n} ×${c}</span>`).join("") || "<span class='muted'>Sem vitórias registradas.</span>"}
    </div>
    <div style="margin-top:8px"><button class="btn" data-open-profile="${p?.id}">Abrir perfil</button></div>
    <div class="table" style="margin-top:10px">
      <table>
        <thead><tr><th>Etapa</th><th>Adversário</th><th>Data</th><th>Resultado</th><th>Código</th></tr></thead>
        <tbody>${history || "<tr><td colspan='5'>Sem partidas.</td></tr>"}</tbody>
      </table>
    </div>
  `;
}
function renderPlayerDetails(){
  const sel=$("#player-select"); if(!sel) return;
  const id = sel.value;
  const box=$("#player-details"); if(!box) return;
  if(!id){ box.innerHTML=`<p class="muted">Selecione um jogador para ver detalhes.</p>`; return; }
  box.innerHTML = buildPlayerDetailsHTML(id);
  const btn = box.querySelector("[data-open-profile]");
  if(btn) btn.addEventListener("click", ()=> openPlayerProfile(id));
}
function openPlayerProfile(id){
  const container=$("#player-profile"); if(!container){ showTab("players"); return; }
  container.innerHTML = buildPlayerProfileHTML(id);
  container.querySelectorAll("[data-back]").forEach(b=> b.onclick=()=> showTab("players"));
  location.hash = `player/${id}`;
  showTab("player-profile");
}
function buildPlayerProfileHTML(id){
  const p=state.players.find(x=>x.id===id);
  const stats=statsFromMatches(); const s=stats[id] || {points:0,games:0,wins:0,draws:0,losses:0,name:p?.name};
  const initials=(p?.name||"?").split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase();

  const history = state.matches
    .filter(m=> m.aId===id || m.bId===id)
    .map(m=>{
      const opp = m.aId===id ? state.players.find(x=>x.id===m.bId)?.name : state.players.find(x=>x.id===m.aId)?.name;
      const youWin = (m.result==="A" && m.aId===id) || (m.result==="B" && m.bId===id);
      const youDraw = m.result==="draw";
      const res = youWin? "Vitória" : youDraw? "Empate" : (["A","B"].includes(m.result)?"Derrota":"Pendente");
      return `<tr>
        <td>${stageLabel(m.stage)} ${m.group?`/ ${m.group}`:""}</td>
        <td>${opp||"?"}</td>
        <td>${fmtLocalDateStr(m.date)}</td>
        <td>${res}</td>
        <td>${m.code||"-"}</td>
      </tr>`;
    }).join("");

  const winsOver = Object.entries(s?.winsOver||{}).map(([n,c])=>`<span class="pill">Venceu ${n} ×${c}</span>`).join("") || "<span class='muted'>Sem vitórias registradas.</span>";

  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>Perfil do Jogador</h2>
        <button class="btn ghost" data-back>Voltar</button>
      </div>

      <div class="profile-hero" style="margin-top:10px">
        <div class="profile-avatar">${initials}</div>
        <div>
          <h3 style="margin:0 0 4px 0">${p?.name||"?"} <span class="badge-small">Grupo ${p?.group||"-"}</span></h3>
          <div class="profile-stats">
            <div class="stat"><b>Pontos:</b> ${s.points}</div>
            <div class="stat"><b>Jogos:</b> ${s.games}</div>
            <div class="stat"><b>V:</b> ${s.wins}</div>
            <div class="stat"><b>E:</b> ${s.draws}</div>
            <div class="stat"><b>D:</b> ${s.losses}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>Histórico de Partidas</h3>
      <div class="table">
        <table>
          <thead><tr><th>Etapa</th><th>Adversário</th><th>Data</th><th>Resultado</th><th>Código</th></tr></thead>
          <tbody>${history || "<tr><td colspan='5'>Sem partidas.</td></tr>"}</tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>Confrontos Diretos</h3>
      <div>${winsOver}</div>
    </div>
  `;
}
window.addEventListener("load",()=>{
  const h=location.hash.replace("#","");
  if(h.startsWith("player/")){ openPlayerProfile(h.split("/")[1]); }
});

/* ========= TABLES ========= */
function renderTables(){
  const stats=statsFromMatches(); const groups={A:[],B:[]};
  for(const id in stats){ const s=stats[id]; (groups[s.group]||(groups.A=[])).push(s); }
  ["A","B"].forEach(g=>{
    const arr=(groups[g]||[]).sort((x,y)=> y.points-x.points || y.wins-x.wins || x.name.localeCompare(y.name));
    const rows=arr.map((s,i)=>`<tr class="pos-${i+1}"><td>${i+1}</td><td>${s.name}</td><td>${s.points}</td><td>${s.games}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td></tr>`).join("");
    const html=`<div class="table"><table><thead><tr><th>#</th><th>Jogador</th><th>Pts</th><th>J</th><th>V</th><th>E</th><th>D</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const box=$(`#table-${g}`); if(box) box.innerHTML=html;
  });
}

/* ========= PROBABILIDADES ========= */
function getMatchBetCounts(matchId){
  const bets = state.bets.filter(b => b.matchId === matchId);
  let cA=0, cB=0, cD=0;
  for(const b of bets){
    if(b.pick==="A") cA++; else if(b.pick==="B") cB++; else if(b.pick==="draw") cD++;
  }
  return { cA, cB, cD, total: cA+cB+cD };
}
function perfScore(playerId){
  const stats = statsFromMatches();
  const s = stats[playerId] || { wins:0, draws:0, losses:0, games:0 };
  const raw = (s.wins*3 + s.draws*1 - s.losses*2);
  return 1 + (s.games ? raw / s.games : 0); // mínimo 1
}
function computeProbabilitiesAndOdds(m){
  const { cA, cB, cD } = getMatchBetCounts(m.id);
  const sA = cA + 1, sB = cB + 1, sD = cD + 1;
  const S  = sA + sB + sD;

  const pbA = sA / S, pbB = sB / S, pbD = sD / S;

  const pAperf = perfScore(m.aId);
  const pBperf = perfScore(m.bId);
  const perfSum = pAperf + pBperf || 1;
  const pfA = pAperf / perfSum;
  const pfB = pBperf / perfSum;

  // 60% apostas + 40% desempenho; empate baseline 10%
  let pA = 0.6*pbA + 0.4*pfA;
  let pB = 0.6*pbB + 0.4*pfB;
  let pD = 0.6*pbD + 0.4*0.10;

  // normaliza & limita para evitar valores fora do [0,1]
  const T = pA + pB + pD || 1;
  pA = clamp(pA/T, 0.001, 0.999);
  pB = clamp(pB/T, 0.001, 0.999);
  pD = clamp(pD/T, 0.001, 0.999);

  // odds limitadas
  const oddA = clamp(1/pA, 1.2, 5);
  const oddB = clamp(1/pB, 1.2, 5);
  const oddD = clamp(1/pD, 1.2, 5);

  // em %
  const PctA = clamp(Math.round(pA*100), 0, 100);
  const PctB = clamp(Math.round(pB*100), 0, 100);
  const PctD = clamp(Math.round(pD*100), 0, 100);

  return {
    probs: { A: PctA, B: PctB, D: PctD },
    odds:  { A: Number(oddA.toFixed(2)), B: Number(oddB.toFixed(2)), D: Number(oddD.toFixed(2)) }
  };
}

/* ========= PARTIDAS ========= */
function renderMatches(){
  // garante opções do filtro (caso HTML antigo)
  const filter = $("#filter-stage");
  if(filter && !filter.dataset.patched){
    filter.innerHTML = `
      <option value="groups">Fase de grupos</option>
      <option value="groupA">Grupo A</option>
      <option value="groupB">Grupo B</option>
      <option value="semifinal">Semifinal</option>
      <option value="all">Todas</option>`;
    filter.dataset.patched = "1";
  }

  const stageF=$("#filter-stage")?.value||"groups";
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  let arr=state.matches.slice();

  const listGA=arr.filter(m=>m.stage==="groups"&&m.group==="A");
  const listGB=arr.filter(m=>m.stage==="groups"&&m.group==="B");
  const listSemi=arr.filter(m=>m.stage==="semifinal");
  const listKO=arr.filter(m=>m.stage!=="groups"); // semis/final/3º

  // célula probabilidade — V/E/D por jogador
  const probCell = (m)=>{
    const { probs } = computeProbabilitiesAndOdds(m);
    const vA = clamp(probs.A,0,100), vB = clamp(probs.B,0,100), d = clamp(probs.D,0,100);
    // Para cada jogador: Vitória / Empate / Derrota
    const A = `A: V ${vA}% · E ${d}% · D ${vB}%`;
    const B = `B: V ${vB}% · E ${d}% · D ${vA}%`;
    return `${A}<br>${B}`;
  };

  const makeTable=items=>`
    <div class="table">
      <table>
        <thead><tr>
          <th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data/Hora</th><th>Código</th>
          <th>Probabilidade</th><th>Resultado</th>${state.admin?`<th>Ações</th>`:""}
        </tr></thead>
        <tbody>
          ${items.map(m=>{
            const res = m.result==="A"?mapP[m.aId]
                      : m.result==="B"?mapP[m.bId]
                      : m.result==="draw"?"Empate"
                      : m.result==="postponed"?"Adiado":"Pendente";
            return `<tr data-id="${m.id}">
              <td>${stageLabel(m.stage)}</td>
              <td>${m.group||"-"}</td>
              <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
              <td>${fmtLocalDateStr(m.date)}</td>
              <td>${m.code||"-"}</td>
              <td>${probCell(m)}</td>
              <td>${res}</td>
              ${state.admin?`<td><button class="btn ghost btn-edit" data-id="${m.id}">Editar</button></td>`:""}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  let html="";
  if(stageF==="groups" || stageF==="groupA" || stageF==="all"){
    if(stageF!=="groupB"){
      html += `<div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo A</h3>${makeTable(listGA)}</div>`;
    }
  }
  if(stageF==="groups" || stageF==="groupB" || stageF==="all"){
    if(stageF!=="groupA"){
      html += `<div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo B</h3>${makeTable(listGB)}</div>`;
    }
  }
  if(stageF==="semifinal" || stageF==="all"){
    const onlySemi = stageF==="semifinal" ? listSemi : listKO;
    html += `<div class="card"><h3>${stageF==="semifinal"?"Semifinais":"Mata-mata (Semis/Final/3º)"}</h3>${makeTable(onlySemi)}</div>`;
  }

  const box=$("#matches-list");
  if(box){
    box.innerHTML=html || `<div class="card"><p class="muted">Nenhuma partida para o filtro atual.</p></div>`;
    if(state.admin){ $$(".btn-edit").forEach(b=> b.onclick=()=>loadMatchToForm(b.dataset.id)); }
  }
}
$("#filter-stage")?.addEventListener("change", renderMatches);

// 24h após a hora — adia somente a partida vencida
async function autoPostponeOverdueMatches(){
  if(!state.admin) return;
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const tasks=[];
  for(const m of state.matches){
    if(!m?.date) continue;
    const dt=parseLocalDate(m.date); if(!dt) continue;
    if(m?.result) continue; // já tem resultado/adiado
    const due=dt.getTime()+24*60*60*1000;
    if(Date.now()<due) continue;

    tasks.push(runTransaction(db, async tx=>{
      const ref=doc(db,"matches",m.id); const snap=await tx.get(ref);
      if(!snap.exists()) return;
      const cur=snap.data(); if(cur?.result||cur?.postponedNotice) return;
      const d=parseLocalDate(cur.date); if(!d) return; if(Date.now()<d.getTime()+24*60*60*1000) return;

      tx.update(ref,{ result:"postponed", postponedAt:serverTimestamp(), postponedNotice:true });

      const aName=mapP[cur.aId]||"?"; const bName=mapP[cur.bId]||"?";
      const postRef = doc(collection(db,"posts"));
      tx.set(postRef,{ title:`Partida adiada: ${aName} × ${bName}`,
        body:`A partida ${cur.code?`(${cur.code}) `:""}${aName} × ${bName}, marcada para ${fmtLocalDateStr(cur.date)}, foi automaticamente marcada como **ADIADA** (24h após o prazo sem resultado).`,
        createdAt:serverTimestamp(), author:"Sistema", authorEmail:"" });
    }));
  }
  if(tasks.length) await Promise.allSettled(tasks);
}

// Semifinais automáticas quando Fase de Grupos termina
async function checkAndAutoCreateSemis(){
  const groupMatches=state.matches.filter(m=>m.stage==="groups");
  if(groupMatches.length===0) return;
  const allDone=groupMatches.every(m=>["A","B","draw"].includes(m.result));
  if(!allDone) return;

  const existingSemis=state.matches.filter(m=>m.stage==="semifinal");
  if(existingSemis.length>=2) return;

  const stats=statsFromMatches(); const byGroup={A:[],B:[]};
  Object.values(stats).forEach(s=>(byGroup[s.group]||[]).push(s));
  const sort=a=>a.sort((x,y)=> y.points-x.points||y.wins-x.wins||x.name.localeCompare(y.name));
  sort(byGroup.A); sort(byGroup.B);
  const a1=byGroup.A[0], a2=byGroup.A[1], b1=byGroup.B[0], b2=byGroup.B[1];
  if(!(a1&&a2&&b1&&b2)) return;

  const pairs=[ {a:a1.id,b:b2.id,code:"SF-1"}, {a:b1.id,b:a2.id,code:"SF-2"} ];
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  for(const p of pairs){ await addDoc(collection(db,"matches"),{ aId:p.a,bId:p.b,stage:"semifinal",date:null,group:null,code:p.code,result:null }); }
  await addDoc(collection(db,"posts"),{ title:"Semifinais definidas",
    body:`Semifinal 1: ${mapP[a1.id]} × ${mapP[b2.id]} (SF-1)\nSemifinal 2: ${mapP[b1.id]} × ${mapP[a2.id]} (SF-2). Boa sorte!`,
    createdAt:serverTimestamp(), author:"Sistema", authorEmail:"" });
}

/* Form de partida (admin) */
function fillPlayersSelects(){
  const ids=["match-a","match-b","semi1-a","semi1-b","semi2-a","semi2-b"];
  ids.forEach(id=>{
    const el=$("#"+id); if(!el) return; el.innerHTML="";
    const opt=document.createElement("option"); opt.value=""; opt.textContent="— selecione —"; el.appendChild(opt);
    state.players.forEach(p=>{ const o=document.createElement("option"); o.value=p.id; o.textContent=`${p.name} (${p.group})`; el.appendChild(o); });
  });
  const sel=$("#player-select"); if(sel && !sel.value) renderPlayerSelect();
}
async function loadMatchToForm(id){
  const m=state.matches.find(x=>x.id===id); if(!m) return;
  $("#match-id").value=m.id; $("#match-a").value=m.aId||""; $("#match-b").value=m.bId||"";
  $("#match-stage").value=m.stage||"groups"; $("#match-group").value=m.group||"";
  $("#match-date").value=m.date||""; $("#match-date-orig").value=m.date||"";
  $("#match-date").dataset.dirty="false"; $("#match-date").oninput=()=> $("#match-date").dataset.dirty="true";
  $("#match-code").value=m.code||""; $("#match-result").value=m.result||"";
  showTab("partidas");
}

/* ========= POSTS ========= */
$("#post-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!auth.currentUser) return alert("Entre para publicar.");
  const title=$("#post-title").value.trim(); const body=$("#post-body").value.trim();
  await addDoc(collection(db,"posts"),{
    title, body, createdAt:serverTimestamp(),
    author: state.profile?.displayName || auth.currentUser?.displayName || auth.currentUser?.email || "admin",
    authorEmail: auth.currentUser?.email || ""
  });
  $("#post-form").reset();
});
function renderPostItem(p){
  const by=`${p.authorEmail||""} — ${p.author||""}`;
  return `<div class="post" data-id="${p.id}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><h3>${p.title}</h3><p class="muted" style="margin-top:-6px">${by} · ${fmtTS(p.createdAt)}</p><p>${(p.body||"").replace(/\n/g,"<br>")}</p></div>
      ${state.admin?`<button class="btn danger small btn-del-post" data-id="${p.id}">Apagar</button>`:""}
    </div>
  </div>`;
}
function renderPosts(){
  const html=state.posts.map(renderPostItem).join("");
  if($("#posts-list")){
    $("#posts-list").innerHTML = html || `<p class="muted">Sem comunicados.</p>`;
    if(state.admin){
      $$(".btn-del-post").forEach(b=> b.onclick=async ()=>{
        if(!(await confirmAction("Apagar este comunicado?"))) return;
        if(!(await requireAdmin())) return;
        await deleteDoc(doc(db,"posts",b.dataset.id));
      });
    }
  }
}

/* ========= CHAT (RTDB) ========= */
let rtdb=null, rtdbRefChat=null, rtdbApi=null;
async function initRealtimeChat(){
  if(rtdb) return;
  rtdbApi = await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js");
  const { getDatabase, ref, onValue } = rtdbApi;
  rtdb = getDatabase(app);
  rtdbRefChat = ref(rtdb, "chat");

  onValue(rtdbRefChat, (snap)=>{
    const val = snap.val() || {};
    const list = Object.entries(val).map(([id,v])=>({ id, ...v }));
    const now = Date.now();
    state.chat = list
      .filter(m => !m.expireAt || m.expireAt > now)
      .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    renderChat();
  });
}
$("#chat-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!auth.currentUser){ alert("Entre para enviar mensagens."); return; }
  if(!rtdb) await initRealtimeChat();
  const text=$("#chat-text").value.trim(); if(!text) return;
  const { push } = rtdbApi;
  const expireAt = Date.now() + 24*60*60*1000;
  await push(rtdbRefChat, {
    text,
    author: state.profile?.displayName || auth.currentUser.displayName || auth.currentUser.email,
    authorEmail: auth.currentUser?.email || "",
    username: state.profile?.username || null,
    uid: auth.currentUser.uid,
    createdAt: Date.now(),
    expireAt
  });
  $("#chat-text").value="";
});
function renderChat(){
  const html=state.chat.map(m=>{
    const who = m.username ? `${m.author} (@${m.username})` : m.author;
    const by  = `${m.authorEmail||""} — ${who}`;
    const when = m.createdAt ? new Date(m.createdAt).toLocaleString("pt-BR") : "—";
    return `<div class="chat-item" data-id="${m.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div><div class="meta">${by} · ${when}</div><div>${(m.text||"").replace(/\n/g,"<br>")}</div></div>
        ${state.admin?`<button class="btn danger small btn-del-chat" data-id="${m.id}">Apagar</button>`:""}
      </div>
    </div>`;
  }).join("");
  if($("#chat-list")){
    $("#chat-list").innerHTML = html || `<p class="muted">Sem mensagens nas últimas 24h.</p>`;
    if(state.admin){
      $$(".btn-del-chat").forEach(b=>{
        b.onclick = async ()=>{
          if(!(await confirmAction("Apagar esta mensagem do chat?"))) return;
          if(!(await requireAdmin())) return;
          try{
            const { ref, remove } = rtdbApi;
            await remove(ref(rtdb, `chat/${b.dataset.id}`));
          }catch(err){
            alert("Não foi possível apagar. Verifique as regras do Realtime Database para permitir que admin apague qualquer mensagem.");
          }
        };
      });
    }
  }
}

/* ========= APOSTAS ========= */
function populateBetOptions(){
  const sel = $("#bet-match");
  if(!sel) return;
  const now = Date.now();
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const upcoming = state.matches
    .filter(m => m.date && parseLocalDate(m.date)?.getTime() > now && !m.result)
    .sort((a,b) => parseLocalDate(a.date) - parseLocalDate(b.date));

  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = ""; opt0.textContent = "— selecione —";
  sel.appendChild(opt0);

  upcoming.forEach(m=>{
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"} • ${fmtLocalDateStr(m.date)} ${m.code?`• ${m.code}`:""}`;
    sel.appendChild(o);
  });
}

$("#bet-form")?.addEventListener("submit", async e=>{
  e.preventDefault();
  if(!auth.currentUser) return alert("Entre para apostar.");
  await ensureWalletInit(auth.currentUser.uid);

  const matchId=$("#bet-match").value;
  const pick=$("#bet-pick").value; // "A" | "B" | "draw"
  if(!matchId || !["A","B","draw"].includes(pick)) return alert("Selecione partida e palpite válido.");

  const m=state.matches.find(x=>x.id===matchId);
  const dt=m?.date?parseLocalDate(m.date):null;
  if(!m || !dt) return alert("Partida inválida.");
  if(Date.now()>=dt.getTime()) return alert("Prazo encerrado para essa partida.");

  // impede múltiplas apostas do mesmo user/partida
  const exists = state.bets.find(b=> b.uid===auth.currentUser.uid && b.matchId===matchId);
  if(exists) return alert("Você já apostou nessa partida.");

  // calcula odds atuais e armazena snapshot
  const { odds, probs } = computeProbabilitiesAndOdds(m);
  const oddSnap = pick==="A" ? odds.A : pick==="B" ? odds.B : odds.D;

  await addDoc(collection(db,"bets"),{
    uid:auth.currentUser.uid, userEmail:auth.currentUser.email,
    matchId, pick,
    createdAt:serverTimestamp(),
    settled:false,
    odd: oddSnap,
    probsSnap: probs
  });

  $("#bet-form").reset();
  alert(`Aposta registrada! Odd ${oddSnap}x`);
});

async function settleFinishedMatchesBets(){
  const finals = state.matches.filter(m=>["A","B","draw"].includes(m.result));
  for(const m of finals){
    const betsSnap = await getDocs(query(colBets, where("matchId","==", m.id), where("settled","==", false)));
    if(betsSnap.empty) continue;

    const ops = betsSnap.docs.map(bd => runTransaction(db, async tx=>{
      const betRef=doc(db,"bets",bd.id); const betSnap=await tx.get(betRef);
      if(!betSnap.exists()) return;
      const bet=betSnap.data(); if(bet.settled) return;

      const won = bet.pick === m.result;
      const walletRef = doc(db,"wallets", bet.uid);
      const walSnap=await tx.get(walletRef);
      const current = walSnap.exists()? (walSnap.data().points||0) : 0;

      // recompensa: odd * 2 pts (mínimo 1) se acertar; 0 se errar
      const odd = typeof bet.odd === "number" ? bet.odd : 1.5;
      const add = won ? Math.max(1, Math.round(odd * 2)) : 0;

      if(!walSnap.exists()){
        tx.set(walletRef, { points: 6 + add, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }else{
        tx.update(walletRef, { points: current + add, updatedAt: serverTimestamp() });
      }
      tx.update(betRef,{ settled:true, won, settledAt:serverTimestamp(), reward:add });
    }));
    await Promise.allSettled(ops);
  }
}
function renderBets(){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const mapM=Object.fromEntries(state.matches.map(m=>[m.id,m]));
  const my = auth.currentUser ? state.bets.filter(b=> b.uid===auth.currentUser.uid) : [];
  const rows = my.map(b=>{
    const m=mapM[b.matchId]; const vs=m?`${mapP[m.aId]} × ${mapP[m.bId]}`:"?";
    const res = b.settled ? (b.won?`Acertou (+${b.reward||0})`:"Errou") : "Pendente";
    return `<tr><td>${vs}</td><td>${stageLabel(m?.stage)} ${m?.group||""}</td><td>${b.pick}</td><td>${res}</td></tr>`;
  }).join("");
  if($("#bets-list")){
    $("#bets-list").innerHTML = rows || `<tr><td colspan="4">Sem apostas.</td></tr>`;
  }
}
function renderWallet(){
  if(!auth.currentUser) return;
  const docWal = state.wallets.find(w=> w.id===auth.currentUser.uid);
  const pts = docWal?.points||0;
  if($("#wallet-points")) $("#wallet-points").textContent = pts;
}

/* ========= ADMIN: Semis & Seed & Reset ========= */
$("#semi-autofill")?.addEventListener("click", ()=>{
  const stats=statsFromMatches(); const groups={A:[],B:[]};
  for(const id in stats){ const s=stats[id]; (groups[s.group]||[]).push(s); }
  const sort=a=>a.sort((x,y)=> y.points-x.points||y.wins-x.wins||x.name.localeCompare(y.name));
  sort(groups.A); sort(groups.B);
  const a1=groups.A[0], a2=groups.A[1], b1=groups.B[0], b2=groups.B[1];
  if(a1&&b2){ $("#semi1-a").value=a1.id; $("#semi1-b").value=b2.id; }
  if(b1&&a2){ $("#semi2-a").value=b1.id; $("#semi2-b").value=a2.id; }
  alert("Semifinais preenchidas (clique em Criar Semifinais para confirmar).");
});
$("#semi-save")?.addEventListener("click", async ()=>{
  if(!(await requireAdmin())) return;
  const pairs=[
    { a:$("#semi1-a").value, b:$("#semi1-b").value, code: $("#semi-code").value?$("#semi-code").value+"-1":"SF-1" },
    { a:$("#semi2-a").value, b:$("#semi2-b").value, code: $("#semi-code").value?$("#semi-code").value+"-2":"SF-2" },
  ];
  for(const p of pairs){ if(!p.a||!p.b) continue;
    await addDoc(collection(db,"matches"),{ aId:p.a,bId:p.b,stage:"semifinal",date:null,group:null,code:p.code,result:null });
  }
  alert("Semifinais criadas. Ajuste datas/resultados em Partidas.");
});
function renderAdminSemisList(){
  const list=state.matches.filter(m=>m.stage==="semifinal");
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const rows=list.map(m=>`<tr><td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td><td>${fmtLocalDateStr(m.date)}</td><td>${m.code||"-"}</td><td>${m.result||"Pendente"}</td></tr>`).join("");
  const html=`<div class="table"><table><thead><tr><th>Semifinal</th><th>Data</th><th>Código</th><th>Resultado</th></tr></thead><tbody>${rows||"<tr><td colspan='4'>Nenhuma semifinal cadastrada.</td></tr>"}</tbody></table></div>`;
  $("#semi-list") && ($("#semi-list").innerHTML=html);
}

$("#btn-reset-tournament")?.addEventListener("click", async ()=>{
  if(!(await requireAdmin())) return;
  if(!(await confirmAction("Resetar o torneio? (apaga partidas, posts, chat, apostas e carteiras)"))) return;

  async function wipe(colName){
    const snap=await getDocs(collection(db,colName));
    await Promise.allSettled(snap.docs.map(d=> deleteDoc(doc(db,colName,d.id))));
  }
  try{
    await wipe("matches");
    await wipe("posts");
    await wipe("bets");
    await wipe("wallets");
    // wipe chat (RTDB)
    try{
      if(!rtdb) await initRealtimeChat();
      const { ref, set } = rtdbApi;
      await set(ref(rtdb,"chat"), null);
    }catch{}
    alert("Torneio resetado! (Players mantidos)");
  }catch(err){ alert("Erro ao resetar: "+err.message); }
});

/* ========= BUSCA JOGADOR ========= */
$("#player-search-btn")?.addEventListener("click", ()=>{
  const q=($("#player-search")?.value||"").toLowerCase();
  const found=state.players.find(p=>p.name.toLowerCase().includes(q));
  if(found) openPlayerProfile(found.id); else alert("Jogador não encontrado.");
});
