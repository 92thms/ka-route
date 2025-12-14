"use strict";

const CONFIG = window.CONFIG || {};
const MAINTENANCE_MODE = Boolean(CONFIG.MAINTENANCE_MODE);
const MAINTENANCE_KEY = CONFIG.MAINTENANCE_KEY || "";
const USE_ORS_REVERSE = Boolean(CONFIG.USE_ORS_REVERSE);
const appEl=document.getElementById("app");
const maintenanceEl=document.getElementById("maintenance");
if(MAINTENANCE_MODE && MAINTENANCE_KEY){
  const saved=localStorage.getItem("maintenanceKey");
  if(saved===MAINTENANCE_KEY){
    appEl.classList.remove("hidden");
  }else{
    maintenanceEl.classList.remove("hidden");
    document.getElementById("btnMaintenance").addEventListener("click",()=>{
      const val=document.getElementById("maintenanceKey").value.trim();
      if(val===MAINTENANCE_KEY){
        localStorage.setItem("maintenanceKey",val);
        maintenanceEl.classList.add("hidden");
        appEl.classList.remove("hidden");
      }
    });
  }
}else{
  appEl.classList.remove("hidden");
}

const radiusOptions=[0,5,20];
const stepOptions=[5,10,20];
let rKm = radiusOptions[0];
let stepKm = stepOptions[0];
// Alle Nominatim-Anfragen werden über einen Proxy geleitet,
// daher sind keine speziellen Header mehr nötig.
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
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);
let routeLayer;
const resultMarkers = L.layerGroup().addTo(map);

// Shorthands
const $=sel=>document.querySelector(sel);
const startGroup=$("#grpStart"), zielGroup=$("#grpZiel"), queryGroup=$("#grpQuery"), settingsGroup=$("#grpSettings"), runGroup=$("#grpRun"), resetGroup=$("#grpReset"), mapBox=$("#map-box"), resultsBox=$("#results"), resultGallery=$("#resultGallery");
const radiusInput=$("#radius"), stepInput=$("#step"), radiusVal=$("#radiusVal"), stepVal=$("#stepVal"), filterPriceMin=$("#filterPriceMin"), filterPriceMax=$("#filterPriceMax"), sortPriceBtn=$("#sortPrice"), groupBtn=$("#toggleGrouping"), analyticsBox=$("#analytics");
const queryWarn=$("#queryWarn");
const radiusIdx=radiusOptions.indexOf(rKm);
radiusInput.min=0; radiusInput.max=radiusOptions.length-1; radiusInput.step=1;
radiusInput.value=radiusIdx>=0?radiusIdx:1;
radiusVal.textContent=radiusOptions[radiusInput.value];
const stepIdx=stepOptions.indexOf(stepKm);
stepInput.min=0; stepInput.max=stepOptions.length-1; stepInput.step=1;
stepInput.value=stepIdx>=0?stepIdx:1;
stepVal.textContent=stepOptions[stepInput.value];
radiusInput.addEventListener('input',()=>radiusVal.textContent=radiusOptions[radiusInput.value]);
stepInput.addEventListener('input',()=>stepVal.textContent=stepOptions[stepInput.value]);
$("#query").addEventListener('input',()=>queryWarn.classList.add('hidden'));

