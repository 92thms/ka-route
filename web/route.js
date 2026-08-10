"use strict";

const CONFIG = window.CONFIG || {};
const MAINTENANCE_MODE = Boolean(CONFIG.MAINTENANCE_MODE);
const appEl=document.getElementById("app");
const maintenanceEl=document.getElementById("maintenance");
let maintenanceKey=sessionStorage.getItem("maintenanceKey")||"";

function apiFetch(resource, options={}){
  const headers=new Headers(options.headers||{});
  if(maintenanceKey) headers.set("X-Maintenance-Key",maintenanceKey);
  return fetch(resource,{...options,headers});
}

async function unlockMaintenance(key){
  const response=await fetch('/api/maintenance-auth',{
    method:'POST',
    headers:{'X-Maintenance-Key':key}
  });
  if(!response.ok) return false;
  maintenanceKey=key;
  sessionStorage.setItem("maintenanceKey",key);
  maintenanceEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  return true;
}

if(MAINTENANCE_MODE){
  maintenanceEl.classList.remove("hidden");
  if(maintenanceKey) unlockMaintenance(maintenanceKey).catch(()=>{});
  document.getElementById("btnMaintenance").addEventListener("click",async()=>{
    const input=document.getElementById("maintenanceKey");
    const valid=await unlockMaintenance(input.value.trim()).catch(()=>false);
    if(!valid){ input.value=""; input.focus(); }
  });
}else{
  appEl.classList.remove("hidden");
}

let rKm = 15;
let stepKm = 25;

(function setupPresets(){
  const group = document.getElementById('presetChips');
  const hint  = document.getElementById('presetHint');
  if(!group) return;
  function activate(chip){
    group.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    stepKm = parseInt(chip.dataset.step, 10);
    rKm    = parseInt(chip.dataset.radius, 10);
    if(hint) hint.textContent = `${stepKm} km Abstand · ${rKm} km Radius`;
  }
  group.querySelectorAll('.preset-chip').forEach(chip=>{
    if(parseInt(chip.dataset.step,10)===stepKm && parseInt(chip.dataset.radius,10)===rKm){
      activate(chip);
    }
    chip.addEventListener('click', ()=> activate(chip));
  });
})();

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

// Map
const map = L.map('map').setView([48.7, 9.18], 7);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
  attribution:'© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
  subdomains:'abcd', maxZoom:19
}).addTo(map);
let routeLayer;
const resultMarkers = L.layerGroup().addTo(map);
const searchMarkers = L.layerGroup().addTo(map);

// Shorthands
const $=sel=>document.querySelector(sel);
const startGroup=$("#grpStart"), zielGroup=$("#grpZiel"), queryGroup=$("#grpQuery"), settingsGroup=$("#grpSettings"), runGroup=$("#grpRun"), resetGroup=$("#grpReset"), mapBox=$("#map-box"), routeLoading=$("#routeLoading"), resultsBox=$("#results"), resultGallery=$("#resultGallery");
const filterPriceMin=$("#filterPriceMin"), filterPriceMax=$("#filterPriceMax"), sortPriceBtn=$("#sortPrice"), groupBtn=$("#toggleGrouping"), clearPinBtn=$("#clearPinFilter"), analyticsBox=$("#analytics");
const queryWarn=$("#queryWarn");
$("#query").addEventListener('input',()=>queryWarn.classList.add('hidden'));

  async function updateAnalytics(){
    try{
      const stats=await apiFetch('/api/stats').then(r=>r.json()).catch(()=>({}));
      const parts=[];
      if(stats.searches_saved!=null) parts.push(`gestartete Suchen: ${stats.searches_saved}`);
      if(stats.listings_found!=null) parts.push(`gecrawlte Inserate: ${stats.listings_found}`);
      if(stats.visitors!=null) parts.push(`Besucher gesamt: ${stats.visitors}`);
      analyticsBox.textContent=parts.join(' · ');
    }catch(_){
      analyticsBox.textContent='';
    }
  }

  updateAnalytics();

// Kategorien werden direkt aus dem Inserat geparst, daher keine Vorab-Liste nötig
// Progress-Helfer
function setProgress(pct){
  const bar = $("#progressBar"), txt = $("#progressText");
  const clamped = Math.max(0, Math.min(100, pct|0));
  bar.style.width = clamped + "%";
  txt.textContent = clamped + "%";
}
function setProgressState(state /* 'active' | 'done' | 'aborted' */, msg){
  const bar = $("#progressBar"), txt = $("#progressText");
  bar.classList.remove("active","done","partial","aborted");
  if(state) bar.classList.add(state);
  if(msg) txt.textContent = msg;
}

// -------- Status (nur Konsole) --------
function setStatus(msg,isErr=false){ (isErr?console.error:console.log)(msg); }
function resetStatus(){}
function setRouteLoading(visible){ routeLoading.classList.toggle("hidden", !visible); }

// -------- Ergebnisliste: gruppiert + Galerie --------
const groups = new Map(); // key -> details element
let groupByLocation = false;

