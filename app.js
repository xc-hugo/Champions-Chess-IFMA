import {
  auth, db, loginEmailPassword, logout, watchAuth, isAdmin,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, serverTimestamp
} from "./firebase.js";

// ======= UI Helpers =======
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function showTab(id){
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  $$(".view").forEach(v => v.classList.toggle("visible", v.id === id));
  location.hash = id;
}
function fmtDate(ts){
  try{
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toLocaleString("pt-BR");
  }catch(e){ return "—"; }
}
function option(el, value, label){
  const o = document.createElement("option");
  o.value = value; o.textContent = label;
  el.appendChild(o);
}

// ======= State =======
let state = {
  user: null,
  admin: false,
  players: [],   // {id, name, group}
  matches: [],   // {id, aId, bId, date, group, stage, result, code}
  posts: []      // {id, title, body, createdAt}
};

// ======= Auth UI =======
const loginModal = $("#login-modal");
$("#btn-open-login").onclick = () => loginModal.classList.remove("hidden");
$("#close-login").onclick = () => loginModal.classList.add("hidden");

$("#login-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const email = $("#login-email").value.trim();
  const pass = $("#login-password").value.trim();
  try{
    await loginEmailPassword(email, pass);
    loginModal.classList.add("hidden");
  }catch(err){
    alert("Erro ao entrar: " + err.message);
  }
});

$("#btn-logout").onclick = async () => { await logout(); };

// ======= Tabs routing =======
$$(".tab").forEach(b => b.onclick = () => showTab(b.dataset.tab));
if(location.hash){ showTab(location.hash.replace("#","")); }

// ======= Watch Auth =======
watchAuth(async (user)=>{
  state.user = user;
  $("#btn-open-login").classList.toggle("hidden", !!user);
  $("#btn-logout").classList.toggle("hidden", !user);
  $("#user-chip").classList.toggle("hidden", !user);
  $("#user-email").textContent = user ? user.email : "";

  state.admin = user ? await isAdmin(user.uid) : false;
  $("#admin-badge").classList.toggle("hidden", !state.admin);
  $("#tab-admin").classList.toggle("hidden", !state.admin);
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !state.admin));
});

// ======= Firestore listeners =======
const colPlayers = collection(db, "players");
const colMatches = collection(db, "matches");
const colPosts   = collection(db, "posts");

onSnapshot(query(colPlayers, orderBy("name")), snap=>{
  state.players = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderPlayers();
  fillPlayersSelects();
  renderTables();
  renderPlayerSelect();
});
onSnapshot(query(colMatches, orderBy("date")), snap=>{
  state.matches = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderMatches();
  renderTables();
  renderPlayerDetails();
});
onSnapshot(query(colPosts, orderBy("createdAt","desc")), snap=>{
  state.posts = snap.docs.map(d => ({ id:d.id, ...d.data() }));
  renderPosts();
});

// ======= Renderers =======
function renderPlayers(){
  const el = $("#players-list");
  const rows = state.players.map(p => `
    <tr>
      <td>${p.name}</td>
      <td>${p.group || "-"}</td>
    </tr>
  `).join("");
  el.innerHTML = `<table><thead><tr><th>Nome</th><th>Grupo</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPlayerSelect(){
  const sel = $("#player-select");
  sel.innerHTML = "";
  option(sel, "", "— selecione —");
  state.players.forEach(p => option(sel, p.id, p.name));
  sel.onchange = renderPlayerDetails;
}

function statsFromMatches(){
  // Build stats by player id
  const stats = {};
  for(const p of state.players){
    stats[p.id] = {
      id: p.id, name: p.name, group: p.group,
      points:0, wins:0, draws:0, losses:0,
      winsOver: {} // name -> count
    };
  }
  for(const m of state.matches){
    if(m.stage !== "groups") continue; // somente fase de grupos na tabela
    const a = stats[m.aId], b = stats[m.bId];
    if(!a || !b) continue;
    if(m.result === "A"){
      a.points+=3; a.wins++; b.losses++;
      a.winsOver[b.name] = (a.winsOver[b.name]||0)+1;
    }else if(m.result === "B"){
      b.points+=3; b.wins++; a.losses++;
      b.winsOver[a.name] = (b.winsOver[a.name]||0)+1;
    }else if(m.result === "draw"){
      a.points+=1; b.points+=1; a.draws++; b.draws++;
    }
  }
  return stats;
}

function renderTables(){
  const stats = statsFromMatches();
  const groups = {A:[], B:[]};
  for(const id in stats){
    const s = stats[id];
    (groups[s.group]||[]).push(s);
  }
  ["A","B"].forEach(g=>{
    const arr = (groups[g]||[]).sort((x,y)=>{
      if(y.points!==x.points) return y.points - x.points;
      if(y.wins!==x.wins) return y.wins - x.wins;
      return x.name.localeCompare(y.name);
    });
    const rows = arr.map((s,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${s.name}</td>
        <td>${s.points}</td>
        <td>${s.wins}</td>
        <td>${s.draws}</td>
        <td>${s.losses}</td>
      </tr>`).join("");
    $(`#table-${g}`).innerHTML = `
      <table>
        <thead><tr><th>#</th><th>Jogador</th><th>Pts</th><th>V</th><th>E</th><th>D</th></tr></thead>
        <tbody>${rows || ""}</tbody>
      </table>`;
  });
}

