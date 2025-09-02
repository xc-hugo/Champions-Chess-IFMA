// app.js — Champions Chess IFMA (Google login only, Firestore)
// Requer: index.html + styles.css + firebase.js + assets (logo.png, ChampionsChessIFMA.pdf)

import {
  auth, db,
  loginWithGoogle, logout, watchAuth, isAdmin, setDisplayName,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp, runTransaction
} from "./firebase.js";

// ========== Helpers de UI ==========
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function showTab(id){
  if(!id) id = "home";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".view").forEach(v => v.classList.toggle("visible", v.id === id));
  if(location.hash.replace("#","") !== id) location.hash = id;
}
window.addEventListener("hashchange", ()=> showTab(location.hash.replace("#","") || "home"));
$$(".tab").forEach(b => b.onclick = () => showTab(b.dataset.tab));
showTab(location.hash.replace("#","") || "home");

function fmtDateStr(s){ return s ? new Date(s).toLocaleString("pt-BR") : "—"; }
function option(el, value, label){ const o=document.createElement("option"); o.value=value; o.textContent=label; el.appendChild(o); }

// Slug/username helpers
function slugifyName(name){
  return (name || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")                      // espaços/símbolos -> "-"
    .replace(/^-+|-+$/g, "")                          // aparar "-"
    .slice(0, 20) || "user";
}
function shortUid(uid){ return (uid || "").slice(-4) || Math.floor(Math.random()*9999).toString().padStart(4,"0"); }

// ========== Estado ==========
let state = {
  user: null,
  admin: false,
  profile: null,
  players: [],
  matches: [],
  posts: [],
  chat: []
};

// ========== Auth UI (Google only) ==========
// Botão Entrar → Google
$("#btn-open-login")?.addEventListener("click", async ()=>{
  try { await loginWithGoogle(); }
  catch(err){ alert("Erro ao entrar com Google: " + err.message); }
});
$("#btn-logout")?.addEventListener("click", async ()=> { await logout(); });

// Perfil (Firestore: profiles/{uid})
async function loadProfile(uid){
  if(!uid){ state.profile=null; renderProfile(); return; }
  const snap = await getDoc(doc(db,"profiles",uid));
  state.profile = snap.exists() ? snap.data() : null;
  renderProfile();
}
$("#profile-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!state.user) return alert("Entre para editar o perfil.");

  const display = $("#profile-name").value.trim();
  const base = slugifyName(display);
  const fallback = `${base}-${shortUid(state.user.uid)}`;

  try{
    await runTransaction(db, async (tx)=>{
      const profRef = doc(db, "profiles", state.user.uid);

      // ler perfil atual (para soltar o handle antigo, se houver)
      const profSnap = await tx.get(profRef);
      const oldUsername = profSnap.exists() ? (profSnap.data().username || null) : null;

      // 1) se tinha username antigo, deletar o doc /usernames/{old}
      if(oldUsername){
        const oldRef = doc(db, "usernames", oldUsername);
        const oldSnap = await tx.get(oldRef);
        if(oldSnap.exists() && oldSnap.data().uid === state.user.uid){
          tx.delete(oldRef);
        }
      }

      // 2) tentar reservar o handle "base"
      let chosen = base;
      const tryRef = doc(db, "usernames", base);
      const trySnap = await tx.get(tryRef);

      if(trySnap.exists()){
        // já existe → usa fallback determinístico por UID
        chosen = fallback;
        const fbRef = doc(db, "usernames", chosen);
        const fbSnap = await tx.get(fbRef);
        if(fbSnap.exists()){
          throw new Error("USERNAME_TAKEN_FALLBACK");
        }
        tx.set(fbRef, { uid: state.user.uid, createdAt: serverTimestamp() });
      } else {
        tx.set(tryRef, { uid: state.user.uid, createdAt: serverTimestamp() });
      }

      // 3) salvar perfil com displayName + username escolhido
      tx.set(profRef, {
        displayName: display,
        username: chosen,
        email: state.user.email,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    // Atualiza o Auth.displayName (não afeta unicidade)
    await setDisplayName(state.user, display);

    // reload perfil para refletir username
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

// ========== Watch Auth ==========
watchAuth(async (user)=>{
  state.user = user;

  // header
  $("#btn-open-login")?.classList.toggle("hidden", !!user);
  $("#btn-logout")?.classList.toggle("hidden", !user);
  $("#user-chip")?.classList.toggle("hidden", !user);
  if($("#user-email")) $("#user-email").textContent = user ? (user.displayName || user.email) : "";

  // admin toggles
  state.admin = user ? await isAdmin(user.uid) : false;
  $("#admin-badge")?.classList.toggle("hidden", !state.admin);
  $("#tab-admin")?.classList.toggle("hidden", !state.admin);
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !state.admin));

  // chat input só logado
  $("#chat-form")?.classList.toggle("hidden", !user);
  $("#chat-login-hint")?.classList.toggle("hidden", !!user);

  await loadProfile(user?.uid || null);
});

// ========== Firestore listeners ==========
const colPlayers = collection(db, "players");
const colMatches = collection(db, "matches");
const colPosts   = collection(db, "posts");
const colChat    = collection(db, "chat");

onSnapshot(query(colPlayers, orderBy("name")), snap=>{
  state.players = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderPlayers();
  fillPlayersSelects();
  renderTables();
  renderPlayerSelect();
  renderHome();
  renderAdminSemisList();
});
onSnapshot(query(colMatches, orderBy("date")), snap=>{
  state.matches = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderMatches();
  renderTables();
  renderPlayerDetails();
  renderHome();
  renderAdminSemisList();
});
onSnapshot(query(colPosts, orderBy("createdAt","desc")), snap=>{
  state.posts = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderPosts();
  renderHome();
});
onSnapshot(query(colChat, orderBy("createdAt","desc")), snap=>{
  const now = Date.now();
  state.chat = snap.docs
    .map(d => ({ id:d.id, ...d.data() }))
    .filter(m => !m.expireAt || (m.expireAt.toDate ? m.expireAt.toDate().getTime() : new Date(m.expireAt).getTime()) > now);
  renderChat();
});

// ========== Estatísticas (só fase de grupos conta 3/1/0) ==========
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

// ========== Home (4 partidas hoje ou do próximo dia com partidas) ==========
function renderHome(){
  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const scheduled = state.matches.filter(m => !!m.date).slice(); // já ordenado por 'date'
  const today = new Date(); const start = new Date(today); start.setHours(0,0,0,0);
  const end   = new Date(today); end.setHours(23,59,59,999);
  const isSameDay = (a,b)=> a.getFullYear()==b.getFullYear() && a.getMonth()==b.getMonth() && a.getDate()==b.getDate();

  let pick = scheduled.filter(m=>{ const d = new Date(m.date); return d>=start && d<=end; });
  if(pick.length===0){
    // encontra o próximo dia futuro com partidas
    let nextDay = null;
    for(const m of scheduled){
      const d = new Date(m.date);
      if(d > end){ nextDay = d; break; }
    }
    if(nextDay){
      pick = scheduled.filter(m => isSameDay(new Date(m.date), nextDay));
    }
  }
  pick = pick.slice(0,4);

  const rows = pick.map(m=>`
    <tr>
      <td>${m.stage || "-"}</td>
      <td>${m.group || "-"}</td>
      <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
      <td>${fmtDateStr(m.date)}</td>
      <td>${m.code || "-"}</td>
    </tr>
  `).join("");
  const table = `
    <table>
      <thead><tr><th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data</th><th>Código</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='5'>Sem partidas hoje/próximo dia.</td></tr>"}</tbody>
    </table>`;
  if($("#home-next")) $("#home-next").innerHTML = table;

  const posts = state.posts.slice(0,3).map(p=> renderPostItem(p)).join("");
  if($("#home-posts")) $("#home-posts").innerHTML = posts || `<p class="muted">Sem comunicados.</p>`;
}

// ========== Players (separado por Grupo + busca + seleção) ==========
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
  if($("#players-cards-A")) $("#players-cards-A").innerHTML = byGroup.A.join("") || `<p class="muted">Sem jogadores.</p>`;
  if($("#players-cards-B")) $("#players-cards-B").innerHTML = byGroup.B.join("") || `<p class="muted">Sem jogadores.</p>`;

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

// ========== Tabela de Pontos ==========
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

// ========== Partidas (organizado) ==========
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
          const res = m.result==="A"? mapP[m.aId] : m.result==="B"? mapP[m.bId] : m.result==="draw"? "Empate" : "Pendente";
          return `<tr data-id="${m.id}">
            <td>${m.stage||"-"}</td>
            <td>${m.group||"-"}</td>
            <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
            <td>${fmtDateStr(m.date)}</td>
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
  if(box){ box.innerHTML = html; if(state.admin){ $$(".btn-edit").forEach(b => b.onclick = () => loadMatchToForm(b.dataset.id)); } }
}
$("#filter-stage")?.addEventListener("change", renderMatches);

// ========== Admin: Players CRUD ==========
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
  if(confirm("Excluir jogador?")) await deleteDoc(doc(db,"players",id));
  $("#player-form").reset(); $("#player-id").value = "";
});

// ========== Admin: Matches CRUD ==========
async function loadMatchToForm(id){
  const m = state.matches.find(x=>x.id===id);
  if(!m) return;
  $("#match-id").value = m.id;
  $("#match-a").value = m.aId || "";
  $("#match-b").value = m.bId || "";
  $("#match-stage").value = m.stage || "groups";
  $("#match-group").value = m.group || "";
  // ✅ Data só muda se usuário editar
  $("#match-date").value = m.date || "";
  $("#match-date-orig").value = m.date || "";
  $("#match-date").dataset.dirty = "false";
  $("#match-date").oninput = ()=> $("#match-date").dataset.dirty = "true";
  $("#match-code").value = m.code || "";
  $("#match-result").value = m.result || "";
  showTab("partidas");
}
$("#match-reset")?.addEventListener("click", ()=>{ $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false"; });
$("#match-delete")?.addEventListener("click", async ()=>{
  const id = $("#match-id").value;
  if(!id) return;
  if(confirm("Excluir partida?")) await deleteDoc(doc(db,"matches",id));
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
  if(!isEdit){
    payload.date = dateVal;           // criação grava se houver
  }else if(dateDirty){
    payload.date = dateVal;           // edição só muda se editou
  }

  try{
    const id = $("#match-id").value;
    if(id) await updateDoc(doc(db,"matches",id), payload);
    else await addDoc(collection(db,"matches"), payload);
    $("#match-form").reset(); $("#match-id").value=""; $("#match-date").dataset.dirty="false";
  }catch(err){ alert("Erro: "+err.message); }
});

// ========== Posts (sem anexo) ==========
$("#post-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  const title = $("#post-title").value.trim();
  const body  = $("#post-body").value.trim();
  try{
    await addDoc(collection(db,"posts"), {
      title, body,
      createdAt: serverTimestamp(),
      author: state.profile?.displayName || auth.currentUser?.displayName || auth.currentUser?.email || "admin"
    });
    $("#post-form").reset();
  }catch(err){ alert("Erro ao publicar: "+err.message); }
});
function renderPostItem(p){
  return `
    <div class="post">
      <div>
        <h3>${p.title}</h3>
        <p class="muted" style="margin-top:-6px">${p.author || ""} · ${p.createdAt?.toDate ? p.createdAt.toDate().toLocaleString("pt-BR") : ""}</p>
        <p>${(p.body||"").replace(/\n/g,"<br>")}</p>
      </div>
    </div>
  `;
}
function renderPosts(){
  const html = state.posts.map(renderPostItem).join("");
  if($("#posts-list")) $("#posts-list").innerHTML = html || `<p class="muted">Sem comunicados.</p>`;
}

// ========== Chat (expira 24h) ==========
$("#chat-form")?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  if(!auth.currentUser){ alert("Entre para enviar mensagens."); return; }
  const text = $("#chat-text").value.trim();
  if(!text) return;
  const expireAt = new Date(Date.now() + 24*60*60*1000);
  await addDoc(collection(db,"chat"), {
    text,
    author: state.profile?.displayName || auth.currentUser.displayName || auth.currentUser.email,
    username: state.profile?.username || null,
    createdAt: serverTimestamp(),
    expireAt
  });
  $("#chat-text").value = "";
});
function renderChat(){
  const html = state.chat.map(m=>{
    const when = m.createdAt?.toDate ? m.createdAt.toDate().toLocaleString("pt-BR") : "";
    const who = m.username ? `${m.author} (@${m.username})` : m.author;
    return `<div class="chat-item">
      <div class="meta">${who} · ${when}</div>
      <div>${(m.text||"").replace(/\n/g,"<br>")}</div>
    </div>`;
  }).join("");
  if($("#chat-list")) $("#chat-list").innerHTML = html || `<p class="muted">Sem mensagens nas últimas 24h.</p>`;
}

// ========== Perfil — render ==========
function renderProfile(){
  if(!$("#profile-form")) return;
  const u = state.user;
  $("#profile-email").value = u?.email || "";
  $("#profile-name").value = (state.profile?.displayName) || (u?.displayName) || "";
  const userTag = state.profile?.username ? `@${state.profile.username}` : "—";
  const el = $("#profile-username");
  if(el) el.textContent = userTag;
}

// ========== Admin: Semifinais ==========
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
      <td>${fmtDateStr(m.date)}</td>
      <td>${m.code||"-"}</td>
      <td>${m.result||"Pendente"}</td>
    </tr>
  `).join("");
  const html = `
    <table>
      <thead><tr><th>Semifinal</th><th>Data</th><th>Código</th><th>Resultado</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='4'>Nenhuma semifinal cadastrada.</td></tr>"}</tbody>
    </table>`;
  if($("#semi-list")) $("#semi-list").innerHTML = html;
}

// ========== Seed Example (admin only) ==========
$("#seed-btn")?.addEventListener("click", async ()=>{
  if(!state.admin){ alert("Apenas admins."); return; }
  if(!confirm("Adicionar dados de exemplo?")) return;

  // Players
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

  // Matches da Fase de Grupos — string 'YYYY-MM-DDTHH:mm' (ordem estável)
  const now = new Date();
  const base = (h)=>{ const d=new Date(now.getTime()+h*3600000); return d.toISOString().slice(0,16); };

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
      date: base(i++), code:`GA-${i}`, result:null
    });
  }
  for(const [a,b] of roundsB){
    await addDoc(collection(db,"matches"),{
      aId:nameToId[a], bId:nameToId[b], stage:"groups", group:"B",
      date: base(i++), code:`GB-${i}`, result:null
    });
  }

  // Posts e chat
  await addDoc(collection(db,"posts"), { title:"Bem-vindos!", body:"Início do campeonato. Boa sorte a todos!", createdAt: serverTimestamp(), author: auth.currentUser?.displayName || auth.currentUser?.email || "admin" });
  await addDoc(collection(db,"posts"), { title:"Regras", body:"Pontuação 3-1-0 (fase de grupos). Top-2 avança (G2).", createdAt: serverTimestamp(), author: auth.currentUser?.displayName || auth.currentUser?.email || "admin" });

  const expireAt = new Date(Date.now() + 24*60*60*1000);
  await addDoc(collection(db,"chat"), { text:"Chat aberto! Respeito e esportividade. ♟️", author: auth.currentUser?.displayName || auth.currentUser?.email || "admin", username: state.profile?.username || null, createdAt: serverTimestamp(), expireAt });

  alert("Seed concluído!");
});