function ensureGroup(loc){
  const key=loc||"Unbekannt";
  if(groups.has(key)) return groups.get(key);
  const wrap=document.createElement('details');
  wrap.className='groupbox'; wrap.open=false;
  wrap.innerHTML=`<summary>${escapeHtml(key)} <span class="badge" data-count="0">0</span></summary><div class="gbody"><div class="gallery"></div></div>`;
  resultsBox.appendChild(wrap);
  groups.set(key, wrap);
  return wrap;
}
let lastRenderedIdx = 0;

function clearResults(){
  const r=resultsBox;
  r.querySelectorAll('.groupbox').forEach(el=>el.remove());
  resultGallery.innerHTML='';
  resultMarkers.clearLayers();markerClusters.length=0;activeCluster=null;
  searchMarkers.clearLayers();
  if(clearPinBtn) clearPinBtn.classList.add('hidden');
  groups.clear();
  lastRenderedIdx=0;
}
function addResultGalleryGroup(loc, cardHtml, clusterId){
  const box=ensureGroup(loc);
  const gallery=box.querySelector('.gallery');
  const item=document.createElement('div');
  item.className='gallery-item';
  item.innerHTML=cardHtml;
  if(clusterId!=null) item.dataset.cluster=clusterId;
  gallery.appendChild(item);
  const badge=box.querySelector('.badge');
  badge.textContent=String(Number(badge.textContent)+1);
}

// Ergebnisdaten und Filter/Sortierung
const resultItems=[];
let sortField='price';
let sortDir=1; // 1=asc, -1=desc

const GROUP_NONE=0, GROUP_LOCATION=1, GROUP_CATEGORY=2;
let groupMode=GROUP_LOCATION;

