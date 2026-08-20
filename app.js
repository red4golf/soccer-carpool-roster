const API = "https://soccer-carpool-roster.awtrescue-org.chatgpt.site/api/carpool";
const root = document.querySelector("#app");
let pin = sessionStorage.getItem("soccer-carpool-pin") || "";
let data = { events: [], players: [], drivers: [], rides: [] };
let selected = null;

const h = (value = "") => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const initials = name => name.split(/\s+/).map(n => n[0]).join("").slice(0,2).toUpperCase();
const direction = value => value === "to" ? "Drop-off" : value === "from" ? "Pickup / ride home" : "Round trip";
const shortDate = value => new Date(value + "T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"});
const longDate = value => new Date(value + "T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});
const headers = () => ({"content-type":"application/json","x-team-pin":pin});

async function api(method = "GET", body) {
  const response = await fetch(API, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not update the roster.");
  return payload;
}

function login(message = "") {
  root.innerHTML = `<main class="pinPage"><section class="pinCard"><span class="brandMark">SC</span><p class="eyebrow">SOCCER CARPOOL</p><h1>Team access</h1><p>Enter the team PIN to view rides, volunteer to drive, or request a seat.</p><form id="login"><label>Team PIN<input name="pin" value="${h(pin)}" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>${message ? `<div class="notice error" role="alert">${h(message)}</div>` : ""}<button class="primary">Open roster</button></form></section></main>`;
  document.querySelector("#login").addEventListener("submit", async event => {
    event.preventDefault(); pin = new FormData(event.target).get("pin").trim();
    try { data = await api(); sessionStorage.setItem("soccer-carpool-pin", pin); selected = data.events[0]?.id || null; render(); }
    catch (error) { login(error.message); }
  });
}

function render(notice = "") {
  const event = data.events.find(item => item.id === selected) || data.events[0] || null;
  if (event) selected = event.id;
  const drivers = data.drivers.filter(item => item.eventId === selected);
  const rides = data.rides.filter(item => item.eventId === selected);
  const players = new Map(data.players.map(item => [item.id,item]));
  const need = rides.filter(item => !item.driverId).length;
  const seats = drivers.reduce((sum,item)=>sum+item.capacity,0);
  root.innerHTML = `
    <header class="topbar"><div class="brand"><span class="brandMark">SC</span><span><b>Soccer Carpool</b><small>Team ride board</small></span></div><button class="outline small" data-open="event">+ Add event</button></header>
    <section class="hero"><div><p class="eyebrow">NO PLAYER LEFT BEHIND</p><h1>Rides sorted.<br><em>Game on.</em></h1><p class="heroCopy">One shared place for families to offer seats, request a ride, and see exactly who is riding with whom.</p><div class="heroActions"><button class="primary" data-open="driver">I can drive</button><button class="secondary" data-open="ride">My player needs a ride</button></div></div>
      <div class="scoreCard"><div class="ball">⚽</div><p>${event ? "NEXT "+event.eventType.toUpperCase() : "NEXT TEAM EVENT"}</p><strong>${event ? h(longDate(event.eventDate)) : "Add the first event"}</strong><span>${event ? h(event.departTime+" · "+event.location) : "Build the team schedule"}</span></div>
    </section>
    <section class="workspace"><div class="sectionHeading"><div><p class="eyebrow">CARPOOL BOARD</p><h2>Games & practices</h2></div><div class="summaryPills"><span><b>${need}</b> need a seat</span><span><b>${seats}</b> seats offered</span></div></div>
      ${notice ? `<div class="notice">${h(notice)}</div>` : ""}
      ${!data.events.length ? `<div class="empty"><div>⚽</div><h3>Start with the next team event</h3><p>Add a game or practice, then parents can volunteer or request a ride.</p><button class="primary" data-open="event">Add the first event</button></div>` : `
        <div class="eventTabs" role="tablist">${data.events.map(item=>`<button data-event="${item.id}" class="${item.id===selected?"active":""}"><small><span class="eventType ${item.eventType}">${h(item.eventType)}</span>${h(shortDate(item.eventDate))}</small><b>${h(item.title)}</b><span>${h(item.departTime)}</span></button>`).join("")}</div>
        <div class="eventHeader"><div><p>${h(longDate(event.eventDate))} · Depart ${h(event.departTime)}</p><h3>${h(event.title)}</h3><span>${h(event.location)} · Meet at ${h(event.meetAt)}</span></div><div class="eventButtons"><button class="outline" data-open="driver">Offer seats</button><button class="primary" data-open="ride">Request ride</button></div></div>
        <div class="boardGrid">
          <section class="boardColumn"><div class="columnTitle"><div><span class="dot green"></span><h3>Drivers</h3></div><b>${drivers.length}</b></div>
            ${drivers.length ? drivers.map(driver=>{
              const assigned=rides.filter(ride=>ride.driverId===driver.id),remaining=Math.max(0,driver.capacity-assigned.length);
              return `<article class="card"><div class="cardTop"><div class="avatar">${h(initials(driver.parentName))}</div><div><h4>${h(driver.parentName)}</h4><p>${h(direction(driver.direction))}</p></div><span class="badge">${remaining} ${remaining===1?"seat":"seats"} open</span></div>${assigned.length?`<div class="passengers"><small>RIDING WITH ${h(driver.parentName.split(" ")[0].toUpperCase())}</small>${assigned.map(ride=>`<span>✓ ${h(players.get(ride.playerId)?.name||"Player")}</span>`).join("")}</div>`:""}${driver.notes?`<p>“${h(driver.notes)}”</p>`:""}</article>`;
            }).join("") : `<div class="empty">No drivers yet. Be the first to offer seats.</div>`}
          </section>
          <section class="boardColumn"><div class="columnTitle"><div><span class="dot amber"></span><h3>Ride requests</h3></div><b>${rides.length}</b></div>
            ${rides.length ? rides.map(ride=>{
              const player=players.get(ride.playerId),options=drivers.filter(driver=>driver.id===ride.driverId||((driver.direction===ride.direction||driver.direction==="roundtrip")&&rides.filter(r=>r.driverId===driver.id).length<driver.capacity));
              return `<article class="card ${ride.driverId?"assigned":""}"><div class="cardTop"><div class="avatar player">${h(initials(player?.name||"P"))}</div><div><h4>${h(player?.name||"Player")}</h4><p>${h(direction(ride.direction))}</p></div><span class="badge ${ride.driverId?"":"waiting"}">${ride.driverId?"Matched":"Needs ride"}</span></div><label class="assign">Assigned driver<select data-assign="${ride.id}"><option value="">Unassigned</option>${options.map(driver=>`<option value="${driver.id}" ${driver.id===ride.driverId?"selected":""}>${h(driver.parentName)}</option>`).join("")}</select></label></article>`;
            }).join("") : `<div class="empty">Everyone has transportation for this event.</div>`}
          </section>
        </div>`}
    </section><footer><span>Soccer Carpool Roster</span><p>Clear rides. Happy families. Players on the pitch.</p></footer>`;
  bind();
}

function bind() {
  document.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click",()=>openModal(button.dataset.open)));
  document.querySelectorAll("[data-event]").forEach(button => button.addEventListener("click",()=>{selected=Number(button.dataset.event);render()}));
  document.querySelectorAll("[data-assign]").forEach(select => select.addEventListener("change",async()=>{
    try { await api("POST",{action:"assign",rideId:select.dataset.assign,driverId:select.value}); await refresh("Player assignment updated."); }
    catch(error){ alert(error.message); }
  }));
}

const field = (name,label,type="text",placeholder="",required=true) => `<label>${label}<input name="${name}" type="${type}" placeholder="${h(placeholder)}" ${required?"required":""}></label>`;
const trip = () => `<label>Trip<select name="direction"><option value="roundtrip">Round trip</option><option value="to">Drop-off</option><option value="from">Pickup / ride home</option></select></label>`;
const eventOptions = () => data.events.map(item=>`<option value="${item.id}" ${item.id===selected?"selected":""}>${item.eventType==="practice"?"Practice":"Game"}: ${h(item.title)} · ${h(shortDate(item.eventDate))}</option>`).join("");

function openModal(kind) {
  if ((kind==="driver"||kind==="ride")&&!data.events.length){kind="event"}
  const titles={event:"Add a game or practice",player:"Add a player",driver:"Volunteer to drive",ride:"Request a ride"};
  let fields="";
  if(kind==="event") fields=`<label>Event type<select name="eventType"><option value="game">Game</option><option value="practice">Practice</option></select></label>${field("title","Name","text","Tuesday practice or vs. Harbor United")}<div class="two">${field("eventDate","Date","date")}${field("departTime","Departure","time")}</div>${field("location","Destination","text","Battle Point Park")}${field("meetAt","Meet at","text","Clubhouse parking lot")}${field("notes","Notes","text","Field 3, wear white jerseys, etc.",false)}`;
  if(kind==="player") fields=`${field("name","Player name")}${field("guardian","Parent / guardian")}${field("phone","Best contact number","tel")}`;
  if(kind==="driver") fields=`<label>Game or practice<select name="eventId">${eventOptions()}</select></label>${field("parentName","Driver name")}${field("phone","Mobile number","tel")}<div class="two">${trip()}${field("capacity","Open seats","number")}</div>${field("notes","Pickup notes","text","Can meet at the school",false)}`;
  if(kind==="ride") fields=`<label>Game or practice<select name="eventId">${eventOptions()}</select></label>${data.players.length?`<label>Player<select name="playerId" required><option value="">Select a player</option>${data.players.map(p=>`<option value="${p.id}">${h(p.name)}</option>`).join("")}</select></label>`:`<div class="notice">Add a player first.</div><button type="button" class="outline" data-add-player>Add player</button>`}${trip()}${field("notes","Notes","text","Booster seat, alternate pickup, etc.",false)}`;
  document.body.insertAdjacentHTML("beforeend",`<div class="modalBackdrop" id="modal"><div class="modal"><button class="close" aria-label="Close">×</button><p class="eyebrow">TEAM RIDE BOARD</p><h2>${titles[kind]}</h2><form id="modalForm">${fields}<button class="primary submit">${kind==="event"?"Add event":kind==="player"?"Save player":kind==="driver"?"Offer seats":"Request ride"}</button></form></div></div>`);
  const modal=document.querySelector("#modal");
  modal.querySelector(".close").addEventListener("click",()=>modal.remove());
  modal.addEventListener("click",event=>{if(event.target===modal)modal.remove()});
  modal.querySelector("[data-add-player]")?.addEventListener("click",()=>{modal.remove();openModal("player")});
  modal.querySelector("#modalForm").addEventListener("submit",async event=>{
    event.preventDefault();
    const action=kind==="event"?"create_event":kind==="player"?"add_player":kind==="driver"?"volunteer":"request_ride";
    try{await api("POST",{action,...Object.fromEntries(new FormData(event.target))});modal.remove();await refresh("Roster updated.");}
    catch(error){alert(error.message)}
  });
}

async function refresh(notice=""){data=await api();if(!data.events.some(event=>event.id===selected))selected=data.events[0]?.id||null;render(notice)}

if(pin){api().then(payload=>{data=payload;selected=data.events[0]?.id||null;render()}).catch(()=>{sessionStorage.removeItem("soccer-carpool-pin");pin="";login()})}else login();
