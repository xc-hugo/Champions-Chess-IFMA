// app.js — Champions Chess IFMA (ESM; depende de firebase.js do projeto)

import {
  app, auth, db,
  loginWithGoogle, logout, watchAuth, isAdmin, setDisplayName,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp, runTransaction
} from "./firebase.js";

/* ========================= Helpers & UI ========================= */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const sleep = ms => new Promise(r=>setTimeout(r, ms));
function confirmAction(msg){ return new Promise(res=> res(window.confirm(msg))); }

// Datas: aceita local "YYYY-MM-DDTHH:mm[:ss]" e ISO com Z/offset
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

function stageLabel(s){
  switch((s||"").toLowerCase()){
    case "groups": return "F. Grupos";
    case "semifinal": return "Semifinal";
    case "final": return "Final";
    case "third": return "3º Lugar";
    default: return s||"—";
  }
}
function slugifyName(name){
  return (name||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,20)||"user";
}
function shortUid(uid){ return (uid||"").slice(-4)||Math.floor(Math.random()*9999).toString().padStart(4,"0"); }

/* ===== Navbar fixa: compensação e scroll pro topo ===== */
function applyTopbarOffset(){
  if (getComputedStyle(document.body).margin !== "0px") document.body.style.margin = "0";
  const header = document.querySelector(".topbar");
  const h = header ? header.offsetHeight : 0;
  document.documentElement.style.setProperty("--topbar-h", `${h}px`);
  document.documentElement.style.scrollPaddingTop = `${h}px`;
}
function showTab(id){
  if(!id) id="home";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".view").forEach(v => v.classList.toggle("visible", v.id === id));
  if(location.hash.replace("#","")!==id) location.hash = id;
  applyTopbarOffset();
  window.scrollTo({ top: 0, behavior: "auto" });
}
window.addEventListener("load", applyTopbarOffset);
window.addEventListener("resize", applyTopbarOffset);
window.addEventListener("hashchange", ()=> showTab(location.hash.replace("#","") || "home"));
$$(".tab").forEach(b => b.addEventListener("click", e=>{ e.preventDefault(); showTab(b.dataset.tab); }));
showTab(location.hash.replace("#","") || "home");

// scroll helper (gerenciar partidas)
function ensureAndScrollTo(sel){
  let tries=0;
  const t=setInterval(()=>{
    const el = document.querySelector(sel);
    if(el){
      const header = document.querySelector(".topbar");
      const offset = (header?header.offsetHeight:0)+12;
      const y = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top:y, behavior:"smooth" });
      clearInterval(t);
    }
    if(++tries>20) clearInterval(t);
  },50);
}

/* ========================= Estado ========================= */
let state = {
  user:null, admin:false, profile:null,
  players:[], matches:[], posts:[], chat:[],
  bets:[], wallets:[], // apostas & carteira de pontos
};
const prevResults = new Map(); // cache local (apenas UI)

/* ========================= Admin Claims + Fallback ========================= */
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

/* ========================= Auth & Perfil ========================= */
$("#btn-open-login")?.addEventListener("click", async ()=>{ try{ await loginWithGoogle(); }catch(e){ alert("Erro: "+e.message); } });
$("#btn-logout")?.addEventListener("click", async ()=>{ await logout(); });

async function loadProfile(uid){
  if(!uid){ state.profile=null; return renderProfile(); }
  const snap = await getDoc(doc(db,"profiles",uid));
  state.profile = snap.exists()?snap.data():null;
  renderProfile();
}