const ICONS={
  location:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
  category:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle></svg>`,
  ungroup:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M3 9h18"></path><path d="M3 15h18"></path><path d="M9 3v18"></path><path d="M15 3v18"></path></svg>`,
  euro:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12"></path><path d="M4 14h9"></path><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"></path></svg>`,
  arrowUp:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>`,
  arrowDown:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path></svg>`
};

groupBtn.innerHTML=ICONS.category;
groupBtn.title='Nach Kategorie gruppieren';

function parsePriceVal(str){
  const cleaned=String(str).replace(/VB/i,'').replace(/€/g,'').replace(/\u00a0/g,'').trim();
  if(cleaned==='') return 0;
  const num=parseFloat(cleaned.replace(/\./g,'').replace(',', '.'));
  return Number.isNaN(num)?0:num;
}

function parsePriceInput(str){
  const cleaned=str.replace(/\./g,'').replace(/,/g,'.').replace(/[^0-9.]/g,'');
  const num=parseFloat(cleaned);
  return Number.isNaN(num)?null:num;
}

function formatPriceInput(el){
  const val=parsePriceInput(el.value);
  if(val!==null){ el.value=new Intl.NumberFormat('de-DE').format(val); }
}

function updateSortButtons(){
  sortPriceBtn.innerHTML=ICONS.euro+(sortField==='price'?(sortDir===1?ICONS.arrowUp:ICONS.arrowDown):'');
}

function appendNewResults(){
  const min=parsePriceInput(filterPriceMin.value.trim());
  const max=parsePriceInput(filterPriceMax.value.trim());
  const newItems=resultItems.slice(lastRenderedIdx);
  lastRenderedIdx=resultItems.length;
  newItems.forEach(it=>{
    if(activeCluster!==null && it.clusterId!==activeCluster) return;
    if(min!==null && it.priceVal<min) return;
    if(max!==null && it.priceVal>max) return;
    if(groupMode===GROUP_NONE){
      resultGallery.classList.remove('hidden');
      const item=document.createElement('div');
      item.className='gallery-item';
      item.innerHTML=it.cardHtml;
      if(it.clusterId!=null) item.dataset.cluster=it.clusterId;
      resultGallery.appendChild(item);
    }else{
      resultGallery.classList.add('hidden');
      const key=groupMode===GROUP_LOCATION?it.label:(it.category||'Unbekannt');
      addResultGalleryGroup(key,it.cardHtml,it.clusterId);
    }
  });
}

function renderResults(){
  resultsBox.querySelectorAll('.groupbox').forEach(el=>el.remove());
  groups.clear();
  resultGallery.innerHTML='';
  lastRenderedIdx=resultItems.length;
  let arr=resultItems;
  if(activeCluster===null){
    const min=parsePriceInput(filterPriceMin.value.trim());
    const max=parsePriceInput(filterPriceMax.value.trim());
    arr=arr.filter(it=>{
      if(min!==null && it.priceVal<min) return false;
      if(max!==null && it.priceVal>max) return false;
      return true;
    });
    if(sortField==='price'){
      arr.sort((a,b)=> (a.priceVal-b.priceVal)*sortDir);
    }
  }else{
    arr=arr.filter(it=>it.clusterId===activeCluster);
  }
  if(groupMode===GROUP_NONE){
    resultGallery.classList.remove('hidden');
    const frag=document.createDocumentFragment();
    arr.forEach(it=>{
      const item=document.createElement('div');
      item.className='gallery-item';
      item.innerHTML=it.cardHtml;
      if(it.clusterId!=null) item.dataset.cluster=it.clusterId;
      frag.appendChild(item);
    });
    resultGallery.appendChild(frag);
  }else{
    resultGallery.classList.add('hidden');
    arr.forEach(it=>{
      const key=groupMode===GROUP_LOCATION?it.label:(it.category||'Unbekannt');
      addResultGalleryGroup(key,it.cardHtml,it.clusterId);
    });
  }
}

filterPriceMin.addEventListener('input',()=>highlightCluster(null));
filterPriceMax.addEventListener('input',()=>highlightCluster(null));
filterPriceMin.addEventListener('blur',()=>{formatPriceInput(filterPriceMin);highlightCluster(null);});
filterPriceMax.addEventListener('blur',()=>{formatPriceInput(filterPriceMax);highlightCluster(null);});
sortPriceBtn.addEventListener('click',()=>{
  if(sortField==='price'){sortDir*=-1;}else{sortField='price';sortDir=1;}
  updateSortButtons();
  highlightCluster(null);
});
groupBtn.addEventListener('click',()=>{
  groupMode=(groupMode+1)%3;
  if(groupMode===GROUP_NONE){
    groupBtn.innerHTML=ICONS.location;
    groupBtn.title='Nach Ort gruppieren';
  }else if(groupMode===GROUP_LOCATION){
    groupBtn.innerHTML=ICONS.category;
    groupBtn.title='Nach Kategorie gruppieren';
  }else{
    groupBtn.innerHTML=ICONS.ungroup;
    groupBtn.title='Gruppierung aufheben';
  }
  highlightCluster(null);
});
updateSortButtons();

function clearInputFields(){
  ['start','ziel','query'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.value=''; delete el.dataset.lat; delete el.dataset.lon; }
  });
  filterPriceMin.value='';
  filterPriceMax.value='';
  queryWarn.classList.add('hidden');
}

$("#btnReset").addEventListener('click', () => {
  clearInputFields();
  runGroup.classList.remove("hidden");
  resetGroup.classList.add("hidden");
  startGroup.classList.remove("hidden");
  zielGroup.classList.remove("hidden");
  queryGroup.classList.remove("hidden");
  settingsGroup.classList.remove("hidden");
  mapBox.classList.add("hidden");
  resultsBox.classList.add("hidden");
  if(routeLayer){ map.removeLayer(routeLayer); routeLayer=null; }
  clearResults();
  groupMode=GROUP_LOCATION;
  groupBtn.innerHTML=ICONS.category;
  groupBtn.title='Nach Kategorie gruppieren';
  sortField='price';
  sortDir=1;
  updateSortButtons();
  setProgress(0);
  setProgressState(null,"0%");
});


// -------- Debounce --------
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

// -------- Autocomplete --------
async function fetchPlaceSuggestions(text, size=5){
  text=text.trim();
  if(!text) return [];
  try{
    const url=`/ors/geocode/autocomplete?text=${encodeURIComponent(text)}&boundary.country=DE&size=${size}`;
    const res=await apiFetch(url,{headers:{"Accept":"application/json"}});
    if(!res.ok) throw new Error("ORS autocomplete failed");
    const j=await res.json();
    return j?.features?.map(f=>({
      label:f.properties?.label,
      lon:Number(f.geometry?.coordinates?.[0]),
      lat:Number(f.geometry?.coordinates?.[1])
    })).filter(item=>item.label&&isDeCoord(item.lat,item.lon))||[];
  }catch(_){
    try{
      const url=`https://nominatim.openstreetmap.org/search?format=json&limit=${size}&addressdetails=1&countrycodes=de&q=${encodeURIComponent(text)}`;
      const j=await fetchJsonViaProxy(url);
      return j?.map(r=>({
        label:r.display_name,
        lon:Number(r.lon),
        lat:Number(r.lat)
      })).filter(item=>item.label&&isDeCoord(item.lat,item.lon))||[];
    }catch(_){ return []; }
  }
}

function selectPlace(inp, item){
  inp.value=item.label;
  inp.dataset.lon=String(item.lon);
  inp.dataset.lat=String(item.lat);
  document.getElementById(inp.id+"-suggest").hidden=true;
}

async function selectFirstSuggestion(inp){
  const lat=Number(inp.dataset.lat), lon=Number(inp.dataset.lon);
  if(isDeCoord(lat,lon)) return true;
  const suggestions=await fetchPlaceSuggestions(inp.value,1);
  if(!suggestions.length) return false;
  selectPlace(inp,suggestions[0]);
  return true;
}

function setupSuggest(id){
  const inp=document.getElementById(id);
  const list=document.getElementById(id+"-suggest");
  if(!inp||!list) return;
  const render=items=>{
    list.innerHTML="";
    if(!items.length){ list.hidden=true; return; }
    items.forEach(item=>{
      const li=document.createElement("li");
      li.textContent=item.label;
      li.addEventListener("mousedown",()=>selectPlace(inp,item));
      list.appendChild(li);
    });
    list.hidden=false;
  };
  const fetchSuggestions=debounce(async text=>{
    text=text.trim();
    if(!text){ render([]); return; }
    const suggestions=await fetchPlaceSuggestions(text);
    render(suggestions);
  },300);
  inp.addEventListener("input",e=>{
    delete inp.dataset.lat;
    delete inp.dataset.lon;
    fetchSuggestions(e.target.value);
  });
  inp.addEventListener("blur",()=>setTimeout(()=>list.hidden=true,100));
}