function renderPlayerDetails(){
  const id = $("#player-select").value;
  const box = $("#player-details");
  if(!id){ box.innerHTML = `<p class="muted">Selecione um jogador para ver detalhes.</p>`; return; }
  const s = statsFromMatches()[id];
  if(!s){ box.innerHTML = `<p class="muted">Sem dados.</p>`; return; }
  const wins = Object.entries(s.winsOver).map(([name,c])=>`<span class="pill">Venceu ${name} ×${c}</span>`).join("") || "<span class='muted'>Sem vitórias registradas.</span>";
  box.innerHTML = `
    <p><b>${s.name}</b> — Grupo ${s.group}</p>
    <p>Pontos: <b>${s.points}</b> · V: <b>${s.wins}</b> · E: <b>${s.draws}</b> · D: <b>${s.losses}</b></p>
    <div>${wins}</div>
  `;
}

function renderMatches(){
  const stageF = $("#filter-stage").value;
  const groupF = $("#filter-group").value;

  let arr = state.matches.slice();
  if(stageF !== "all") arr = arr.filter(m => m.stage === stageF);
  if(groupF !== "all") arr = arr.filter(m => (m.group||"") === groupF);

  const mapP = Object.fromEntries(state.players.map(p=>[p.id,p.name]));
  const rows = arr.map(m=>{
    const res = m.result === "A" ? mapP[m.aId]
              : m.result === "B" ? mapP[m.bId]
              : m.result === "draw" ? "Empate" : "Pendente";
    return `<tr data-id="${m.id}">
      <td>${m.stage || "-"}</td>
      <td>${m.group || "-"}</td>
      <td>${mapP[m.aId]||"?"} × ${mapP[m.bId]||"?"}</td>
      <td>${fmtDate(m.date)}</td>
      <td>${m.code || "-"}</td>
      <td>${res}</td>
      ${state.admin ? `<td><button class="btn ghost btn-edit" data-id="${m.id}">Editar</button></td>` : ""}
    </tr>`;
  }).join("");

  $("#matches-list").innerHTML = `
    <table>
      <thead><tr>
        <th>Etapa</th><th>Grupo</th><th>Partida</th><th>Data/Hora</th><th>Código</th><th>Resultado</th>${state.admin?`<th>Ações</th>`:""}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  if(state.admin){
    $$(".btn-edit").forEach(b => b.onclick = () => loadMatchToForm(b.dataset.id));
  }
}
$("#filter-stage").onchange = renderMatches;
$("#filter-group").onchange = renderMatches;

// ======= Admin: Players CRUD =======
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

$("#player-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const id = $("#player-id").value;
  const data = { name: $("#player-name").value.trim(), group: $("#player-group").value };
  try{
    if(id) await updateDoc(doc(db,"players",id), data);
    else await addDoc(collection(db,"players"), data);
    $("#player-form").reset();
    $("#player-id").value = "";
  }catch(err){ alert("Erro: "+err.message); }
});
$("#player-reset").onclick = () => { $("#player-form").reset(); $("#player-id").value = ""; };
$("#player-delete").onclick = async ()=>{
  const id = $("#player-id").value;
  if(!id) return;
  if(confirm("Excluir jogador?")) await deleteDoc(doc(db,"players",id));
  $("#player-form").reset(); $("#player-id").value = "";
};

// ======= Admin: Matches CRUD =======
async function loadMatchToForm(id){
  const m = state.matches.find(x=>x.id===id);
  if(!m) return;
  $("#match-id").value = m.id;
  $("#match-a").value = m.aId || "";
  $("#match-b").value = m.bId || "";
  $("#match-stage").value = m.stage || "groups";
  $("#match-group").value = m.group || "";
  $("#match-date").value = m.date ? new Date(m.date).toISOString().slice(0,16) : "";
  $("#match-code").value = m.code || "";
  $("#match-result").value = m.result || "";
  showTab("partidas");
}
$("#match-reset").onclick = ()=>{ $("#match-form").reset(); $("#match-id").value=""; };
$("#match-delete").onclick = async ()=>{
  const id = $("#match-id").value;
  if(!id) return;
  if(confirm("Excluir partida?")) await deleteDoc(doc(db,"matches",id));
  $("#match-form").reset(); $("#match-id").value="";
};
$("#match-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const payload = {
    aId: $("#match-a").value, bId: $("#match-b").value,
    stage: $("#match-stage").value,
    group: $("#match-group").value || null,
    date: $("#match-date").value ? new Date($("#match-date").value).toISOString() : null,
    code: $("#match-code").value || null,
    result: $("#match-result").value || null
  };
  try{
    const id = $("#match-id").value;
    if(id) await updateDoc(doc(db,"matches",id), payload);
    else await addDoc(collection(db,"matches"), payload);
    $("#match-form").reset(); $("#match-id").value="";
  }catch(err){ alert("Erro: "+err.message); }
});

// ======= Admin: Posts =======
$("#post-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const title = $("#post-title").value.trim();
  const body = $("#post-body").value.trim();
  await addDoc(collection(db,"posts"), { title, body, createdAt: serverTimestamp(), author: auth.currentUser?.email || "admin" });
  $("#post-form").reset();
});
function renderPosts(){
  const html = state.posts.map(p=>`
    <article class="card" style="margin-bottom:12px">
      <h3>${p.title}</h3>
      <p class="muted" style="margin-top:-6px">${p.author || ""} · ${p.createdAt?.toDate ? p.createdAt.toDate().toLocaleString("pt-BR") : ""}</p>
      <p>${(p.body||"").replace(/\n/g,"<br>")}</p>
    </article>
  `).join("");
  $("#posts-list").innerHTML = html || `<p class="muted">Sem comunicados.</p>`;
}

// ======= Admin: Semifinais =======
$("#semi-save").onclick = async ()=>{
  const pairs = [
    { a: $("#semi1-a").value, b: $("#semi1-b").value, code: $("#semi-code").value ? $("#semi-code").value+"-1" : "SF-1" },
    { a: $("#semi2-a").value, b: $("#semi2-b").value, code: $("#semi-code").value ? $("#semi-code").value+"-2" : "SF-2" },
  ];
  for(const p of pairs){
    if(!p.a || !p.b) continue;
    await addDoc(collection(db,"matches"), { aId:p.a, bId:p.b, stage:"semifinal", date:null, group:null, code:p.code, result:null });
  }
  alert("Semifinais criadas. Ajuste datas/resultados em Partidas.");
};

// ======= Seed Example (admin only) =======
$("#seed-btn").onclick = async ()=>{
  if(!state.admin) return;
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

  // Matches according ao sorteio anterior (sem jogo = jogador folga)
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

  const baseDate = new Date(); // datas fictícias
  let i=0;
  for(const [a,b] of roundsA){
    await addDoc(collection(db,"matches"),{
      aId:nameToId[a], bId:nameToId[b], stage:"groups", group:"A",
      date: new Date(baseDate.getTime() + (i++)*36e5).toISOString(), code:`GA-${i}`, result:null
    });
  }
  for(const [a,b] of roundsB){
    await addDoc(collection(db,"matches"),{
      aId:nameToId[a], bId:nameToId[b], stage:"groups", group:"B",
      date: new Date(baseDate.getTime() + (i++)*36e5).toISOString(), code:`GB-${i}`, result:null
    });
  }

  alert("Seed concluído!");
};

// ======= Players form fill on row click (optional enhancement) =======
$("#players-list").addEventListener("click", (e)=>{
  const tr = e.target.closest("tr"); if(!tr) return;
  const name = tr.children[0]?.textContent;
  const p = state.players.find(x=>x.name===name);
  if(!p) return;
  $("#player-id").value = p.id;
  $("#player-name").value = p.name;
  $("#player-group").value = p.group || "A";
  showTab("players");
});