async function fetchRateLimits(){
    try{
      const [geoRes,dirRes]=await Promise.all([
        fetch(`/ors/geocode/autocomplete?text=Berlin&boundary.country=DE&size=1`,{headers:{"Accept":"application/json"}}),
        fetch(`/ors/v2/directions/driving-car?start=8.681495,49.41461&end=8.687872,49.420318`,{headers:{"Accept":"application/json"}})
      ]);
      return{
        geocode:{limit:geoRes.headers.get("x-ratelimit-limit"),remaining:geoRes.headers.get("x-ratelimit-remaining")},
        directions:{limit:dirRes.headers.get("x-ratelimit-limit"),remaining:dirRes.headers.get("x-ratelimit-remaining")}
      };
    }catch(_){
      return{};
    }
  }

  async function updateAnalytics(){
    try{
      const [stats,limits]=await Promise.all([
        fetch('/api/stats').then(r=>r.json()).catch(()=>({})),
        fetchRateLimits()
      ]);
      const parts=[];
      if(stats.searches_saved!=null) parts.push(`gestartete Suchen: ${stats.searches_saved}`);
      if(stats.listings_found!=null) parts.push(`gecrawlte Inserate: ${stats.listings_found}`);
      if(stats.visitors!=null) parts.push(`Besucher gesamt: ${stats.visitors}`);
      if(limits.geocode&&limits.geocode.limit&&limits.geocode.remaining&&limits.directions&&limits.directions.limit&&limits.directions.remaining){
        parts.push(`API-Limits Geocode ${limits.geocode.remaining}/${limits.geocode.limit}, Directions ${limits.directions.remaining}/${limits.directions.limit}`);
      }
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
  bar.classList.remove("active","done","aborted");
  if(state) bar.classList.add(state);
  if(msg) txt.textContent = msg;
}

// -------- Status (nur Konsole) --------
function setStatus(msg,isErr=false){ (isErr?console.error:console.log)(msg); }
function resetStatus(){}

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
function clearResults(){
  const r=resultsBox;
  r.querySelectorAll('.groupbox').forEach(el=>el.remove());
  resultGallery.innerHTML='';
  resultMarkers.clearLayers();markerClusters.length=0;activeCluster=null;
  groups.clear();
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
let groupMode=GROUP_NONE;

const ICONS={
  location:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
  category:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle></svg>`,
  ungroup:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M3 9h18"></path><path d="M3 15h18"></path><path d="M9 3v18"></path><path d="M15 3v18"></path></svg>`,
  euro:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12"></path><path d="M4 14h9"></path><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"></path></svg>`,
  arrowUp:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>`,
  arrowDown:`<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path></svg>`
};

groupBtn.innerHTML=ICONS.location;

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

function renderResults(){
  resultsBox.querySelectorAll('.groupbox').forEach(el=>el.remove());
  groups.clear();
  resultGallery.innerHTML='';
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
  groupMode=GROUP_NONE;
  groupBtn.innerHTML=ICONS.location;
  groupBtn.title='Nach Ort gruppieren';
  sortField='price';
  sortDir=1;
  updateSortButtons();
  setProgress(0);
  setProgressState(null,"0%");
});


// -------- Debounce --------
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

// -------- Autocomplete --------
function setupSuggest(id){
  const inp=document.getElementById(id);
  const list=document.getElementById(id+"-suggest");
  if(!inp||!list) return;
  const render=items=>{
    list.innerHTML="";
    if(!items.length){ list.hidden=true; return; }
    items.forEach(txt=>{
      const li=document.createElement("li");
      li.textContent=txt;
      li.addEventListener("mousedown",()=>{ inp.value=txt; list.hidden=true; });
      list.appendChild(li);
    });
    list.hidden=false;
  };
  const fetchSuggestions=debounce(async text=>{
    text=text.trim();
    if(!text){ render([]); return; }
    let labels=[];
    try{
      const url=`/ors/geocode/autocomplete?text=${encodeURIComponent(text)}&boundary.country=DE&size=5`;
      const res=await fetch(url,{headers:{"Accept":"application/json"}});
      if(!res.ok) throw new Error("ORS autocomplete failed");
      const j=await res.json();
      labels=j?.features?.map(f=>f.properties.label).filter(Boolean)||[];
    }catch(_){
      try{
        const url=`https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&countrycodes=de&q=${encodeURIComponent(text)}`;
        const j=await fetchJsonViaProxy(url);
        labels=j?.map(r=>r.display_name).filter(Boolean)||[];
      }catch(_){ labels=[]; }
    }
    render(labels);
  },300);
  inp.addEventListener("input",e=>fetchSuggestions(e.target.value));
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
    cluster.marker.setIcon(orangeIcon);
    document.querySelectorAll(`[data-cluster="${activeCluster}"]`).forEach(el=>el.classList.add('highlight'));
  }
}

map.on('click', () => highlightCluster(null));