setupSuggest("start");
setupSuggest("ziel");

// -------- Distanz-Helpers --------
function haversine(lat1,lon1,lat2,lon2){
  const R=6371e3, toRad=d=>d*Math.PI/180;
  const φ1=toRad(lat1), φ2=toRad(lat2), dφ=toRad(lat2-lat1), dλ=toRad(lon2-lon1);
  const a=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// --- Marker-Gruppierung (nahe beieinander) ---
const markerClusters = []; // {id, lat, lon, marker}
function distMeters(aLat, aLon, bLat, bLon){
  const R=6371e3, toRad=d=>d*Math.PI/180;
  const dφ=toRad(bLat-aLat), dλ=toRad(bLon-aLon);
  const φ1=toRad(aLat), φ2=toRad(bLat);
  const x=Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function addListingToClusters(lat, lon){
  let existing = markerClusters.find(c => distMeters(c.lat,c.lon,lat,lon) < 200); // 200 m
  if(existing){
    return existing;
  } else {
    const marker = L.marker([lat,lon],{icon:greenIcon}).addTo(resultMarkers);
    const cluster = {id: markerClusters.length, lat, lon, marker};
    markerClusters.push(cluster);
    marker.on('click', () => highlightCluster(cluster.id));
    return cluster;
  }
}

let activeCluster = null;
function revealClusterResults(clusterId){
  requestAnimationFrame(()=>{
    resultsBox.querySelectorAll('.groupbox').forEach(box=>{ box.open=true; });
    const firstResult=resultsBox.querySelector(`[data-cluster="${clusterId}"]`);
    (firstResult||resultsBox).scrollIntoView({behavior:'smooth',block:'start'});
  });
}

function highlightCluster(id){
  if(activeCluster !== null){
    const prev = markerClusters[activeCluster];
    if(prev){
      prev.marker.setIcon(greenIcon);
    }
  }
  activeCluster = (id!==null && markerClusters[id]!=null) ? id : null;
  renderResults();
  document.querySelectorAll(`[data-cluster]`).forEach(el=>el.classList.remove('highlight'));
  if(activeCluster!==null){
    const cluster = markerClusters[activeCluster];
    cluster.marker.setIcon(activeIcon);
    document.querySelectorAll(`[data-cluster="${activeCluster}"]`).forEach(el=>el.classList.add('highlight'));
    clearPinBtn.classList.remove('hidden');
    revealClusterResults(activeCluster);
  }else{
    clearPinBtn.classList.add('hidden');
  }
}

clearPinBtn.addEventListener('click', () => highlightCluster(null));

map.on('click', () => highlightCluster(null));

// ---- Route-Index & Distanzberechnung ----
function toXY(lat,lon){
  return [lon*111320*Math.cos(lat*Math.PI/180), lat*110540];
}
function distPointSegMeters(lat, lon, seg){
  const [x,y]=toXY(lat,lon);
  const [x1,y1]=toXY(seg.lat1, seg.lon1);
  const [x2,y2]=toXY(seg.lat2, seg.lon2);
  const A=x-x1,B=y-y1,C=x2-x1,D=y2-y1;
  const dot=A*C+B*D;
  const len_sq=C*C+D*D;
  let param=-1;
  if(len_sq!==0) param=dot/len_sq;
  let xx,yy;
  if(param<0){xx=x1;yy=y1;} else if(param>1){xx=x2;yy=y2;} else {xx=x1+param*C;yy=y1+param*D;}
  const dx=x-xx, dy=y-yy;
  return Math.sqrt(dx*dx+dy*dy);
}
function minDistToRouteMeters(lat, lon, coords){
  if(!coords||coords.length<2) return Infinity;
  let min=Infinity;
  for(let i=1;i<coords.length;i++){
    const seg={lat1:coords[i-1][1],lon1:coords[i-1][0],lat2:coords[i][1],lon2:coords[i][0]};
    const d=distPointSegMeters(lat,lon,seg);
    if(d<min) min=d;
  }
  return min;
}
// -------- Proxy fetch --------
async function fetchViaProxy(url){
  const prox=`/proxy?u=${encodeURIComponent(url)}`;
  const opts={credentials:'omit',cache:'no-store'};
  if(abortCtrl) opts.signal=abortCtrl.signal;
  const r=await apiFetch(prox,opts);
  if(!r.ok){const txt=await r.text().catch(()=>String(r.status));throw new Error(`Proxy HTTP ${r.status}${txt?": "+txt.slice(0,80):""}`);}
  return r.text();
}

// Proxy-Helfer für JSON-Antworten
async function fetchJsonViaProxy(url){
  const txt = await fetchViaProxy(url);
  try{
    return JSON.parse(txt);
  }catch(err){
    throw new Error("Proxy JSON parse error: "+err.message);
  }
}

// -------- Preisformat --------
function formatPrice(p){
  if(!p) return "VB";
  const n=String(p).trim();
  if(n==='') return "VB";
  const hasVB=/VB/i.test(n);
  const cleaned=n.replace(/VB/i,'').replace(/€/g,'').trim();
  if(cleaned==='') return 'VB';
  const num=parseFloat(cleaned.replace(/\./g,'').replace(',', '.'));
  if(Number.isNaN(num)) return 'VB';
  const formatted=new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(num).replace(/\u00a0/g,'');
  return hasVB?`${formatted} VB`:formatted;
}

// -------- Parsing --------
function cityFromAddr(a){return a?.city||a?.town||a?.village||a?.municipality||a?.county||'';}
function safeParse(json){try{return JSON.parse(json);}catch(_){return null;}}
// Validate a coordinate pair falls inside Germany (rough bbox).
// Filters out NaN, 0, ocean placeholders, and other junk from regex fallbacks.
function isDeCoord(la, lo){
  return typeof la === 'number' && typeof lo === 'number'
      && isFinite(la) && isFinite(lo)
      && la > 47 && la < 56 && lo > 5 && lo < 16;
}
function isPlz(p){ return typeof p === 'string' && /^\d{5}$/.test(p); }
async function parseListingDetails(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const title=doc.querySelector('meta[property="og:title"]')?.content||doc.title||null;
  let image=doc.querySelector('meta[property="og:image"]')?.content||null;
  let postal=null, locationLabel=null, lat=null, lon=null, price=null;
  let categories=[];

  // Kategorien aus Breadcrumb
  categories=[...doc.querySelectorAll('.breadcrump-link')].map(el=>el.textContent.trim()).filter(Boolean);

  // 1) Kleinanzeigen exposes the listing's own (privacy-rounded) coordinates here.
  const ogLat=parseFloat(doc.querySelector('meta[property="og:latitude"]')?.content||'');
  const ogLon=parseFloat(doc.querySelector('meta[property="og:longitude"]')?.content||'');
  if(isDeCoord(ogLat,ogLon)){ lat=ogLat; lon=ogLon; }

  // 2) JSON-LD — trusted structured source
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
    try{
      const obj=JSON.parse(s.textContent);
      const addr=obj.address||obj.itemOffered?.address||obj.offers?.seller?.address;
      if(addr && !postal){
        const cand=String(addr.postalCode||addr.postcode||addr.zip||'');
        if(isPlz(cand)) postal=cand;
      }
      if(!image && obj.image){ image=Array.isArray(obj.image)?obj.image[0]:(typeof obj.image==='string'?obj.image:null); }
      const entries=Array.isArray(obj)?obj:[obj,...(Array.isArray(obj?.['@graph'])?obj['@graph']:[])];
      for(const entry of entries){
        const offer=Array.isArray(entry?.offers)?entry.offers[0]:entry?.offers;
        const amount=offer?.price ?? entry?.price;
        if(price===null && amount!==undefined && amount!==null && String(amount).trim()){
          price=String(amount).trim();
        }
      }
      const g=obj.geo||obj.location||obj.address?.geo;
      if(g){
        const la=parseFloat(g.latitude||g.lat); const lo=parseFloat(g.longitude||g.lon||g.lng);
        if(isDeCoord(la,lo)){ lat=lat??la; lon=lon??lo; }
      }
    }catch(_){}
  });

  // 3) __INITIAL_STATE__ — trusted structured source
  if(!postal||lat===null||lon===null){
    doc.querySelectorAll('script').forEach(s=>{
      const t=s.textContent||'';
      if(t.includes('__INITIAL_STATE__')){
        const start=t.indexOf('{'), end=t.lastIndexOf('}');
        if(start>=0&&end>start){
          const st=safeParse(t.slice(start,end+1));
          const a=st?.ad?.adAddress||st?.adInfo?.address||st?.adData?.address||null;
          if(a){
            if(!postal){
              const cand=String(a.postalCode||a.postcode||a.zipCode||'');
              if(isPlz(cand)) postal=cand;
            }
            const g=a.geo||a.coordinates||a.location;
            if(g){
              const la=parseFloat(g.lat||g.latitude); const lo=parseFloat(g.lon||g.lng||g.longitude);
              if(isDeCoord(la,lo)){ lat=lat??la; lon=lon??lo; }
            }
          }
        }
      }
    });
  }

  // 4) Specific meta tags for postal code (reliable, not from description text)
  if(!postal){
    const cand = doc.querySelector('meta[property="og:postal-code"]')?.content
              || doc.querySelector('meta[name="postal-code"]')?.content
              || '';
    if(isPlz(cand)) postal = cand;
  }

  // 5) Visible listing location is authoritative for postal code and city label.
  const locEl=doc.querySelector('#viewad-locality, [data-testid="ad-location"], .addetailslist--detail--value');
  if(locEl){
    const raw=locEl.textContent.replace(/\s+/g,' ').trim();
    const m=raw.match(/\b(\d{5})\b\s*(.*)$/);
    if(m){
      postal=m[1];
      const remainder=m[2].trim();
      const city=(remainder.includes(' - ')?remainder.split(' - ').pop():remainder).trim();
      locationLabel=city?`${postal} ${city}`:postal;
    }
  }

  // 6) lat/lon raw regex fallback — only if it looks like a real German coordinate
  if(lat===null||lon===null){
    const lm=html.match(/"(?:latitude|lat)"\s*:\s*([0-9.+-]+)/i);
    const lom=html.match(/"(?:longitude|lon|lng)"\s*:\s*([0-9.+-]+)/i);
    if(lm&&lom){
      const la=parseFloat(lm[1]), lo=parseFloat(lom[1]);
      if(isDeCoord(la,lo)){ lat=la; lon=lo; }
    }
  }

  // Prefer explicitly marked product prices. Never use the first arbitrary
  // Euro amount from the page: that is often the shipping charge.
  const metaPrice=doc.querySelector('meta[property="product:price:amount"]')?.content;
  if(metaPrice) price=metaPrice.trim();
  if(price===null){
    const priceEl=doc.querySelector('#viewad-price, [data-testid="ad-price"]');
    const rawPrice=priceEl?.textContent?.replace(/\s+/g,' ').trim()||'';
    const mainPrice=rawPrice.match(/\d+(?:[. ]\d{3})*(?:,\d{1,2})?\s*€(?:\s*VB)?|\bVB\b/i);
    if(mainPrice) price=mainPrice[0];
  }

  return {title,postal,locationLabel,price:price===null?null:formatPrice(price),image,lat,lon,categories};
}