$("#profile-form")?.addEventListener("submit", async e=>{
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

watchAuth(async (user)=>{
  state.user=user;
  $("#btn-open-login")?.classList.toggle("hidden",!!user);
  $("#btn-logout")?.classList.toggle("hidden",!user);
  $("#user-chip")?.classList.toggle("hidden",!user);
  if($("#user-email")) $("#user-email").textContent = user ? (user.displayName||user.email) : "";

  $("#chat-form")?.classList.toggle("hidden",!user);
  $("#chat-login-hint")?.classList.toggle("hidden",!!user);

  await loadProfile(user?.uid||null);
  await refreshAdminStatus();

  renderPosts(); renderChat(); renderMatches(); renderHome(); renderAdminSemisList();
  if(user) initRealtimeChat(); // RTDB chat
});

/* ========================= Firestore listeners ========================= */
const colPlayers = collection(db,"players");
const colMatches = collection(db,"matches");
const colPosts   = collection(db,"posts");
const colBets    = collection(db,"bets");
const colWallets = collection(db,"wallets");

onSnapshot(query(colPlayers, orderBy("name")), snap=>{
  state.players = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPlayers(); fillPlayersSelects(); renderTables(); renderPlayerSelect(); renderHome(); renderAdminSemisList();
});

// Matches: também re-render Players aqui (para atualizar estatísticas!)
onSnapshot(query(colMatches, orderBy("date")), async snap=>{
  const newMatches = snap.docs.map(d=>({id:d.id,...d.data()}));

  // --- Anúncio automático de resultado (sem duplicar) ---
  if(await refreshAdminStatus()){ // somente admin publica
    const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
    for(const m of newMatches){
      const isFinal = ["A","B","draw"].includes(m.result);
      if(!isFinal) continue;
      if(m.resultAnnounced) continue; // já anunciado
      // usa transação pra evitar corrida
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

  // cache local (apenas UI)
  prevResults.clear(); newMatches.forEach(m=>prevResults.set(m.id,m.result||null));

  state.matches = newMatches;
  renderMatches(); renderTables(); renderPlayers(); renderPlayerDetails(); renderHome(); renderAdminSemisList();

  if(state.admin){
    await autoPostponeOverdueMatches();  // adiar só quem venceu prazo
    await checkAndAutoCreateSemis();     // semis quando grupos finalizam
    await settleFinishedMatchesBets();   // liquida apostas
  }
});

onSnapshot(query(colPosts, orderBy("createdAt","desc")), snap=>{
  state.posts = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPosts(); renderHome();
});

// Apostas (opcional)
onSnapshot(query(colBets, orderBy("createdAt","desc")), snap=>{
  state.bets = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderBets();
});
onSnapshot(colWallets, snap=>{
  state.wallets = snap.docs.map(d=>({id:d.id,...d.data()}));
  renderWallet();
});

/* ========================= Estatísticas & Tabela ========================= */
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

/* ========================= Home (4 próximas do dia) ========================= */
function renderHome(){
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const scheduled=state.matches.filter(m=>!!m.date).slice();
  const today=new Date(); const s=new Date(today); s.setHours(0,0,0,0); const e=new Date(today); e.setHours(23,59,59,999);
  const isSameDay=(d1,d2)=> d1.getFullYear()==d2.getFullYear()&&d1.getMonth()==d2.getMonth()&&d1.getDate()==d2.getDate();
  let pick=scheduled.filter(m=>{const d=parseLocalDate(m.date);return d&&d>=s&&d<=e;});
  if(pick.length===0){
    let nextDay=null; for(const m of scheduled){ const d=parseLocalDate(m.date); if(d&&d>e){ nextDay=d; break; } }
    if(nextDay){ pick=scheduled.filter(m=>{const d=parseLocalDate(m.date); return d&&isSameDay(d,nextDay);}); }
  }
  pick=pick.slice(0,4);
  const rows=pick.map(m=>`<tr><td>${stageLabel(m.stage)}</td><td>${m.group||"-"}</td><td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td><td>${fmtLocalDateStr(m.date)}</td><td>${m.code||"-"}</td></tr>`).join("");
  const table=`<table><thead><tr><th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data</th><th>Código</th></tr></thead><tbody>${rows||"<tr><td colspan='5'>Sem partidas hoje/próximo dia.</td></tr>"}</tbody></table>`;
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

/* ========================= Players (lista + perfil dedicado) ========================= */
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

  // clique abre perfil dedicado (#player/<id>)
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
function renderPlayerDetails(){
  const sel=$("#player-select"); const box=$("#player-details"); if(!sel||!box) return;
  const id=sel.value; if(!id){ box.innerHTML=`<p class="muted">Selecione um jogador para ver detalhes.</p>`; return; }
  box.innerHTML = buildPlayerDetailsHTML(id);
}
function buildPlayerDetailsHTML(id){
  const stats=statsFromMatches(); const s=stats[id]; if(!s) return `<p class="muted">Sem dados.</p>`;
  const wins=Object.entries(s.winsOver).map(([n,c])=>`<span class="pill">Venceu ${n} ×${c}</span>`).join("")||"<span class='muted'>Sem vitórias registradas.</span>";
  return `
    <p><b>${s.name}</b> — Grupo ${s.group}</p>
    <p>Pontos: <b>${s.points}</b> · Jogos: <b>${s.games}</b> · V:${s.wins} · E:${s.draws} · D:${s.losses}</p>
    <div>${wins}</div>
    <div style="margin-top:8px"><button class="btn" data-open-profile="${s.id}">Abrir perfil</button></div>
  `;
}
function openPlayerProfile(id){
  const container=$("#player-profile"); if(!container){ showTab("players"); return; }
  container.innerHTML = buildPlayerProfileHTML(id);
  // bind voltar
  container.querySelectorAll("[data-back]").forEach(b=> b.onclick=()=> showTab("players"));
  // força rota #player/<id>
  location.hash = `player/${id}`;
  showTab("player-profile");
}
function buildPlayerProfileHTML(id){
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
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2>Perfil — ${p?.name||"?"}</h2>
        <button class="btn ghost" data-back>Voltar</button>
      </div>
      <p>Grupo ${p?.group||"-"}</p>
      <p>Pontos: <b>${s?.points||0}</b> · Jogos: ${s?.games||0} · V:${s?.wins||0} · E:${s?.draws||0} · D:${s?.losses||0}</p>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>Histórico de Partidas</h3>
      <table>
        <thead><tr><th>Etapa</th><th>Adversário</th><th>Data</th><th>Resultado</th><th>Código</th></tr></thead>
        <tbody>${history || "<tr><td colspan='5'>Sem partidas.</td></tr>"}</tbody>
      </table>
    </div>
  `;
}
// deep-link do perfil: #player/<id>
window.addEventListener("load",()=>{
  const h=location.hash.replace("#","");
  if(h.startsWith("player/")){ openPlayerProfile(h.split("/")[1]); }
});

/* ========================= Tabelas & Partidas ========================= */
function renderTables(){
  const stats=statsFromMatches(); const groups={A:[],B:[]};
  for(const id in stats){ const s=stats[id]; (groups[s.group]||(groups.A=[])).push(s); }
  ["A","B"].forEach(g=>{
    const arr=(groups[g]||[]).sort((x,y)=> y.points-x.points || y.wins-x.wins || x.name.localeCompare(y.name));
    const rows=arr.map((s,i)=>`<tr class="pos-${i+1}"><td>${i+1}</td><td>${s.name}</td><td>${s.points}</td><td>${s.games}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td></tr>`).join("");
    const html=`<table><thead><tr><th>#</th><th>Jogador</th><th>Pts</th><th>J</th><th>V</th><th>E</th><th>D</th></tr></thead><tbody>${rows}</tbody></table>`;
    const box=$(`#table-${g}`); if(box) box.innerHTML=html;
  });
}

function renderMatches(){
  const stageF=$("#filter-stage")?.value||"all";
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  let arr=state.matches.slice();
  if(stageF!=="all") arr=arr.filter(m=>m.stage===stageF);

  const gA=arr.filter(m=>m.stage==="groups"&&m.group==="A");
  const gB=arr.filter(m=>m.stage==="groups"&&m.group==="B");
  const ko=arr.filter(m=>m.stage!=="groups");

  const makeTable=items=>`
    <table>
      <thead><tr><th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data/Hora</th><th>Código</th><th>Resultado</th>${state.admin?`<th>Ações</th>`:""}</tr></thead>
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
            <td>${res}</td>
            ${state.admin?`<td><button class="btn ghost btn-edit" data-id="${m.id}">Editar</button></td>`:""}
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;

  const html=`
    <div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo A</h3><div class="table">${makeTable(gA)}</div></div>
    <div class="card" style="margin-bottom:12px"><h3>F. Grupos – Grupo B</h3><div class="table">${makeTable(gB)}</div></div>
    <div class="card"><h3>Mata-mata (Semis/Final/3º)</h3><div class="table">${makeTable(ko)}</div></div>`;
  const box=$("#matches-list");
  if(box){
    box.innerHTML=html;
    if(state.admin){ $$(".btn-edit").forEach(b=> b.onclick=()=>loadMatchToForm(b.dataset.id)); }
  }
}
$("#filter-stage")?.addEventListener("change", renderMatches);

/* ===== Adiamento automático (24h após a data) — só a partida vencida ===== */
async function autoPostponeOverdueMatches(){
  const now=Date.now(); const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name])); const tasks=[];
  for(const m of state.matches){
    if(!m?.date) continue;
    const dt=parseLocalDate(m.date); if(!dt) continue;
    if(m?.result) continue;
    const due=dt.getTime()+24*60*60*1000;
    if(now<due) continue;

    tasks.push(runTransaction(db, async tx=>{
      const ref=doc(db,"matches",m.id); const snap=await tx.get(ref); if(!snap.exists()) return;
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

/* ===== Semifinais automáticas quando F. Grupos fecha ===== */
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

/* ========================= Admin: Players & Matches ========================= */
function fillPlayersSelects(){
  const ids=["match-a","match-b","semi1-a","semi1-b","semi2-a","semi2-b"];
  ids.forEach(id=>{
    const el=$("#"+id); if(!el) return; el.innerHTML="";
    const opt=document.createElement("option"); opt.value=""; opt.textContent="— selecione —"; el.appendChild(opt);
    state.players.forEach(p=>{ const o=document.createElement("option"); o.value=p.id; o.textContent=`${p.name} (${p.group})`; el.appendChild(o); });
  });
  const sel=$("#player-select"); if(sel && !sel.value) renderPlayerSelect();
}
$("#player-form")?.addEventListener("submit", async e=>{
  e.preventDefault();
  const id=$("#player-id").value;
  const data={ name:$("#player-name").value.trim(), group:$("#player-group").value };
  try{
    if(!(await requireAdmin())) return;
    if(id) await updateDoc(doc(db,"players",id), data);
    else await addDoc(collection(db,"players"), data);
    $("#player-form").reset(); $("#player-id").value="";
  }catch(err){ alert("Erro: "+err.message); }
});
$("#player-delete")?.addEventListener("click", async ()=>{
  const id=$("#player-id").value; if(!id) return;
  if(!(await confirmAction("Excluir jogador?"))) return;
  if(!(await requireAdmin())) return;
  await deleteDoc(doc(db,"players",id));
  $("#player-form").reset(); $("#player-id").value="";
});

async function loadMatchToForm(id){
  const m=state.matches.find(x=>x.id===id); if(!m) return;
  $("#match-id").value=m.id; $("#match-a").value=m.aId||""; $("#match-b").value=m.bId||"";
  $("#match-stage").value=m.stage||"groups"; $("#match-group").value=m.group||"";
  $("#match-date").value=m.date||""; $("#match-date-orig").value=m.date||"";
  $("#match-date").dataset.dirty="false"; $("#match-date").oninput=()=> $("#match-date").dataset.dirty="true";
  $("#match-code").value=m.code||""; $("#match-result").value=m.result||"";
  showTab("partidas"); ensureAndScrollTo("#admin-matches, #manage-matches, #match-form");
}
$("#match-delete")?.addEventListener("click", async ()=>{
  const id=$("#match-id").value; if(!id) return;
  if(!(await confirmAction("Excluir partida?"))) return;
  if(!(await requireAdmin())) return;
  await deleteDoc(doc(db,"matches",id));
  $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false";
});
$("#match-form")?.addEventListener("submit", async e=>{
  e.preventDefault();
  if(!(await requireAdmin())) return;
  const payload={
    aId:$("#match-a").value, bId:$("#match-b").value,
    stage:$("#match-stage").value, group:$("#match-group").value||null,
    code:$("#match-code").value||null, result:$("#match-result").value||null
  };
  const isEdit=!!$("#match-id").value; const dateDirty=$("#match-date").dataset.dirty==="true"; const dateVal=$("#match-date").value||null;
  if(!isEdit) payload.date=dateVal; else if(dateDirty) payload.date=dateVal;
  const id=$("#match-id").value;
  if(id) await updateDoc(doc(db,"matches",id), payload); else await addDoc(collection(db,"matches"), payload);
  $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false";
});

/* ========================= Posts ========================= */
$("#post-form")?.addEventListener("submit", async e=>{
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

/* ========================= Chat — Realtime Database ========================= */
let rtdb=null, rtdbRefChat=null, rtdbApi=null;
async function initRealtimeChat(){
  if(rtdb) return; // já iniciado
  // carrega a SDK do RTDB dinamicamente
  rtdbApi = await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js");
  const { getDatabase, ref, onValue, push, remove } = rtdbApi;
  rtdb = getDatabase(app);
  rtdbRefChat = ref(rtdb, "chat");

  // listener
  onValue(rtdbRefChat, (snap)=>{
    const val = snap.val() || {};
    const list = Object.entries(val).map(([id,v])=>({ id, ...v }));
    // expira cliente-side (24h)
    const now = Date.now();
    state.chat = list
      .filter(m => !m.expireAt || m.expireAt > now)
      .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    renderChat();
  });
}
$("#chat-form")?.addEventListener("submit", async e=>{
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
    createdAt: Date.now(),  // simples e consistente
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
      $$(".btn-del-chat").forEach(b=> b.onclick=async ()=>{
        if(!(await confirmAction("Apagar esta mensagem do chat?"))) return;
        if(!(await requireAdmin())) return;
        const { ref, remove } = rtdbApi;
        await remove(ref(rtdb, `chat/${b.dataset.id}`));
      });
    }
  }
}

/* ========================= Apostas ========================= */
/** Regras simples:
 * - Usuário aposta antes do horário da partida
 * - pick ∈ {"A","B","draw"}
 * - Ao finalizar a partida, liquida: +2 pts para acerto, +0 erro
 */
const BET_REWARD_POINTS = 2;

$("#bet-form")?.addEventListener("submit", async e=>{
  e.preventDefault();
  if(!auth.currentUser) return alert("Entre para apostar.");
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

  await addDoc(collection(db,"bets"),{
    uid:auth.currentUser.uid, userEmail:auth.currentUser.email,
    matchId, pick, createdAt:serverTimestamp(), settled:false
  });
  $("#bet-form").reset();
  alert("Aposta registrada!");
});

async function settleFinishedMatchesBets(){
  // para cada partida finalizada e não liquidada, liquidar as apostas não-settled
  const finals = state.matches.filter(m=>["A","B","draw"].includes(m.result));
  for(const m of finals){
    // pega apostas não liquidadas desta partida
    const betsSnap = await getDocs(query(colBets, where("matchId","==", m.id), where("settled","==", false)));
    if(betsSnap.empty) continue;

    const isWinner = pick => pick===m.result;
    // Liquida cada aposta em transação: marca settled e dá pontos
    const ops = betsSnap.docs.map(bd => runTransaction(db, async tx=>{
      const betRef=doc(db,"bets",bd.id); const betSnap=await tx.get(betRef);
      if(!betSnap.exists()) return;
      const bet=betSnap.data(); if(bet.settled) return;

      const won = isWinner(bet.pick);
      const walletRef = doc(db,"wallets", bet.uid);
      const walSnap=await tx.get(walletRef);
      const current = walSnap.exists()? (walSnap.data().points||0) : 0;
      const add = won?BET_REWARD_POINTS:0;

      tx.set(walletRef,{ points: current+add, updatedAt:serverTimestamp() },{merge:true});
      tx.update(betRef,{ settled:true, won, settledAt:serverTimestamp(), reward:add });
    }));
    await Promise.allSettled(ops);
  }
}

function renderBets(){
  // se houver #bets-list/#wallet, preenche
  const mapP=Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const mapM=Object.fromEntries(state.matches.map(m=>[m.id,m]));
  const my = auth.currentUser ? state.bets.filter(b=> b.uid===auth.currentUser.uid) : [];
  const rows = my.map(b=>{
    const m=mapM[b.matchId]; const vs=m?`${mapP[m.aId]} × ${mapP[m.bId]}`:"?";
    const res = b.settled ? (b.won?"Acertou":"Errou") : "Pendente";
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

/* ========================= Semis (admin) ========================= */
$("#semi-autofill")?.addEventListener("click", ()=>{
  const stats=statsFromMatches(); const groups={A:[],B:[]};
  for(const id in stats){ const s=stats[id]; (groups[s.group]||[]).push(s); }
  const sort=a=>a.sort((x,y)=> y.points-x.points||y.wins-x.wins||x.name.localeCompare(y.name));
  sort(groups.A); sort(groups.B);
  const a1=groups.A[0], a2=groups.A[1], b1=groups.B[0], b2=groups.B[1];
  if(a1&&b2){ $("#semi1-a").value=a1.id; $("#semi1-b").value=b2.id; }
  if(b1&&a2){ $("#semi2-a").value=b1.id; $("#semi2-b").value=a2.id; }
  alert("Semifinais preenchidas (não criou ainda; clique em Criar Semifinais).");
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
  const html=`<table><thead><tr><th>Semifinal</th><th>Data</th><th>Código</th><th>Resultado</th></tr></thead><tbody>${rows||"<tr><td colspan='4'>Nenhuma semifinal cadastrada.</td></tr>"}</tbody></table>`;
  $("#semi-list") && ($("#semi-list").innerHTML=html);
}

/* ========================= Reset Torneio (admin) ========================= */
$("#btn-reset-tournament")?.addEventListener("click", async ()=>{
  if(!(await requireAdmin())) return;
  if(!(await confirmAction("Resetar o torneio? (apaga partidas, posts, chat, apostas)"))) return;

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

/* ========================= Search & misc binds ========================= */
$("#player-search-btn")?.addEventListener("click", ()=>{
  const q=($("#player-search")?.value||"").toLowerCase();
  const found=state.players.find(p=>p.name.toLowerCase().includes(q));
  if(found) openPlayerProfile(found.id); else alert("Jogador não encontrado.");
});