// ---- Route-Index & Distanzberechnung ----
async function loadRBush(){
  if(window.RBush) return window.RBush;
  await new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/rbush@3.0.1/rbush.min.js';
    s.onload=res; s.onerror=rej; document.head.appendChild(s);
  });
  return window.RBush;
}
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
  const r=await fetch(prox,opts);
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
async function parseListingDetails(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const title=doc.querySelector('meta[property="og:title"]')?.content||doc.title||null;
  let image=doc.querySelector('meta[property="og:image"]')?.content||null;
  let postal=null, cityText=null, lat=null, lon=null;
  let categories=[];

  // Kategorien aus Breadcrumb
  categories=[...doc.querySelectorAll('.breadcrump-link')].map(el=>el.textContent.trim()).filter(Boolean);

  // 1) JSON-LD
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
    try{
      const obj=JSON.parse(s.textContent);
      const addr=obj.address||obj.itemOffered?.address||obj.offers?.seller?.address;
      if(addr){
        postal=postal||addr.postalCode||addr.postcode||addr.zip;
        cityText=cityText||addr.addressLocality||addr.city||addr.town;
      }
      if(!image && obj.image){ image=Array.isArray(obj.image)?obj.image[0]:(typeof obj.image==='string'?obj.image:null); }
      const g=obj.geo||obj.location||obj.address?.geo;
      if(g){
        const la=parseFloat(g.latitude||g.lat); const lo=parseFloat(g.longitude||g.lon||g.lng);
        if(!Number.isNaN(la)&&!Number.isNaN(lo)){ lat=lat??la; lon=lon??lo; }
      }
    }catch(_){}
  });

  // 2) __INITIAL_STATE__
  if(!postal||!cityText||lat===null||lon===null){
    doc.querySelectorAll('script').forEach(s=>{
      const t=s.textContent||'';
      if(t.includes('__INITIAL_STATE__')){
        const start=t.indexOf('{'), end=t.lastIndexOf('}');
        if(start>=0&&end>start){
          const st=safeParse(t.slice(start,end+1));
          const a=st?.ad?.adAddress||st?.adInfo?.address||st?.adData?.address||null;
          if(a){
            postal=postal||a.postalCode||a.postcode||a.zipCode;
            cityText=cityText||a.city||a.town||a.addressLocality;
            const g=a.geo||a.coordinates||a.location;
            if(g){
              const la=parseFloat(g.lat||g.latitude); const lo=parseFloat(g.lon||g.lng||g.longitude);
              if(!Number.isNaN(la)&&!Number.isNaN(lo)){ lat=lat??la; lon=lon??lo; }
            }
          }
        }
      }
    });
  }

  // 3) Fallbacks
  if(!cityText){
    const metaDesc = doc.querySelector('meta[property="og:description"], meta[name="description"]')?.content || '';
    const descMatch = metaDesc.match(/(\d{5})\s+[A-Za-zÄÖÜäöüß .'-]{1,80}/);
    if(descMatch){
      postal = postal || descMatch[1];
      const parts = descMatch[0].replace(descMatch[1],'').trim().split(/\s+-\s+|-/);
      const last = parts[parts.length-1]?.trim();
      if(last && !/anzeige/i.test(last)){ cityText = last; }
    }
  }
  if(!cityText){
    const ogLoc = doc.querySelector('meta[property="og:locality"]')?.content || '';
    if(ogLoc){
      let cand = ogLoc.split('-').pop()?.trim().replace(/_/g,' ') || '';
      if(cand && !/anzeige/i.test(cand)){ cityText = cand; }
    }
  }
  if(!cityText || !postal){
    const metaDesc = doc.querySelector('meta[property="og:description"], meta[name="description"]')?.content || '';
    const descMatch = metaDesc.match(/(\d{5})[^-]{0,50}-\s*([A-Za-zÄÖÜäöüß .'-]{2,})/);
    if(descMatch){
      postal = postal || descMatch[1];
      const cand = descMatch[2].trim();
      if(cand && !/anzeige/i.test(cand)){ cityText = cityText || cand; }
    }
  }
  if(!postal){
    const m = html.match(/"(?:postalCode|postcode|zip|zipCode|zipcode)"\s*:\s*"?(\d{5})"?/i);
    if(m) postal = m[1];
  }
  if(!cityText){
    // Beispiel: "78607 Baden-Württemberg - Talheim" -> Talheim (letzter Teil hinter dem Bindestrich)
    const textSrc = doc.body?.innerText || doc.body?.textContent || html;
    const m = textSrc.match(/\b\d{5}[^\n]{0,200}?[-–—]\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß .'-]{1,})/);
    if(m){
      let cand=m[1].trim();
      if(cand.includes("-")){
        const parts=cand.split("-").map(s=>s.trim()).filter(Boolean);
        if(parts.length) cand=parts[parts.length-1];
      }
      // Filter Off-Targets wie "Anzeige"
      if(!/anzeige/i.test(cand) && cand.length>1){
        cityText = cand;
      }
    }
  }
  if(!postal){
    const ctx=/(\bplz\b|postleitzahl|postal(?:code)?|adresse|address|standort|ort|stadt|gemeinde|wohnort)/i;
    const matches=[...html.matchAll(/\b(\d{5})\b/g)].map(m=>({code:m[1],idx:m.index||0}));
    const filtered=matches.filter(({code,idx})=>{
      const left=Math.max(0,idx-100), right=Math.min(html.length,idx+100);
      const win=html.slice(left,right);
      const prev=html[idx-1]||'', next=html[idx+5]||'';
      const neighborsBad=/[-A-Za-z]/.test(prev)||/[-A-Za-z]/.test(next);
      const looksLikePrice=new RegExp(code+'[\\s\\/,\\.-]*€').test(win);
      const hasContext=ctx.test(win);
      return !neighborsBad && !looksLikePrice && hasContext;
    });
    if(filtered.length) postal=filtered[0].code;
  }
  if(lat===null||lon===null){
    const lm=html.match(/"(?:latitude|lat)"\s*:\s*([0-9.+-]+)/i);
    const lom=html.match(/"(?:longitude|lon|lng)"\s*:\s*([0-9.+-]+)/i);
    if(lm&&lom){ lat=parseFloat(lm[1]); lon=parseFloat(lom[1]); }
  }

  // Preis
  let price=null;
  let vb=html.match(/id=['"]viewad-price['"][^>]*>\s*([^<]*VB[^<]*)</i);
  if(vb){
    price=vb[1].replace(/\s+/g,' ').trim();
  } else {
    let pm= html.match(/"price":"([^"]+)"/i)
          ||html.match(/<meta[^>]+property=['"]product:price:amount['"][^>]*content=['"]([^'"]+)['"]/i)
          ||html.match(/([0-9][0-9\., ]* ?€)/);
    if(pm) price=pm[1].toString().trim();
  }

  return {title,postal,cityText,price:formatPrice(price),image,lat,lon,categories};
}

async function reversePLZ(postal){
  try{
    const url=`/ors/geocode/search/structured?postalcode=${encodeURIComponent(postal)}&country=DE&size=1`;
    const res=await fetch(url,{headers:{"Accept":"application/json"},signal:abortCtrl?.signal});
    if(res.ok){
      const j=await res.json();
      const f=j?.features?.[0];
      if(f){
        const lat=f.geometry.coordinates[1], lon=f.geometry.coordinates[0];
        const props=f.properties||{};
        const city=props.locality||props.region||props.name||"";
        if(city && !/deutschland/i.test(city)){
          return {lat,lon,display:`${postal}${city?` ${city}`:""}`};
        }
      }
    }
  }catch(_){ }

  try{
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=de&postalcode=${encodeURIComponent(postal)}`;
    const j=await fetchJsonViaProxy(url);
    if(j&&j[0]){
      const a=j[0].address||{};
      const city=cityFromAddr(a);
      return {lat:+j[0].lat,lon:+j[0].lon,display:`${postal}${city?` ${city}`:''}`};
    }
  }catch(_){ }

  return {lat:null,lon:null,display:postal};
}

async function geocodeTextOnce(text){
  try{
    const url=`/ors/geocode/search?text=${encodeURIComponent(text)}&boundary.country=DE&size=1`;
    const res=await fetch(url,{headers:{"Accept":"application/json"},signal:abortCtrl?.signal});
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
  let lat=it.lat??null,lon=it.lon??null;
  let price=formatPrice(it.price||"");
  let postal=null,cityText=null,label=it.label||null,image=null,categories=null,category=null;

  if(wantDetails){
    try{
      const html=await fetchViaProxy(it.url);
      const det=await parseListingDetails(html);
      if(det.title) it.title=det.title;
      if(det.price) price=det.price;
      if(det.image) image=det.image;
      postal=det.postal; cityText=det.cityText;
      if(det.lat!=null && det.lon!=null){ lat=det.lat; lon=det.lon; }
      categories=det.categories;
      if(det.categories&&det.categories.length){ category=det.categories[det.categories.length-1]; }
    }catch(e){ setStatus("Proxy/Parse-Fehler: "+e.message,true); }
  }

  if(!postal && it.plz){ postal = it.plz; }

  if((lat===null||lon===null) && (postal || cityText)){
    if(postal){
      const g=await reversePLZ(postal);
      lat=g.lat;lon=g.lon;
      if(!label) label=g.display;
    } else if(cityText){
      const g=await geocodeTextOnce(cityText+", Deutschland");
      lat=g.lat;lon=g.lon;
      if(!label) label=g.label;
    }
  }

  // Fallback auf Route-Koordinaten nur wenn gar nichts anderes da ist
  if((lat===null||lon===null) && it.lat!=null && it.lon!=null){
    lat=it.lat; lon=it.lon;
  }

  if(postal && cityText){
    label = `${postal} ${cityText}`.trim();
  } else if(cityText){
    label = cityText;
  } else if(postal){
    label = postal;
  }
  if(!label && it.label){ label = it.label; }
  return {lat,lon,label,price,image,postal,categories,category};
}

// Icons
const greenIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/green-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const blueIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/blue-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const redIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/red-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const orangeIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/orange-dot.png",iconSize:[32,32],iconAnchor:[16,32]});

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
      const resp = await fetch(url, {
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
let runCounter=0;
let abortCtrl=null;
$("#btnRun").addEventListener("click",()=>{
  if(running){
    running=false;
    runCounter++;
    if(abortCtrl) abortCtrl.abort();
    setStatus("Suche abgebrochen.", true);
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
  queryWarn.classList.add('hidden');
  const q=$("#query").value.trim();
  const startText=$("#start").value.trim();
  const zielText=$("#ziel").value.trim();
  rKm = radiusOptions[Number(radiusInput.value)] || rKm;
  stepKm = stepOptions[Number(stepInput.value)] || stepKm;
  if(!q){
    queryWarn.classList.remove('hidden');
    setStatus("Bitte Suchbegriff eingeben.", true);
    return;
  }
  if(!startText || !zielText){
    setStatus("Bitte Start und Ziel eingeben.", true);
    return;
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
  setProgressState("active");
  setProgress(0);

  try{
    const payload={start:startText, ziel:zielText, query:q, radius:rKm, step:stepKm};
    const resp=await fetch('/api/route-search',{
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
    const coords=data.route||[];
    if(routeLayer) map.removeLayer(routeLayer);
    if(coords.length){
      routeLayer=L.polyline(coords.map(c=>[c[1],c[0]]),{weight:5,color:'#1e66f5'}).addTo(map);
      map.fitBounds(routeLayer.getBounds());
      const startLatLng=[coords[0][1],coords[0][0]];
      const zielLatLng=[coords[coords.length-1][1],coords[coords.length-1][0]];
      L.marker(startLatLng,{icon:blueIcon}).addTo(resultMarkers).bindPopup("Start");
      L.marker(zielLatLng,{icon:redIcon}).addTo(resultMarkers).bindPopup("Ziel");
    }
    const items=data.listings||[];
    let added=0;
    resultItems.length=0;
    for(let i=0;i<items.length;i++){
      const it=items[i];
      if(abortCtrl?.signal.aborted) break;
      const info=await enrichListing(it,true);
      const hasCoords = info.lat!=null && info.lon!=null;
      const label=info.label||it.plz||"?";
      const imgHtml=info.image?`<img src="${escapeHtml(info.image)}" alt="">`:"";
      const catName=info.category||'Unbekannt';
      const locText=label||"Unbekannt";
      const cardHtml=`${imgHtml}<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(it.title)}</strong></a><div class="muted">${escapeHtml(info.price)} – ${escapeHtml(catName)}<br>${escapeHtml(locText)}</div>`;

      if(hasCoords){
        const cluster=addListingToClusters(info.lat,info.lon);
        resultItems.push({label,cardHtml,priceVal:parsePriceVal(info.price),category:catName,clusterId:cluster.id});
      } else {
        // Kein Geotag: trotzdem in der Liste zeigen, aber ohne Karte/Cluster
        resultItems.push({label,cardHtml,priceVal:parsePriceVal(info.price),category:catName,clusterId:null});
      }
      added++;
      renderResults();
      setProgress(Math.min(100, Math.round(((i+1)/items.length)*100)));
    }
    setStatus("Fertig.");
    setProgressState("done", `Fertig – ${added} Inserate`);
    runGroup.classList.add("hidden");
    resetGroup.classList.remove("hidden");
  }catch(e){
    if(myRun===runCounter){
      setStatus(e.message,true);
      setProgressState("aborted","Abgebrochen");
      runGroup.classList.add("hidden");
      resetGroup.classList.remove("hidden");
    }
  }
  running=false; $("#btnRun").textContent="Route berechnen & suchen"; abortCtrl=null;
  updateAnalytics();
}