const _plzLabelCache={};
async function reversePLZ(postal){
  if(_plzLabelCache[postal]) return _plzLabelCache[postal];
  let orsLat=null, orsLon=null;
  try{
    const url=`/ors/geocode/search/structured?postalcode=${encodeURIComponent(postal)}&country=DE&size=1`;
    const res=await apiFetch(url,{headers:{"Accept":"application/json"},signal:abortCtrl?.signal});
    if(res.ok){
      const j=await res.json();
      const f=j?.features?.[0];
      if(f){
        orsLat=f.geometry.coordinates[1]; orsLon=f.geometry.coordinates[0];
        const props=f.properties||{};
        const rawCity=props.locality||props.region||props.county||"";
        const badCity=/^(deutschland|germany|\d+)$/i.test(rawCity.trim());
        if(rawCity && !badCity){
          const r={lat:orsLat,lon:orsLon,display:`${postal} ${rawCity}`};
          _plzLabelCache[postal]=r; return r;
        }
      }
    }
  }catch(_){ }

  // Do not bulk-query public Nominatim for every listing. ORS coordinates or
  // no pin are preferable to rate limiting and misleading route-point pins.
  const result={lat:orsLat,lon:orsLon,display:postal};
  _plzLabelCache[postal]=result;
  return result;
}

async function geocodeTextOnce(text){
  try{
    const url=`/ors/geocode/search?text=${encodeURIComponent(text)}&boundary.country=DE&size=1`;
    const res=await apiFetch(url,{headers:{"Accept":"application/json"},signal:abortCtrl?.signal});
    if(!res.ok) throw new Error("ORS geocode failed");
    const j=await res.json();
    const f=j?.features?.[0];
    if(f){
      const lat=f.geometry.coordinates[1], lon=f.geometry.coordinates[0];
      return {lat,lon,label:f.properties.label||text};
    }
    throw new Error("No ORS result");
  }catch(_){
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=de&q=${encodeURIComponent(text)}`;
    const j=await fetchJsonViaProxy(url);
    if(j&&j[0]){const a=j[0].address||{};return {lat:+j[0].lat,lon:+j[0].lon,label:cityFromAddr(a)||text};}
  }
  return {lat:null,lon:null,label:text};
}

async function enrichListing(it,wantDetails=true){
  const baseLabel = it.label || null;
  const basePostal = isPlz(it.postal_code)?it.postal_code:(isPlz(it.plz)?it.plz:null);

  let lat=null, lon=null;
  let postal = basePostal;
  let label = baseLabel;
  let hasListingLabel=Boolean(baseLabel);
  const listingPrice=String(it.price||'').trim();
  let price = formatPrice(listingPrice);
  let image=null, categories=null, category=null;

  if(wantDetails){
    try{
      const html=await fetchViaProxy(it.url);
      const det=await parseListingDetails(html);
      if(det.title) it.title=det.title;
      // The search-result card already contains the authoritative listing
      // price. Detail pages also contain shipping amounts, so only fall back
      // to their price when the search result has none.
      if(!listingPrice && det.price) price=det.price;
      if(det.image) image=det.image;
      if(isPlz(det.postal)) postal=det.postal;
      if(det.locationLabel){ label=det.locationLabel; hasListingLabel=true; }
      // Best source: exact coordinates from the listing's own detail page
      if(isDeCoord(det.lat, det.lon)){ lat=det.lat; lon=det.lon; }
      categories=det.categories;
      if(det.categories&&det.categories.length){ category=det.categories[det.categories.length-1]; }
    }catch(_){}
  }

  // Geocode the listing's own PLZ — gives city name and PLZ-centroid coords.
  // Use the PLZ centroid only when the detail page has no usable coordinates.
  if(postal && (!isDeCoord(lat,lon) || !hasListingLabel)){
    try{
      const g=await reversePLZ(postal);
      const hasCity=s=>typeof s==='string' && /\S+\s+\S/.test(s.trim());
      if(!hasListingLabel && hasCity(g.display)) label=g.display;
      else if(!hasCity(label)) label=g.display||postal;
      if(!isDeCoord(lat,lon) && isDeCoord(g.lat,g.lon)){ lat=g.lat; lon=g.lon; }
    }catch(_){}
  }

  // Never fabricate a listing pin from the route search point.
  if(!label) label=postal||"?";

  return {lat,lon,label,price,image,postal,categories,category};
}

// SVG marker factory — no external CDN dependency
function makeSvgIcon(color, size=28){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32" width="${size}" height="${size*32/24}"><path d="M12 0C7.163 0 3 4.163 3 9c0 7 9 23 9 23S21 16 21 9C21 4.163 16.837 0 12 0z" fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="0.8"/><circle cx="12" cy="9" r="3.5" fill="white" opacity="0.9"/></svg>`;
  return L.icon({iconUrl:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg),iconSize:[size,size*32/24],iconAnchor:[size/2,size*32/24]});
}
const greenIcon =makeSvgIcon('#4ade80');
const blueIcon  =makeSvgIcon('#6a8fff');
const redIcon   =makeSvgIcon('#f87171');
const activeIcon=makeSvgIcon('#a9cf45');

// ---------- ROBUSTER MOBILE-FETCH FÜR /api/inserate ----------
async function fetchApiInserate(q, plz, rKm) {
  const params=new URLSearchParams({query:q,location:plz,radius:rKm});
  const paramStr=params.toString();
  const tries=[
    `${window.location.origin}/api/inserate?${paramStr}`,
    `/api/inserate?${paramStr}`
  ];

  async function tryOnce(url, useMode) {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 10000);
    let onAbort;
    if(abortCtrl){
      onAbort=()=>ctrl.abort();
      abortCtrl.signal.addEventListener('abort', onAbort);
    }
    try{
      const resp = await apiFetch(url, {
        method: "GET",
        headers: { "Accept":"application/json" },
        cache: "no-store",
        credentials: "omit",
        ...(useMode ? { mode: "same-origin" } : {}),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    }catch(e){
      clearTimeout(t);
      throw e;
    }finally{
      if(abortCtrl && onAbort) abortCtrl.signal.removeEventListener('abort', onAbort);
    }
  }

  for(const url of tries){
    for(const useMode of [true,false]){
      try{ return await tryOnce(url,useMode); }catch(_){}
    }
  }
  await new Promise(r=>setTimeout(r,300));
  return tryOnce(tries[1], false);
}

// ---------- Start/Stop ----------
let running=false;
let resolvingPlaces=false;
let runCounter=0;
let abortCtrl=null;
$("#btnRun").addEventListener("click",()=>{
  if(running){
    running=false;
    runCounter++;
    if(abortCtrl) abortCtrl.abort();
    setStatus("Suche abgebrochen.", true);
    setRouteLoading(false);
    setProgressState("aborted", "Abgebrochen");
    $("#btnRun").textContent="Route berechnen & suchen";
    startGroup.classList.remove("hidden");
    zielGroup.classList.remove("hidden");
    queryGroup.classList.remove("hidden");
    settingsGroup.classList.remove("hidden");
    runGroup.classList.add("hidden");
    resetGroup.classList.remove("hidden");
  } else {
    run();
  }
});

// Enter startet die Suche, wenn Felder gefüllt sind
["start","ziel","query"].forEach(id=>{
  const el=document.getElementById(id);
  if(!el) return;
  el.addEventListener("keydown",e=>{
    if(e.key==="Enter"){
      e.preventDefault();
      if(!running) run();
    }
  });
});

async function run(){
  if(resolvingPlaces) return;
  queryWarn.classList.add('hidden');
  const q=$("#query").value.trim();
  let startText=$("#start").value.trim();
  let zielText=$("#ziel").value.trim();
  if(!q){
    queryWarn.classList.remove('hidden');
    setStatus("Bitte Suchbegriff eingeben.", true);
    return;
  }
  if(!startText || !zielText){
    setStatus("Bitte Start und Ziel eingeben.", true);
    return;
  }
  resolvingPlaces=true;
  $("#btnRun").disabled=true;
  $("#btnRun").textContent="Orte prüfen …";
  try{
    await Promise.all([
      selectFirstSuggestion($("#start")),
      selectFirstSuggestion($("#ziel"))
    ]);
    startText=$("#start").value.trim();
    zielText=$("#ziel").value.trim();
  }finally{
    resolvingPlaces=false;
    $("#btnRun").disabled=false;
    $("#btnRun").textContent="Route berechnen & suchen";
  }
  const myRun=++runCounter;
  abortCtrl=new AbortController();
  running=true; $("#btnRun").textContent="Abbrechen";
  startGroup.classList.add("hidden");
  zielGroup.classList.add("hidden");
  queryGroup.classList.add("hidden");
  settingsGroup.classList.add("hidden");
  mapBox.classList.remove("hidden");
  $("#results").classList.remove("hidden");
  map.invalidateSize();
  clearResults();
  setRouteLoading(true);
  setProgressState("active");
  setProgress(0);

  try{
    const payload={start:startText, ziel:zielText, query:q, radius:rKm, step:stepKm};
    const startLat=Number($("#start").dataset.lat), startLon=Number($("#start").dataset.lon);
    const zielLat=Number($("#ziel").dataset.lat), zielLon=Number($("#ziel").dataset.lon);
    if(isDeCoord(startLat,startLon)) payload.start_coordinates=[startLon,startLat];
    if(isDeCoord(zielLat,zielLon)) payload.ziel_coordinates=[zielLon,zielLat];
    const resp=await apiFetch('/api/route-search',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
      signal:abortCtrl.signal
    });
    let data=null;
    try{ data=await resp.json(); }catch(_){ }
    if(!resp.ok){
      const detail=data && data.detail ? `: ${data.detail}` : '';
      throw new Error(`HTTP ${resp.status}${detail}`);
    }
    data=data||{};
    setRouteLoading(false);
    const coords=data.route||[];
    if(routeLayer) map.removeLayer(routeLayer);
    if(coords.length){
      routeLayer=L.polyline(coords.map(c=>[c[1],c[0]]),{weight:5,color:'#1e66f5'}).addTo(map);
      map.fitBounds(routeLayer.getBounds(),{padding:[32,32],maxZoom:11});
      const startLatLng=[coords[0][1],coords[0][0]];
      const zielLatLng=[coords[coords.length-1][1],coords[coords.length-1][0]];
      L.marker(startLatLng,{icon:blueIcon}).addTo(resultMarkers).bindPopup("Start");
      L.marker(zielLatLng,{icon:redIcon}).addTo(resultMarkers).bindPopup("Ziel");
    }
    const searchPoints=Array.isArray(data.search_points)?data.search_points:[];
    searchPoints.forEach(point=>{
      const lat=Number(point.lat), lon=Number(point.lon);
      if(!isDeCoord(lat,lon)) return;
      const place=[point.postal_code,point.city].filter(Boolean).join(' ');
      L.circleMarker([lat,lon],{
        radius:5,
        color:'#86b817',
        weight:2,
        fillColor:'#86b817',
        fillOpacity:0.8
      }).addTo(searchMarkers).bindTooltip(
        `Suchpunkt · ${escapeHtml(place||'?')} · ${rKm} km Radius`
      );
    });
    const items=data.listings||[];
    const coverage=data.coverage||{};
    if(items.length===0 && data.scrape_errors?.length){
      throw new Error(`Scraper-Fehler: ${data.scrape_errors[0].slice(0,120)}`);
    }
    let added=0;
    resultItems.length=0;
    for(let i=0;i<items.length;i++){
      const it=items[i];
      if(abortCtrl?.signal.aborted) break;
      const info=await enrichListing(it,true);
      const hasCoords = info.lat!=null && info.lon!=null;
      const label=info.label||it.postal_code||it.plz||"?";
      const imgHtml=info.image?`<img src="${escapeHtml(info.image)}" alt="" loading="lazy">`:"";
      const catName=info.category||'';
      const locText=label||"";
      const cardHtml=`${imgHtml}<div class="card-body"><a href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(it.title)}</strong></a>${info.price?`<div class="price">${escapeHtml(info.price)}</div>`:''}<div class="meta">${catName?escapeHtml(catName):''}${catName&&locText?' · ':''}${locText?escapeHtml(locText):''}</div></div>`;

      if(hasCoords){
        const cluster=addListingToClusters(info.lat,info.lon);
        resultItems.push({label,cardHtml,priceVal:parsePriceVal(info.price),category:catName,clusterId:cluster.id});
      } else {
        console.error('No trustworthy listing coordinates for '+it.url);
        resultItems.push({label,cardHtml,priceVal:parsePriceVal(info.price),category:catName,clusterId:null});
      }
      added++;
      appendNewResults();
      setProgress(Math.min(100, Math.round(((i+1)/items.length)*100)));
    }
    const routeSamples=Number(coverage.route_samples||0);
    const resolvedSamples=Number(coverage.resolved_samples||0);
    const searchLocations=Number(coverage.search_locations||0);
    const successfulSearches=Number(coverage.successful_searches||0);
    const failedSearches=Number(coverage.failed_searches||0);
    const isPartial=failedSearches>0 || (routeSamples>0 && resolvedSamples<routeSamples);
    const coverageText=searchLocations>0?` · ${successfulSearches}/${searchLocations} Suchorte`:'';
    if(isPartial){
      setStatus("Suche nur teilweise abgeschlossen.",true);
      setProgressState("partial", `Teilweise – ${added} Inserate${coverageText}`);
    }else{
      setStatus("Fertig.");
      setProgressState("done", `Fertig – ${added} Inserate${coverageText}`);
    }
    runGroup.classList.add("hidden");
    resetGroup.classList.remove("hidden");
  }catch(e){
    setRouteLoading(false);
    if(myRun===runCounter){
      setStatus(e.message,true);
      const errMsg=e.name==='AbortError'?'Abgebrochen':(e.message||'Unbekannter Fehler').slice(0,90);
      setProgressState("aborted", errMsg);
      runGroup.classList.add("hidden");
      resetGroup.classList.remove("hidden");
    }
  }
  running=false; $("#btnRun").textContent="Route berechnen & suchen"; abortCtrl=null;
  updateAnalytics();
}
