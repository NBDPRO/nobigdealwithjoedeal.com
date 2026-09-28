let _di; // module-local (globals Tranche 1 — was window.*)
const STORE='nbd_dsp_v1';
const GT_KEY='nbd_gt';
const NBD_CFG='nbd_user_config';
const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const QUOTES=['The rep you don\'t want to do is the one that makes the difference.','Your competition is sleeping. Are you?','Every door is a chance. Most people don\'t even knock.','You don\'t rise to your goals — you fall to your systems.','Consistency beats intensity every single time.','One more door. One more set. One more day.','Show up. Do the work. Repeat until it\'s yours.','Champions are made on days like today.','The gap between who you are and who you want to be is what you do today.','Small daily improvements compound into staggering long-term results.'];
const HABITS=['Hit protein goal','Completed workout','Knocked doors (floor)','Journaled at night','In bed by 10 PM','Read / no screens PM','Drank 3L water','Took supplements'];
const LIFTS=['Bench Press','Squat','Deadlift','OHP','Barbell Row','Pull-Ups','Hip Thrust'];
const MEALS=['Breakfast','Lunch','Dinner','Snacks / Pre-WO'];
const KPI_DEF=[{key:'doors',lbl:'Doors Knocked',target:null,sub:'Track daily'},{key:'contacts',lbl:'Contacts Made',target:null,sub:'Track daily'},{key:'appts',lbl:'Appointments Set',target:null,sub:'Track daily'},{key:'closes',lbl:'Closes',target:null,sub:'Track daily'},{key:'noshow',lbl:'No-Shows',target:null,sub:'Track honestly'}];
const MINDSET_ITEMS=[
  {id:'ms1',title:'No phone for the first 15 minutes',sub:'Your mind belongs to you before it belongs to the feed.',time:'5:30 AM'},
  {id:'ms2',title:'Write your #1 non-negotiable for today',sub:'The one thing that must get done. Not 3. One.',time:'5:35 AM'},
  {id:'ms3',title:'Read your goals out loud',sub:'90-day vision + monthly big 3. Say them like you mean it.',time:'5:40 AM'},
  {id:'ms4',title:'5-minute visualization',sub:'See yourself closing, completing, winning today.',time:'5:45 AM'},
  {id:'ms5',title:'Drink 16 oz water immediately',sub:'Hydrate before coffee. Non-negotiable.',time:'5:30 AM'},
  {id:'ms-workout',title:'Completed today\'s workout',sub:'Log it in Fitness section. Non-negotiable.',time:'6:15 AM'},
  {id:'ms-protein',title:'Hit protein goal for the day',sub:'30–40g per meal. Track it.',time:'All Day'},
  {id:'ms-lights',title:'In bed by 10 PM',sub:'7–8 hrs. Sleep is where the gains happen.',time:'10:00 PM'},
];
const REGIMENT=[
  {t:'5:30 AM',a:'Wake — No Phone',n:'First 15 min belongs to you. Water immediately.'},
  {t:'5:45 AM',a:'Journal & Goals Review',n:'Write top 3 intentions. Read goals aloud.'},
  {t:'6:15 AM',a:'Workout',n:'45–60 min. Log every set. Non-negotiable.'},
  {t:'7:15 AM',a:'Breakfast + Supplement Stack',n:'30–40g protein. Morning supps per protocol.'},
  {t:'8:00 AM',a:'Route & Script Prep',n:'Map territory. Rehearse opener. Know your number.'},
  {t:'9:00 AM',a:'First Door',n:'Always the hardest. Do it anyway.'},
  {t:'12:00 PM',a:'Midday Reset',n:'Check KPIs. Eat. Adjust pace if needed.'},
  {t:'6:00 PM',a:'Wrap & Field Debrief',n:'Sales notes while fresh. Update objection log.'},
  {t:'8:00 PM',a:'Daily Log & Reflection',n:'Rate day 1–10. One win. One lesson.'},
  {t:'10:00 PM',a:'Lights Out',n:'7–8 hrs. Sleep is where the gains happen.'},
];

const FLOOR_PRESETS={
'Make more money':[
{label:'Doors Knocked',targetValue:60,unit:'doors'},
{label:'Closes',targetValue:1,unit:'closes'},
{label:'Follow-up Calls',targetValue:10,unit:'calls'},
{label:'Revenue',targetValue:500,unit:'$'},
{label:'Journaled',targetValue:1,unit:'done'}
],
'Build a stronger body':[
{label:'Workout complete',targetValue:1,unit:'done'},
{label:'Protein ≥ bodyweight (g)',targetValue:'BW',unit:'g'},
{label:'Steps',targetValue:8000,unit:'steps'},
{label:'Sleep 7+ hrs',targetValue:7,unit:'hrs'},
{label:'Water intake',targetValue:3,unit:'L'}
],
'Improve discipline & habits':[
{label:'Journaled',targetValue:1,unit:'done'},
{label:'Sleep 7+ hrs',targetValue:7,unit:'hrs'},
{label:'No phone first 30 min',targetValue:1,unit:'done'},
{label:'Meditation',targetValue:10,unit:'min'},
{label:'1 Big Task done',targetValue:1,unit:'done'}
],
'Grow my business':[
{label:'Revenue-generating tasks',targetValue:3,unit:'tasks'},
{label:'Outreach messages',targetValue:20,unit:'msgs'},
{label:'Content created / posted',targetValue:1,unit:'post'},
{label:'Learning / skill dev',targetValue:30,unit:'min'},
{label:'Journaled',targetValue:1,unit:'done'}
],
'Other':[
{label:'Sleep 7+ hrs',targetValue:7,unit:'hrs'},
{label:'Workout complete',targetValue:1,unit:'done'},
{label:'Protein ≥ bodyweight (g)',targetValue:'BW',unit:'g'},
{label:'1 Big Task',targetValue:1,unit:'done'},
{label:'Journaled',targetValue:1,unit:'done'}
]
};

const FOCUS_EXTRA={
sales:[
{label:'Doors Knocked',targetValue:60,unit:'doors'},
{label:'Closes',targetValue:1,unit:'closes'},
{label:'Revenue',targetValue:500,unit:'$'}
],
fitness:[
{label:'Workout complete',targetValue:1,unit:'done'},
{label:'Steps',targetValue:8000,unit:'steps'}
],
nutrition:[
{label:'Protein ≥ bodyweight (g)',targetValue:'BW',unit:'g'},
{label:'Water intake',targetValue:3,unit:'L'}
],
mindset:[
{label:'Journaled',targetValue:1,unit:'done'},
{label:'Meditation',targetValue:10,unit:'min'},
{label:'No phone first 30 min',targetValue:1,unit:'done'}
],
learning:[
{label:'Learning / reading',targetValue:30,unit:'min'}
]
};

function getBodyweight(){const cfg=getUserConfig();return cfg&&cfg.bodyweight?cfg.bodyweight:150;}

function resolveProtein(floors,bw){
bw=bw||getBodyweight();
return floors.map(f=>({...f,targetValue:f.targetValue==='BW'?bw:f.targetValue}));
}

function normalizeLabel(s){return s.toLowerCase().replace(/[^a-z0-9]/g,'');}

function buildMergedFloors(cat,focusAreas,bw){
bw=bw||150;
const primary=(FLOOR_PRESETS[cat]||FLOOR_PRESETS['Other']).map(f=>({...f}));
const seen=new Set(primary.map(f=>normalizeLabel(f.label)));
const merged=[...primary];
focusAreas.forEach(area=>{
const extras=FOCUS_EXTRA[area]||[];
extras.forEach(f=>{
const key=normalizeLabel(f.label);
if(!seen.has(key)&&merged.length<7){seen.add(key);merged.push({...f});}
});
});
return resolveProtein(merged.slice(0,7).map((f,i)=>({...f,id:'f'+Date.now()+i})),bw);
}

function getDefaultFloors(){
const bw=getBodyweight();
return resolveProtein([
{id:'qs1',label:'Sleep 7+ hrs',targetValue:7,unit:'hrs'},
{id:'qs2',label:'Workout complete',targetValue:1,unit:'done'},
{id:'qs3',label:'Protein ≥ bodyweight (g)',targetValue:'BW',unit:'g'},
{id:'qs4',label:'1 Big Task',targetValue:1,unit:'done'},
{id:'qs5',label:'Journaled',targetValue:1,unit:'done'}
],bw);
}

function getUserConfig(){try{return JSON.parse(localStorage.getItem(NBD_CFG))||null;}catch{return null;}}
function getFloors(){const c=getUserConfig();return c&&c.floors&&c.floors.length?c.floors:getDefaultFloors();}

let pages=[],cur=0,dirty=false,searchOpen=false,charts=[];
let exCount=0;
let obStep=1,obFloors=[];

function toggleTheme(){} // legacy stub — no-op
function initTheme(){} // handled by dsApplyTheme boot block below


function todayKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function dk2d(dk){const[y,m,d]=dk.split('-');return new Date(+y,+m-1,+d);}
function dkShort(dk){return dk2d(dk).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}).toUpperCase();}
function dkFull(dk){return dk2d(dk).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}).toUpperCase();}
function tlbl(p){const b=p.name||dkShort(p.dk);return p.suf>1?`${b} (${p.suf})`:b;}
function isToday(dk){return dk===todayKey();}

function mkPage(dk){const suf=pages.filter(p=>p.dk===dk).length+1;return{id:Date.now()+Math.random(),dk,suf,name:'',data:{},kpi:{doors:0,contacts:0,appts:0,closes:0,noshow:0},exercises:[],objections:[],commissions:[]};}
function loadPages(){try{pages=JSON.parse(localStorage.getItem(STORE))||[];}catch{pages=[];}if(!pages.length){pages=[mkPage(todayKey())];savePages();}}
function savePages(){localStorage.setItem(STORE,JSON.stringify(pages));}
function smartNewPage(){const tk=todayKey(),idx=pages.findIndex(p=>p.dk===tk&&!p.name);if(idx>=0){collectPage(true);cur=idx;renderTabs();renderPage();markSaved();toast('Jumped to today');return;}collectPage(true);pages.push(mkPage(todayKey()));savePages();cur=pages.length-1;renderTabs();renderPage();markSaved();toast('New page created');}
function triggerDel(idx){idx=idx??cur;if(pages.length<=1){toast('Cannot delete the only page');return;}_di=idx;document.getElementById('mDelMsg').textContent=`Delete "${tlbl(pages[idx])}"? This cannot be undone.`;openM('mDel');}
function doDelete(){closeM('mDel');const i=_di??cur;pages.splice(i,1);savePages();cur=Math.min(i>0?i-1:0,pages.length-1);renderTabs();killCharts();if(cur===-1)renderDash();else renderPage();toast('Page deleted');}
function openRename(){if(cur<0)return;document.getElementById('renInp').value=pages[cur].name||'';openM('mRen');setTimeout(()=>document.getElementById('renInp').focus(),80);}
function applyRen(){pages[cur].name=document.getElementById('renInp').value.trim();savePages();closeM('mRen');renderTabs();toast('Renamed');}

function markDirty(){if(dirty)return;dirty=true;const e=document.getElementById('sdot');e.textContent='● UNSAVED';e.className='sdot dirty';}
function markSaved(){dirty=false;const e=document.getElementById('sdot');e.textContent='● SAVED';e.className='sdot ok';}
function collectPage(silent){
if(cur<0)return;const p=pages[cur];
document.querySelectorAll('[data-k]').forEach(el=>{p.data[el.dataset.k]=el.value||'';});
p.exercises=[];for(let i=0;i<exCount;i++){const r={};['name','sets','reps','weight','notes'].forEach(f=>{const el=document.querySelector(`[data-k="ex-${i}-${f}"]`);r[f]=el?el.value:'';});p.exercises.push(r);}
savePages();if(!silent)markSaved();
}
function saveNow(){collectPage();toast('Saved ✓');}
function switchTo(idx){collectPage(true);cur=idx;renderTabs();killCharts();if(cur===-1)renderDash();else renderPage();markSaved();}

function renderTabs(){
const w=document.getElementById('tabrow');w.innerHTML='';
const d=document.createElement('div');d.className='tab dtab'+(cur===-1?' active':'');
d.dataset.action='switch-to';d.dataset.pageIdx='-1';
d.innerHTML='<span class="tlbl">📊 DASH</span>';w.appendChild(d);
pages.forEach((p,i)=>{
const t=document.createElement('div');t.className='tab'+(i===cur?' active':'');
t.dataset.action='switch-to';t.dataset.pageIdx=i;
const td=isToday(p.dk)?'<span class="today-dot"></span>':'';
t.innerHTML=`<span class="tlbl">${tlbl(p)}</span>${td}<button class="tx" data-action="trigger-del-tab" data-tab-idx="${i}">×</button>`;
w.appendChild(t);
});
const plus=document.createElement('div');plus.className='tplus';plus.textContent='+';plus.title='New / jump to today';
plus.dataset.action='smart-new-page';w.appendChild(plus);
setTimeout(()=>{const a=w.querySelector('.active');if(a)a.scrollIntoView({behavior:'smooth',block:'nearest',inline:'nearest'});},50);
}

function buildCover(p,qi){
const ds=dkFull(p.dk)+(p.suf>1?` · ENTRY ${p.suf}`:'');
const q=QUOTES[qi];
return ` <div class="cover"> <div class="cover-eyebrow">No Big Deal with Joe Deal · Daily Success Program</div> <div class="cover-title">SHOW<br>UP.<span> WIN.</span></div> <div class="cover-date">📅 ${ds}</div> <div class="cover-quote">"${q}"</div> <div class="cover-corner">WIN</div> </div> <div class="qcard"><div class="ql">Today's Mindset</div><div class="qt">${q}</div></div>`;
}

function buildDayScore(p){
const d=p.data||{};
const floors=getFloors();
const cfg=getUserConfig();
const items=floors.map(f=>{
const met=d['floormet-'+f.id]==='1';
return `<div class="dsc-item" data-action="toggle-floor" data-floor-id="${f.id}"><div class="dsc-dot ${met?'hit':''}"></div><span class="dsc-lbl ${met?'hit':''}">${f.label}</span></div>`;
}).join('');
const metCount=floors.filter(f=>d['floormet-'+f.id]==='1').length;
const total=floors.length;
const pct=total?Math.round(metCount/total*100):0;
const allMet=total>0&&metCount===total;
const scoreColor=allMet?'#4caf82':pct>=67?'var(--gold)':'var(--ac)';
const lbl=allMet?'PERFECT DAY':pct>=67?'SOLID DAY':pct>=34?'KEEP GRINDING':'RESET + PUSH';
const goose=cfg?cfg.goose:'';
const showGoose=cfg?cfg.showGoose:false;
const eggHtml=allMet
?`<div class="floor-egg earned"><div><div class="floor-egg-title">🏆 EARNED — ALL FLOORS CLEARED</div>${showGoose&&goose?`<div class="floor-egg-goose">Goose: ${goose}</div>`:''}</div></div>`
:`<div class="floor-egg not-earned"><div class="floor-egg-title">⬡ NOT EARNED — ${total-metCount} FLOOR${(total-metCount)!==1?'S':''} LEFT</div></div>`;
return `${eggHtml}<div class="dsc" id="day-score-card"><div class="dsc-left"><div class="dsc-title">Today's Floor Score — tap to mark met</div><div class="dsc-checks">${items}</div><div class="dsc-bar"><div class="dsc-bar-fill" style="width:${pct}%"></div></div></div><div class="dsc-score-wrap"><div class="dsc-score ${allMet?'perfect':''}" style="color:${scoreColor}">${pct}%</div><div class="dsc-score-lbl">${lbl}</div></div></div>`;
}

function toggleFloor(floorId){
const p=pages[cur];p.data=p.data||{};
p.data['floormet-'+floorId]=p.data['floormet-'+floorId]==='1'?'0':'1';
markDirty();
const wrap=document.getElementById('day-score-wrap');if(wrap)wrap.innerHTML=buildDayScore(p);
}

function buildMindsetSection(p){
const d=p.data||{};
const items=MINDSET_ITEMS.map(item=>{
const on=d[item.id]==='1';
return `<div class="mc-item" data-action="toggle-mindset" data-mindset-id="${item.id}"><div class="mc-check ${on?'on':''}" data-ms="${item.id}"></div><div class="mc-label"><div class="mc-title ${on?'done':''}">${item.title}</div><div class="mc-sub">${item.sub}</div></div><div class="mc-time">${item.time}</div></div>`;
}).join('');
return `<div class="rl">Check off each item to build your morning momentum</div>${items} <div class="dv"><span class="dvt">Morning Intention</span></div> <div><div class="rl">Today's non-negotiable</div><div class="rln"><textarea class="ed" data-k="ms-nonneg" placeholder="The one thing that must get done today…" rows="2">${d['ms-nonneg']||''}</textarea></div></div> <div><div class="rl">Affirmation / personal mantra</div><div class="rln"><textarea class="ed" data-k="ms-mantra" placeholder="Write it like you mean it…" rows="1">${d['ms-mantra']||''}</textarea></div></div>`;
}

function toggleMindset(id,rowEl){
const p=pages[cur];p.data=p.data||{};
const on=p.data[id]!=='1';p.data[id]=on?'1':'0';
const check=rowEl.querySelector('.mc-check');const title=rowEl.querySelector('.mc-title');
if(check)check.classList.toggle('on',on);if(title)title.classList.toggle('done',on);
markDirty();
}

function buildRegimentSection(p){
const d=p.data||{};
const rows=REGIMENT.map((r,i)=>`<div class="srow" ${i===REGIMENT.length-1?'style="border:none"':''}><div class="stime">${r.t}</div><div class="sact-wrap"><div class="sact">${r.a}</div><div class="snote">${r.n}</div></div></div>`).join('');
return `<div class="rl">Your daily blueprint — the schedule that produces the result</div>${rows} <div class="dv"><span class="dvt">Today's Adjustments</span></div> <div><div class="rl">Any schedule changes or notes</div><div class="rln"><textarea class="ed" data-k="reg-notes" placeholder="Late start, appointment in field, double session…" rows="2">${d['reg-notes']||''}</textarea></div></div>`;
}

function buildDietSection(p){
const d=p.data||{};
const rows=MEALS.map((meal,i)=>`<tr><td><input data-k="diet-m${i}-name" placeholder="${meal}" value="${d['diet-m'+i+'-name']||''}" data-input-action="calc-macros"></td><td><input data-k="diet-m${i}-p" placeholder="—" value="${d['diet-m'+i+'-p']||''}" data-input-action="calc-macros"></td><td><input data-k="diet-m${i}-c" placeholder="—" value="${d['diet-m'+i+'-c']||''}" data-input-action="calc-macros"></td><td><input data-k="diet-m${i}-f" placeholder="—" value="${d['diet-m'+i+'-f']||''}" data-input-action="calc-macros"></td><td><input data-k="diet-m${i}-cal" placeholder="—" value="${d['diet-m'+i+'-cal']||''}" data-input-action="calc-macros"></td></tr>`).join('');
return `<div class="tbl-wrap"><table class="dt"><thead><tr><th>Meal</th><th>Protein (g)</th><th>Carbs (g)</th><th>Fat (g)</th><th>Calories</th></tr></thead><tbody>${rows}<tr class="dt-total"><td><input readonly placeholder="DAILY TOTAL" style="font-weight:700;font-family:'Barlow Condensed',sans-serif;font-size:11px;width:100%;background:transparent;border:none;outline:none;padding:5px 7px;"></td><td><input id="dt-p" readonly placeholder="—" style="width:100%;background:transparent;border:none;outline:none;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;color:var(--ac);padding:5px 7px;"></td><td><input id="dt-c" readonly placeholder="—" style="width:100%;background:transparent;border:none;outline:none;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;color:var(--ac);padding:5px 7px;"></td><td><input id="dt-f" readonly placeholder="—" style="width:100%;background:transparent;border:none;outline:none;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;color:var(--ac);padding:5px 7px;"></td><td><input id="dt-cal" readonly placeholder="—" style="width:100%;background:transparent;border:none;outline:none;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;color:var(--ac);padding:5px 7px;"></td></tr></tbody></table></div> <div class="macro-summary"><div class="mpill protein"><div class="mpill-val" id="ms-p">—</div><div class="mpill-lbl">Protein g</div></div><div class="mpill carbs"><div class="mpill-val" id="ms-c">—</div><div class="mpill-lbl">Carbs g</div></div><div class="mpill fat"><div class="mpill-val" id="ms-f">—</div><div class="mpill-lbl">Fat g</div></div><div class="mpill cals"><div class="mpill-val" id="ms-cal">—</div><div class="mpill-lbl">Calories</div></div></div> <div><div class="rl">Energy / hunger notes</div><div class="rln"><textarea class="ed" data-k="diet-notes" placeholder="Energy levels, cravings, anything to adjust…" rows="2">${d['diet-notes']||''}</textarea></div></div>`;
}

function calcMacros(){
['p','c','f','cal'].forEach(f=>{
let sum=0,any=false;
MEALS.forEach((_,i)=>{const el=document.querySelector(`[data-k="diet-m${i}-${f}"]`);if(el&&el.value){const n=parseFloat(el.value);if(!isNaN(n)){sum+=n;any=true;}}});
const val=any?Math.round(sum*10)/10:'—';
const t=document.getElementById('dt-'+f);const p=document.getElementById('ms-'+f);
if(t)t.value=any?val:'';if(p)p.textContent=val;
});
}

function addExercise(data,isDynamic){
data=data||{};const i=exCount++;const tb=document.getElementById('ex-tbody');if(!tb)return;
const tr=document.createElement('tr');
const mk=(f,ph,v)=>`<input data-k="ex-${i}-${f}" placeholder="${ph}" value="${(v||'').replace(/"/g,'&quot;')}" data-input-action="mark-dirty">`;
tr.innerHTML=`<td>${mk('name','Exercise name',data.name)}</td><td>${mk('sets','3',data.sets)}</td><td>${mk('reps','10',data.reps)}</td><td>${mk('weight','lbs',data.weight)}</td><td>${mk('notes','PR? notes',data.notes)}</td><td><button class="ex-del" data-action="delete-exercise">×</button></td>`;
tb.appendChild(tr);if(isDynamic)markDirty();
}

function buildFitnessSection(p){
const d=p.data||{};
return `<div class="g2"><div><div class="rl">Training Focus</div><div class="rln"><input class="ed" data-k="fit-focus" placeholder="Push / Pull / Legs / Full Body…" value="${d['fit-focus']||''}"></div></div><div><div class="rl">Pre-Workout Stack</div><div class="rln"><input class="ed" data-k="fit-pre" placeholder="HWMF / Intake / Hydraulic 2…" value="${d['fit-pre']||''}"></div></div></div> <div><div class="rl">Exercise Log</div><div class="tbl-wrap"><table class="dt"><thead><tr><th>Exercise</th><th>Sets</th><th>Reps</th><th>Weight</th><th>Notes</th><th></th></tr></thead><tbody id="ex-tbody"></tbody></table></div><button class="addbtn" data-action="add-exercise">+ ADD EXERCISE</button></div> <div class="rating-row"><div class="rbox"><span class="rbox-lbl">Duration</span><input data-k="fit-dur" placeholder="45 min" value="${d['fit-dur']||''}"></div><div class="rbox"><span class="rbox-lbl">Intensity (1–10)</span><input data-k="fit-int" placeholder="8" value="${d['fit-int']||''}"></div><div class="rbox"><span class="rbox-lbl">Session Rating</span><input data-k="fit-rate" placeholder="_/10" value="${d['fit-rate']||''}"></div></div> <div><div class="rl">Session notes</div><div class="rln"><textarea class="ed" data-k="fit-notes" placeholder="What felt strong, what lagged, any PR…" rows="2">${d['fit-notes']||''}</textarea></div></div>`;
}

function buildPRSection(p){
const d=p.data||{};
const cards=LIFTS.map(lift=>{const key='pr-'+lift.toLowerCase().replace(/[\s/]+/g,'-');const val=d[key]||'';const stamp=d[key+'-stamp']||'';return `<div class="pr-card"><div class="pr-lift">${lift}<button class="pr-hist-btn" data-action="open-pr-history" data-lift="${lift}" data-pr-key="${key}">HISTORY</button></div><div class="pr-inp-row"><input class="pr-inp" data-k="${key}" placeholder="0" value="${val}" data-input-action="pr-stamp" data-pr-key="${key}"><span class="pr-unit">lbs</span></div><div class="pr-stamp" id="${key}-stamp">${stamp?'Set: '+stamp:''}</div></div>`;}).join('');
const bmFields=[['wt','Weight (lbs)'],['bf','Body Fat %'],['chest','Chest (in)'],['waist','Waist (in)'],['arms','Arms (in)'],['legs','Legs (in)']];
const bmCells=bmFields.map(([k,l])=>`<div class="bm-cell"><span class="bm-lbl">${l}</span><input class="bm-inp" data-k="bm-${k}" placeholder="—" value="${d['bm-'+k]||''}" data-input-action="mark-dirty"></div>`).join('');
return `<div class="rl">Auto-timestamps when you update a lift PR</div><div class="pr-grid">${cards}</div><div class="dv"><span class="dvt">Weekly Body Metrics</span></div><div class="bm-grid">${bmCells}</div><div><div class="rl">Progress notes</div><div class="rln"><textarea class="ed" data-k="bm-notes" placeholder="Changes in how clothes fit, energy trends…" rows="2">${d['bm-notes']||''}</textarea></div></div>`;
}

function prStamp(key,val){
if(!val||!val.trim())return;const p=pages[cur];if(!p)return;
const now=new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}).toUpperCase();
p.data=p.data||{};p.data[key+'-stamp']=now;
const el=document.getElementById(key+'-stamp');if(el)el.textContent='Set: '+now;
}

function openPRHistory(liftName,key){
const entries=[];
pages.forEach((p,i)=>{const val=p.data?.[key];const stamp=p.data?.[key+'-stamp'];if(val&&parseFloat(val)>0)entries.push({val:parseFloat(val),stamp:stamp||dkShort(p.dk),page:tlbl(p),idx:i});});
document.getElementById('prh-title').textContent=liftName+' History';
document.getElementById('prh-sub').textContent=`${entries.length} PR${entries.length!==1?'s':''} across all pages`;
const list=document.getElementById('prh-list');
if(!entries.length){list.innerHTML='<div class="de">No entries yet for this lift.</div>';openM('mPRH');return;}
const chrono=[...entries].sort((a,b)=>a.idx-b.idx);
list.innerHTML=chrono.map((e,i)=>{const prev=i>0?chrono[i-1].val:null;const delta=prev!==null?e.val-prev:null;const best=e.val===Math.max(...entries.map(x=>x.val));const dh=delta===null?'':(delta>0?`<span class="prh-delta up">+${delta}lbs</span>`:(delta<0?`<span class="prh-delta dn">${delta}lbs</span>`:''));return `<div class="prh-row"><span class="prh-date">${e.stamp}</span><span class="prh-page">${e.page}${best?' 🏆':''}</span><span class="prh-val">${e.val}lbs</span>${dh}</div>`;}).join('');
openM('mPRH');
}


const KPI_FLOOR_KEYWORDS={
doors:['door'],
closes:['clos','close'],
contacts:['contact'],
appts:['appt','appointment'],
noshow:[]
};

function autoCheckFloors(kpiKey,val,customKeywords){
if(cur<0)return;
const p=pages[cur];p.data=p.data||{};
const keywords=customKeywords||(KPI_FLOOR_KEYWORDS[kpiKey]||[]);
if(!keywords.length)return;
const floors=getFloors();
let changed=false;
floors.forEach(f=>{
const norm=normalizeLabel(f.label);
const matches=keywords.some(kw=>norm.includes(kw));
if(!matches)return;
const target=parseFloat(f.targetValue)||1;
const shouldMet=(parseFloat(val)||0)>=target;
const key='floormet-'+f.id;
const wasOff=p.data[key]!=='1';
if(shouldMet&&wasOff){p.data[key]='1';changed=true;}
});
if(changed){
markDirty();
const wrap=document.getElementById('day-score-wrap');
if(wrap)wrap.innerHTML=buildDayScore(p);
}
}

function autoCheckRevenueFloor(val){
if(cur<0)return;
const p=pages[cur];p.data=p.data||{};
const floors=getFloors();
let changed=false;
floors.forEach(f=>{
const norm=normalizeLabel(f.label);
if(!norm.includes('revenue')&&!norm.includes('rev')&&f.unit!=='$')return;
const target=parseFloat(f.targetValue)||1;
const shouldMet=(parseFloat(val)||0)>=target;
const key='floormet-'+f.id;
const wasOff=p.data[key]!=='1';
if(shouldMet&&wasOff){p.data[key]='1';changed=true;}
});
if(changed){
markDirty();
const wrap=document.getElementById('day-score-wrap');
if(wrap)wrap.innerHTML=buildDayScore(p);
}
}


function buildLogSection(p){
const d=p.data||{};
return `<div class="g2"><div><div class="rl">Top 3 Priorities Today</div>${[1,2,3].map(n=>`<div class="rln"><span class="rn">${n}</span><textarea class="ed" data-k="l-p${n}" rows="1" placeholder="${n===1?'Most important task today…':''}">${d['l-p'+n]||''}</textarea></div>`).join('')}</div><div><div class="rl">Day Ratings (1–10)</div><div class="rln"><input class="ed" data-k="l-ov" placeholder="Overall: _/10" value="${d['l-ov']||''}"></div><div class="rln"><input class="ed" data-k="l-en" placeholder="Energy: _/10" value="${d['l-en']||''}"></div><div class="rln"><input class="ed" data-k="l-fo" placeholder="Focus: _/10" value="${d['l-fo']||''}"></div></div></div> <div class="dv"><span class="dvt">End of Day Review</span></div> <div><div class="rl">One Win Today</div><div class="rln"><textarea class="ed" data-k="l-win" placeholder="What did you crush today?" rows="2">${d['l-win']||''}</textarea></div></div> <div><div class="rl">One Lesson</div><div class="rln"><textarea class="ed" data-k="l-les" placeholder="What would you do differently?" rows="2">${d['l-les']||''}</textarea></div></div> <div><div class="rl">Gratitude (3 things)</div>${[1,2,3].map(n=>`<div class="rln"><span class="rn">${n}</span><textarea class="ed" data-k="l-g${n}" rows="1">${d['l-g'+n]||''}</textarea></div>`).join('')}</div>`;
}

function buildGoalsSection(p){
const d=p.data||{};
return `<div><div class="rl">This Month's Big 3</div><div class="rln"><span class="gtag">Financial</span><textarea class="ed" data-k="g-fin" placeholder="Revenue target, income milestone…" rows="1">${d['g-fin']||''}</textarea></div><div class="rln"><span class="gtag">Physical</span><textarea class="ed" data-k="g-phys" placeholder="Lift PR, body comp, endurance…" rows="1">${d['g-phys']||''}</textarea></div><div class="rln"><span class="gtag">Personal</span><textarea class="ed" data-k="g-pers" placeholder="Skill, habit, relationship, mindset…" rows="1">${d['g-pers']||''}</textarea></div></div> <div><div class="rl">90-Day Vision</div><div class="rln"><textarea class="ed" data-k="g-vis" placeholder="Be specific. Numbers, dates, outcomes." rows="3">${d['g-vis']||''}</textarea></div></div> <div><div class="rl">Long-Term Why</div><div class="rln"><textarea class="ed" data-k="g-why" placeholder="Why does all of this matter? Who are you doing it for?" rows="2">${d['g-why']||''}</textarea></div></div> <div class="dv"><span class="dvt">Sunday Review</span></div> <div><div class="rl">Honest weekly assessment</div><div class="rln"><textarea class="ed" data-k="g-sun" placeholder="What's working, what's not, what's the next move…" rows="3">${d['g-sun']||''}</textarea></div></div>`;
}

function buildHabitsTable(p){
const d=p.data||{};
const rows=HABITS.map((h,hi)=>{let score=0;const cells=Array.from({length:7},(_,di)=>{const k=`habit-${hi}-${di}`;const on=d[k]==='1';if(on)score++;return `<td><span class="hd ${on?'on':''}" data-action="toggle-habit" data-habit-key="${k}" data-habit-row="${hi}"></span></td>`;}).join('');return `<tr><td>${h}</td>${cells}<td id="hs-${hi}">${score}/7</td></tr>`;}).join('');
return `<table class="ht"><thead><tr><th>Habit</th><th>M</th><th>T</th><th>W</th><th>T</th><th>F</th><th>S</th><th>S</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function toggleHabit(el,k,hi){
const on=el.classList.toggle('on');pages[cur].data[k]=on?'1':'0';
let c=0;for(let d=0;d<7;d++)if(pages[cur].data[`habit-${hi}-${d}`]==='1')c++;
document.getElementById('hs-'+hi).textContent=c+'/7';markDirty();
}

function buildScorecard(p){
const d=p.data||{};
return `<div class="scg">${MONTHS.map((m,i)=>`<div class="sci"><span class="scm">${m}</span><input class="scinp" data-k="score-${i}" placeholder="—" maxlength="5" value="${d['score-'+i]||''}" data-input-action="mark-dirty"></div>`).join('')}</div>`;
}

function buildIntelligenceBrief(p){
  const floors = getFloors();
  const d = p.data || {};
  const sorted = [...pages].sort((a,b) => a.dk > b.dk ? 1 : -1);
  const idx = sorted.findIndex(x => x.id === p.id);

  // Streak calculation
  let streak = 0;
  for(let i = idx; i >= 0; i--){
    const pd = sorted[i].data || {};
    const met = floors.filter(f => pd['floormet-'+f.id] === '1').length;
    if(met === floors.length && floors.length > 0) streak++;
    else break;
  }

  // Workout streak
  let workoutStreak = 0;
  for(let i = idx; i >= 0; i--){
    const pd = sorted[i].data || {};
    const hasWorkout = sorted[i].exercises && sorted[i].exercises.some(ex => ex.name && ex.name.trim());
    if(hasWorkout) workoutStreak++;
    else break;
  }

  // Habit compliance this week (last 7 entries)
  const recent = sorted.slice(Math.max(0, idx - 6), idx + 1);
  const HABITS_LOCAL = typeof HABITS !== 'undefined' ? HABITS : [];
  let habitHits = 0, habitTotal = 0;
  recent.forEach(pg => {
    const pd = pg.data || {};
    HABITS_LOCAL.forEach((h, hi) => {
      for(let di = 0; di < 7; di++){
        if(pd[`habit-${hi}-${di}`] === '1') habitHits++;
        habitTotal++;
      }
    });
  });
  const habitPct = habitTotal > 0 ? Math.round(habitHits / habitTotal * 100) : 0;

  // Personal bests detection
  let pbs = [];
  if(idx >= 1){
    const prLifts = ['bench','squat','deadlift','ohp','row','pullups'];
    prLifts.forEach(lift => {
      const current = parseFloat(d['pr-'+lift]) || 0;
      if(current <= 0) return;
      let prevBest = 0;
      for(let i = 0; i < idx; i++){
        const pv = parseFloat(sorted[i].data?.['pr-'+lift] || 0) || 0;
        if(pv > prevBest) prevBest = pv;
      }
      if(current > prevBest && prevBest > 0){
        pbs.push(`New ${lift.toUpperCase()} PR: ${current} (was ${prevBest})`);
      }
    });
  }

  // Coaching insight based on patterns
  let coaching = '';
  if(streak >= 7) coaching = "You're on a 7+ day floor streak. This is elite consistency — protect it.";
  else if(streak >= 3) coaching = "3+ day streak rolling. Momentum is building. Don't break the chain.";
  else if(streak === 0 && idx > 0) coaching = "Streak broken. Today is day one. One floor at a time.";
  else coaching = "New page. Set your intention, hit your floors, earn the day.";

  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">';

  const streakColor = streak >= 7 ? 'var(--grn)' : streak >= 3 ? 'var(--gold)' : streak >= 1 ? 'var(--ac)' : '#445566';
  html += `<div style="background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;padding:12px;text-align:center;">
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:36px;color:${streakColor};line-height:1;">${streak}</div>
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.15em;color:var(--muted);margin-top:2px;">FLOOR STREAK</div>
  </div>`;

  html += `<div style="background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;padding:12px;text-align:center;">
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:36px;color:${workoutStreak >= 3 ? 'var(--grn)' : '#445566'};line-height:1;">${workoutStreak}</div>
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.15em;color:var(--muted);margin-top:2px;">WORKOUT STREAK</div>
  </div>`;

  html += `<div style="background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;padding:12px;text-align:center;">
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:36px;color:${habitPct >= 70 ? 'var(--grn)' : habitPct >= 40 ? 'var(--gold)' : '#445566'};line-height:1;">${habitPct}%</div>
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.15em;color:var(--muted);margin-top:2px;">HABIT RATE (7D)</div>
  </div>`;

  html += `<div style="background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;padding:12px;text-align:center;">
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:36px;color:var(--ink);line-height:1;">${pages.length}</div>
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.15em;color:var(--muted);margin-top:2px;">DAYS LOGGED</div>
  </div>`;

  html += '</div>';

  if(pbs.length){
    html += '<div style="margin-bottom:10px;">';
    pbs.forEach(pb => {
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:4px;margin-bottom:4px;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--gold);letter-spacing:.05em;">🏆 ${pb}</div>`;
    });
    html += '</div>';
  }

  html += `<div style="padding:10px 14px;background:rgba(0,0,0,.03);border-left:3px solid var(--ac);border-radius:0 4px 4px 0;font-size:12px;color:var(--ink);line-height:1.6;font-style:italic;">${coaching}</div>`;

  return html;
}

function buildCRMContext(){
  const cache = localStorage.getItem('nbd_pipeline_cache');
  if(!cache) return '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--muted);text-align:center;padding:16px;">Connect your CRM to see pipeline data here. <br><a href="/pro/dashboard.html" style="color:var(--ac);">Open CRM →</a></div>';

  try {
    const data = JSON.parse(cache);
    const total = data.total || 0;
    const stages = data.stages || {};
    const value = data.totalValue || 0;
    const hot = data.hotLeads || 0;

    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px;">';
    html += `<div style="text-align:center;padding:10px;background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;color:var(--ac);line-height:1;">${total}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.12em;color:var(--muted);margin-top:2px;">ACTIVE LEADS</div></div>`;
    html += `<div style="text-align:center;padding:10px;background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;color:var(--grn);line-height:1;">$${Math.round(value).toLocaleString()}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.12em;color:var(--muted);margin-top:2px;">PIPELINE VALUE</div></div>`;
    html += `<div style="text-align:center;padding:10px;background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:6px;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;color:var(--gold);line-height:1;">${hot}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;letter-spacing:.12em;color:var(--muted);margin-top:2px;">HOT LEADS</div></div>`;
    html += '</div>';

    if(Object.keys(stages).length){
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
      const stageColors = {new:'#3b82f6',contacted:'#f59e0b',inspected:'#8b5cf6',quoted:'#ec4899',sold:'#22c55e',completed:'#06b6d4'};
      Object.entries(stages).forEach(([name, count]) => {
        const color = stageColors[name] || 'var(--muted)';
        html += `<div style="display:flex;align-items:center;gap:5px;padding:4px 10px;background:rgba(0,0,0,.03);border:1px solid var(--rule);border-radius:4px;font-family:'Barlow Condensed',sans-serif;font-size:9px;letter-spacing:.05em;"><span style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;"></span><span style="color:var(--ink);text-transform:capitalize;">${name}</span><span style="color:var(--muted);">${count}</span></div>`;
      });
      html += '</div>';
    }

    html += `<div style="margin-top:8px;text-align:right;"><a href="/pro/dashboard.html" style="font-family:'Barlow Condensed',sans-serif;font-size:9px;letter-spacing:.1em;color:var(--ac);text-decoration:none;">OPEN FULL CRM →</a></div>`;
    return html;
  } catch(e){
    return '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--muted);text-align:center;padding:16px;">Pipeline data unavailable</div>';
  }
}

function renderPage(){
killCharts();exCount=0;
const main=document.getElementById('main');main.innerHTML='';
const p=pages[cur];

const wrap=document.createElement('div');
wrap.style.cssText='width:100%;max-width:760px;display:flex;flex-direction:column;gap:18px;';
wrap.innerHTML=` ${buildCover(p,cur%QUOTES.length)} <div id="week-glance-wrap" style="background:#0a1018;width:100%;max-width:760px;border-radius:8px;padding:12px 18px;border:1px solid #1e2d40;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#445566;margin-bottom:8px;text-align:center;">THIS WEEK AT A GLANCE</div>${buildWeekGlance()}</div> <div id="day-score-wrap">${buildDayScore(p)}</div> <div id="comparison-wrap">${buildDailyComparison(p)}</div> <div class="pc" data-sec="intel"><div class="ph" data-action="toggle-section"><span class="badge" style="background:linear-gradient(135deg,#1A3057,#5a2a7e);">INTEL</span><div class="pt">Intelligence Brief</div><span class="collapse-ico">▾</span></div><div class="pb" id="intel-pb"></div></div> <div class="pc" data-sec="pipeline"><div class="ph" data-action="toggle-section"><span class="badge" style="background:linear-gradient(135deg,#0d4a3a,#1e6a4e);">PIPELINE</span><div class="pt">CRM Pipeline Snapshot</div><span class="collapse-ico">▾</span></div><div class="pb" id="pipeline-pb"></div></div> <div class="pc" data-sec="mindset"><div class="ph" data-action="toggle-section"><span class="badge b-mindset">01 · MINDSET</span><div class="pt">Morning Mindset & Non-Negotiables</div><span class="collapse-ico">▾</span></div><div class="pb" id="mindset-pb"></div></div> <div class="pc" data-sec="regiment"><div class="ph" data-action="toggle-section"><span class="badge b-daily">02 · REGIMENT</span><div class="pt">Optimal Daily Regiment</div><span class="collapse-ico">▾</span></div><div class="pb" id="regiment-pb"></div></div> <div class="pc" data-sec="diet"><div class="ph" data-action="toggle-section"><span class="badge b-diet">03 · DIET</span><div class="pt">Diet Protocol & Macro Tracker</div><span class="collapse-ico">▾</span></div><div class="pb" id="diet-pb"></div></div> <div class="pc" data-sec="fitness"><div class="ph" data-action="toggle-section"><span class="badge b-fitness">04 · FITNESS</span><div class="pt">Fitness Log</div><span class="collapse-ico">▾</span></div><div class="pb" id="fit-pb"></div></div> <div class="pc" data-sec="pr"><div class="ph" data-action="toggle-section"><span class="badge b-pr">05 · PR TRACKER</span><div class="pt">Personal Records & Body Metrics</div><span class="collapse-ico">▾</span></div><div class="pb" id="pr-pb"></div></div> <div class="pc" data-sec="log"><div class="ph" data-action="toggle-section"><span class="badge b-log">06 · LOG</span><div class="pt">Daily Log & Reflection</div><span class="collapse-ico">▾</span></div><div class="pb" id="log-pb"></div></div> <div class="pc" data-sec="goals"><div class="ph" data-action="toggle-section"><span class="badge b-goals">07 · GOALS</span><div class="pt">Goals & Vision</div><span class="collapse-ico">▾</span></div><div class="pb" id="goals-pb"></div></div> <div class="pc" data-sec="habits"><div class="ph" data-action="toggle-section"><span class="badge b-habits">08 · HABITS</span><div class="pt">Weekly Habit Tracker & Monthly Scorecard</div><span class="collapse-ico">▾</span></div><div class="pb"><div class="rl">Check each habit for each day of the week</div><div style="overflow-x:auto;" id="habits-table-wrap"></div><div class="dv"><span class="dvt">Monthly Scorecard</span></div><div class="rl">Rate each month 1–10 or log a key result</div><div id="scorecard-wrap"></div></div></div> <div class="footer">NO BIG DEAL WITH JOE DEAL · DAILY SUCCESS PROGRAM · ${p.dk}</div>`;

main.appendChild(wrap);

document.getElementById('intel-pb').innerHTML=buildIntelligenceBrief(p);
document.getElementById('pipeline-pb').innerHTML=buildCRMContext();
document.getElementById('mindset-pb').innerHTML=buildMindsetSection(p);
document.getElementById('regiment-pb').innerHTML=buildRegimentSection(p);
document.getElementById('diet-pb').innerHTML=buildDietSection(p);
document.getElementById('fit-pb').innerHTML=buildFitnessSection(p);
document.getElementById('pr-pb').innerHTML=buildPRSection(p);
document.getElementById('log-pb').innerHTML=buildLogSection(p);
document.getElementById('goals-pb').innerHTML=buildGoalsSection(p);
document.getElementById('habits-table-wrap').innerHTML=buildHabitsTable(p);
document.getElementById('scorecard-wrap').innerHTML=buildScorecard(p);

const exs=p.exercises&&p.exercises.length?p.exercises:Array(4).fill({});
exs.forEach(ex=>addExercise(ex,false));

const d=p.data||{};
document.querySelectorAll('[data-k]').forEach(el=>{if(d[el.dataset.k]!==undefined&&!el.dataset.k.startsWith('diet-m'))el.value=d[el.dataset.k];});

document.querySelectorAll('textarea.ed').forEach(ta=>{ta.style.height='auto';ta.style.height=ta.scrollHeight+'px';ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=ta.scrollHeight+'px';markDirty();});});
document.querySelectorAll('input.ed,.bm-inp,.rbox input,.pr-inp,.scinp').forEach(e=>e.addEventListener('input',markDirty));

document.querySelectorAll('.pc[data-sec]').forEach(card=>{const st=JSON.parse(localStorage.getItem('nbd_collapsed')||'{}');if(st[card.dataset.sec])card.classList.add('collapsed');});

calcMacros();
window.scrollTo({top:0,behavior:'smooth'});
}

function toggleSection(ph){
const card=ph.closest('.pc');if(!card)return;card.classList.toggle('collapsed');
const st=JSON.parse(localStorage.getItem('nbd_collapsed')||'{}');
st[card.dataset.sec]=card.classList.contains('collapsed');
localStorage.setItem('nbd_collapsed',JSON.stringify(st));
}

function killCharts(){charts.forEach(c=>{try{c.destroy();}catch{}});charts=[];}
// Two renderDash() calls inside the 80ms defer both reach mkChart after
// killCharts ran — the second hit a canvas still holding a chart and threw.
function mkChart(id,labels,data,color){const ctx=document.getElementById(id);if(!ctx)return;const prev=(typeof Chart.getChart==='function')?Chart.getChart(ctx):null;if(prev){try{prev.destroy();}catch{}charts=charts.filter(c=>c!==prev);}const ch=new Chart(ctx,{type:'bar',data:{labels,datasets:[{data,backgroundColor:color,borderRadius:2,borderSkipped:false}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{font:{family:'DM Mono',size:9},color:'#888',maxRotation:45},grid:{display:false}},y:{ticks:{font:{family:'DM Mono',size:9},color:'#888'},grid:{color:'rgba(0,0,0,.05)'},beginAtZero:true}}}});charts.push(ch);}

function renderDash(){
killCharts();const main=document.getElementById('main');main.innerHTML='';
let totD=0,totR=0,totC=0,totA=0,totCon=0,bDV=0,bRV=0,bDI=-1,bRI=-1;
let runD=0,runW=0,runWin=0,maxD=0,maxW=0,maxWin=0,prevD=0,prevR=0,lastD=0,lastR=0;
const habTot=HABITS.map(()=>0),cLbls=[],cDoors=[],cRev=[],cClose=[];
pages.forEach((p,i)=>{
const k=p.kpi||{},d=p.data||{},rev=parseFloat(d['s-revenue']||0)||0;
totD+=k.doors||0;totC+=k.closes||0;totA+=k.appts||0;totCon+=k.contacts||0;totR+=rev;
if((k.doors||0)>bDV){bDV=k.doors||0;bDI=i;}if(rev>bRV){bRV=rev;bRI=i;}
HABITS.forEach((_,hi)=>{for(let di=0;di<7;di++)if(d[`habit-${hi}-${di}`]==='1')habTot[hi]++;});
cLbls.push(tlbl(p));cDoors.push(k.doors||0);cRev.push(rev);cClose.push(k.closes||0);
const doorTarget=getDoorTarget();
runD=(k.doors||0)>=(doorTarget||60)?runD+1:0;
runW=d['habit-1-0']==='1'?runW+1:0;
const floors=getFloors();const metCount=floors.filter(f=>d['floormet-'+f.id]==='1').length;
const floorPct=floors.length?metCount/floors.length:0;
runWin=floorPct>=0.67?runWin+1:0;
if(runD>maxD)maxD=runD;if(runW>maxW)maxW=runW;if(runWin>maxWin)maxWin=runWin;
if(i===pages.length-2){prevD=k.doors||0;prevR=rev;}if(i===pages.length-1){lastD=k.doors||0;lastR=rev;}
});
const pc=pages.length,avgD=pc?Math.round(totD/pc):0;
let gt;try{gt=JSON.parse(localStorage.getItem(GT_KEY)||'{"d":0,"r":0,"c":0}');}catch(e){gt={d:0,r:0,c:0};try{localStorage.removeItem(GT_KEY);}catch(_){}}
const fDC=totD?Math.round(totCon/totD*100):0,fCA=totCon?Math.round(totA/totCon*100):0,fACl=totA?Math.round(totC/totA*100):0;
function dbadge(c,p){if(pc<2)return'';const d=c-p;return d===0?'':(d>0?`<span class="delta up">▲${d}</span>`:`<span class="delta dn">▼${Math.abs(d)}</span>`);}
const now=new Date(),dim=new Date(now.getFullYear(),now.getMonth()+1,0).getDate(),dom=now.getDate(),dl=dim-dom;
const paceTarget=gt.r?(gt.r*(dom/dim)):0,isAhead=gt.r&&totR>=paceTarget;
const paceMsg=!gt.r?'Set a monthly revenue goal below to track pace':dl===0?(totR>=gt.r?'🏆 Goal hit!':'Month ended.'):(isAhead?`▲ Ahead of pace — $${Math.round(totR-paceTarget).toLocaleString()} ahead`:`▼ Need $${Math.max(0,Math.round(gt.r-totR)).toLocaleString()} more in ${dl} days`);
function gpRow(lbl,actual,target,key,color){const pct=target?Math.min(actual/target*100,100):0;const numTxt=target?`${Math.round(actual)} / ${target} (${Math.round(pct)}%)`:'Set target →';return `<div class="gpr"><div class="gph"><span class="gpn">${lbl}</span><span class="gpnum" id="gpnum-${key}">${numTxt}</span></div><div class="gpbg"><div class="gpb" id="gpbar-${key}" style="width:${pct}%;background:${color}"></div></div><input class="gpi" id="gpi-${key}" placeholder="Monthly target" type="number" min="0" value="${target||''}"></div>`;}

const cfg=getUserConfig();
const todayPage=pages.find(p=>isToday(p.dk));
const floors=getFloors();

let northStarHtml='';
if(cfg&&cfg.northStar){
const ns=cfg.northStar;
const isRevGoal=ns.category==='Make more money'||ns.category==='Grow my business';
const nsPct=isRevGoal&&gt.r?Math.min(totR/gt.r*100,100):0;
northStarHtml=`<div class="dc wide"><div class="dct">⭐ North Star <small>YOUR PRIMARY GOAL</small></div> <div style="margin-bottom:10px;padding:10px 0;border-bottom:1px solid var(--rule);"> <div style="font-family:'Barlow Condensed',sans-serif;font-size:16px;color:var(--ac);letter-spacing:.05em;">${ns.category}</div> <div style="font-size:13px;color:var(--ink);margin-top:3px;">${ns.target||'No specific target set — click ⚙️ to update'}</div> ${ns.deadline?`<div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:var(--muted);margin-top:4px;letter-spacing:.1em;">DEADLINE: ${ns.deadline}</div>`:''} </div> ${isRevGoal?`<div class="pace-wrap" style="margin-top:8px;">
<div class="pace-row"><span class="pace-lbl">Revenue</span><div class="pace-bg"><div class="pace-bar" style="width:${gt.r?Math.min(totR/gt.r*100,100):0}%;background:var(--grn)"></div></div><span class="pace-stat">$${Math.round(totR).toLocaleString()}</span></div>
<div class="pace-row"><span class="pace-lbl">On Pace</span><div class="pace-bg"><div class="pace-bar" style="width:${gt.r?Math.min(paceTarget/gt.r*100,100):0}%;background:rgba(245,158,11,.5)"></div></div><span class="pace-stat">$${Math.round(paceTarget).toLocaleString()}</span></div>
<div class="pace-row"><span class="pace-lbl">Goal</span><div class="pace-bg"><div class="pace-bar" style="width:100%;background:rgba(0,0,0,.07)"></div></div><span class="pace-stat">$${Number(gt.r||0).toLocaleString()}</span></div>
<div class="pace-msg ${!gt.r?'none':isAhead?'ahead':'behind'}">${paceMsg}</div>
${gt.r?`<div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:var(--muted);margin-top:3px;">Day ${dom} of ${dim} · ${dl} days remaining</div>`:''}
</div>`:''} </div>`;
}

let floorsStatusHtml='';
{
const todayD=todayPage?todayPage.data||{}:{};
const floorRows=floors.map(f=>{
const met=todayD['floormet-'+f.id]==='1';
return `<div style="display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid var(--rule);"> <div style="width:10px;height:10px;border-radius:50%;flex-shrink:0;background:${met?'var(--grn)':'transparent'};border:1.5px solid ${met?'var(--grn)':'#445566'};"></div> <span style="flex:1;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:${met?'#4caf82':'var(--muted)'};">${f.label}</span> <span style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:#334455;">≥${f.targetValue} ${f.unit}</span> </div>`;
}).join('');
const metToday=todayPage?floors.filter(f=>todayD['floormet-'+f.id]==='1').length:0;
floorsStatusHtml=`<div class="dc"><div class="dct">Daily Floors <small>TODAY'S STATUS</small></div> ${todayPage?`<div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:${metToday===floors.length?'#4caf82':'var(--gold)'};margin-bottom:8px;letter-spacing:.1em;">${metToday}/${floors.length} FLOORS MET</div>`:`<div class="de">No entry for today yet</div>`} ${floorRows} <button class="btn btn-ghost" style="margin-top:12px;width:100%;justify-content:center;font-size:9px;" data-action="quick-start-defaults">↺ Reset to Quick Start Defaults</button> </div>`;
}

const wrap=document.createElement('div');wrap.className='dw';
wrap.innerHTML=` <div class="dhero"><div><div class="dhero-t">Program Dashboard</div><div class="dhero-s">${pc} PAGE${pc!==1?'S':''} · ALL-TIME AGGREGATES</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-ghost" data-action="export-csv">CSV</button><button class="btn btn-gold" data-action="do-print">PDF</button><button class="btn btn-ghost" data-action="open-onboard">⚙️ CUSTOMIZE</button></div></div> <div class="dgrid"> ${northStarHtml} <div class="dc"><div class="dct">Activity Totals <small>ALL PAGES</small></div><div class="srow2"><div class="sb"><div class="sv">${totD}${dbadge(lastD,prevD)}</div><div class="sl">Doors</div></div><div class="sb"><div class="sv">${avgD}</div><div class="sl">Avg/Day</div></div><div class="sb"><div class="sv">${totC}</div><div class="sl">Closes</div></div></div><div class="srow2"><div class="sb"><div class="sv">${totA}</div><div class="sl">Appts</div></div><div class="sb" style="flex:2"><div class="sv" style="font-size:22px">$${totR.toLocaleString()}${dbadge(lastR,prevR)}</div><div class="sl">Revenue</div></div></div></div> ${floorsStatusHtml} <div class="dc"><div class="dct">Streaks & Records</div>${bDI>=0?`<div class="best" data-action="switch-to" data-page-idx="${bDI}"><div class="best-ico">🚪</div><div class="best-info"><div class="best-lbl">Best Door Day</div><div class="best-val">${tlbl(pages[bDI])} · ${bDV} doors</div></div></div>`:''} ${bRI>=0?`<div class="best" data-action="switch-to" data-page-idx="${bRI}"><div class="best-ico">💰</div><div class="best-info"><div class="best-lbl">Best Revenue Day</div><div class="best-val">${tlbl(pages[bRI])} · $${bRV.toLocaleString()}</div></div></div>`:''}<div class="sk-row"><div class="sk ${runD>=3?'gold':''}"><div class="sk-icon">🚪</div><div class="sk-val">${runD}</div><div class="sk-lbl">Door Streak</div></div><div class="sk ${runW>=3?'gold':''}"><div class="sk-icon">💪</div><div class="sk-val">${runW}</div><div class="sk-lbl">Workout Streak</div></div><div class="sk ${runWin>=3?'gold':''}"><div class="sk-icon">⭐</div><div class="sk-val">${runWin}</div><div class="sk-lbl">Win Streak</div></div></div></div> <div class="dc"><div class="dct">Monthly Goals <small>SET TARGETS</small></div><div class="gpw">${gpRow('Doors',totD,gt.d,'d','var(--blu)')}${gpRow('Revenue ($)',totR,gt.r,'r','var(--grn)')}${gpRow('Closes',totC,gt.c,'c','var(--ac)')}</div></div> <div class="dc wide"><div class="dct">Revenue Pace <small>VS MONTHLY GOAL</small></div><div class="pace-wrap"><div class="pace-row"><span class="pace-lbl">Actual</span><div class="pace-bg"><div class="pace-bar" style="width:${gt.r?Math.min(totR/gt.r*100,100):0}%;background:var(--grn)"></div></div><span class="pace-stat">$${Math.round(totR).toLocaleString()}</span></div><div class="pace-row"><span class="pace-lbl">On Pace</span><div class="pace-bg"><div class="pace-bar" style="width:${gt.r?Math.min(paceTarget/gt.r*100,100):0}%;background:rgba(245,158,11,.5)"></div></div><span class="pace-stat">$${Math.round(paceTarget).toLocaleString()}</span></div><div class="pace-row"><span class="pace-lbl">Goal</span><div class="pace-bg"><div class="pace-bar" style="width:100%;background:rgba(0,0,0,.07)"></div></div><span class="pace-stat">$${Number(gt.r||0).toLocaleString()}</span></div><div class="pace-msg ${!gt.r?'none':isAhead?'ahead':'behind'}">${paceMsg}</div>${gt.r?`<div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:var(--muted);margin-top:3px;">Day ${dom} of ${dim} · ${dl} days remaining</div>`:''}</div></div> <div class="dc wide"><div class="dct">Doors Knocked <small>PER PAGE</small></div><canvas id="c-doors" height="60"></canvas></div> <div class="dc"><div class="dct">Revenue <small>PER PAGE</small></div><canvas id="c-rev" height="100"></canvas></div> <div class="dc"><div class="dct">Closes <small>PER PAGE</small></div><canvas id="c-close" height="100"></canvas></div> <div class="dc wide"><div class="dct">Habit Compliance <small>CUMULATIVE</small></div>${HABITS.map((h,i)=>{const tot=habTot[i],max=pc*7,pct=max?Math.round(tot/max*100):0;return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--rule)"><span style="flex:1;font-size:12px;color:var(--ink)">${h}</span><div style="width:80px;height:5px;background:var(--rule);border-radius:3px;overflow:hidden;flex-shrink:0"><div style="height:100%;width:${pct}%;background:var(--grn);border-radius:3px"></div></div><span style="font-family:'Barlow Condensed',sans-serif;font-size:10px;color:var(--muted);min-width:24px;text-align:right">${tot}</span></div>`;}).join('')}</div> <div class="dc wide"><div class="dct">All Pages <small>CLICK TO NAVIGATE</small></div>${!pages.length?`<div class="de">No pages yet</div>`:pages.map((p,i)=>{const rev=parseFloat(p.data?.['s-revenue']||0)||0;const td=isToday(p.dk)?'<span class="today-dot" style="margin-left:4px"></span>':'';return `<div class="prd" data-action="switch-to" data-page-idx="${i}"><div class="prd-l"><span class="prd-d">${tlbl(p)}${td} · ${dkFull(p.dk).split(',')[0]}</span><span class="prd-s">Doors: ${p.kpi?.doors||0} · Closes: ${p.kpi?.closes||0} · Rev: $${rev.toLocaleString()}${p.data?.['s-territory']?' · '+p.data['s-territory']:''}</span></div><span style="color:var(--rule);flex-shrink:0">→</span></div>`;}).join('')}</div> </div>`;
main.appendChild(wrap);
// Debounce localStorage writes on goal-target keystrokes — one write per
// 250ms idle beats one write per keystroke (the old behavior burned CPU
// on every digit of "1234567" and triggered storage events across tabs).
let _gtWriteTimer=null;
const _scheduleGtWrite=()=>{clearTimeout(_gtWriteTimer);_gtWriteTimer=setTimeout(()=>{try{localStorage.setItem(GT_KEY,JSON.stringify(gt));}catch(e){console.warn('[daily-success] gt write failed',e);}},250);};
['d','r','c'].forEach(k=>{const el=document.getElementById('gpi-'+k);if(!el)return;el.addEventListener('input',()=>{const v=parseFloat(el.value)||0;gt[k]=v;_scheduleGtWrite();const actual=k==='d'?totD:k==='r'?totR:totC;const pct=v?Math.min(actual/v*100,100):0;const bar=document.getElementById('gpbar-'+k),num=document.getElementById('gpnum-'+k);if(bar)bar.style.width=pct+'%';if(num)num.textContent=v?`${Math.round(actual)} / ${v} (${Math.round(pct)}%)`:'Set target →';});el.addEventListener('blur',()=>{if(_gtWriteTimer){clearTimeout(_gtWriteTimer);try{localStorage.setItem(GT_KEY,JSON.stringify(gt));}catch(e){}}});});
setTimeout(()=>{mkChart('c-doors',cLbls,cDoors,'rgba(249,115,22,.65)');mkChart('c-rev',cLbls,cRev,'rgba(42,102,68,.65)');mkChart('c-close',cLbls,cClose,'rgba(26,58,110,.65)');},80);
}

function getDoorTarget(){
const cfg=getUserConfig();
if(!cfg||!cfg.floors)return null;
const df=cfg.floors.find(f=>f.label.toLowerCase().includes('door'));
return df?parseFloat(df.targetValue)||null:null;
}

function exportCSV(){
const rows=[['Date','Label','Territory','Weather','Hours','Doors','Contacts','Appts','Closes','No-Shows','Revenue','Overall','Energy','Focus','Win','Lesson']];
pages.forEach(p=>{const k=p.kpi||{},d=p.data||{};rows.push([p.dk,tlbl(p),d['s-territory']||'',d['s-weather']||'',d['s-hours']||'',k.doors||0,k.contacts||0,k.appts||0,k.closes||0,k.noshow||0,d['s-revenue']||0,d['l-ov']||'',d['l-en']||'',d['l-fo']||'',d['l-win']||'',d['l-les']||'']);});
const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='nbd-daily-success.csv';a.click();toast('CSV exported!');
}

function toggleSearch(){searchOpen=!searchOpen;document.getElementById('sbar').classList.toggle('open',searchOpen);document.getElementById('tabrow').classList.toggle('sp',searchOpen);document.getElementById('main').classList.toggle('sp',searchOpen);if(searchOpen)setTimeout(()=>document.getElementById('sinp').focus(),80);else{document.getElementById('sdrop').classList.remove('open');document.getElementById('sinp').value='';}}
function doSearch(q){const drop=document.getElementById('sdrop');if(!q.trim()){drop.classList.remove('open');return;}const ql=q.toLowerCase(),hits=[];pages.forEach((p,pi)=>{const fields=Object.values(p.data||{}).join(' ').toLowerCase();if(fields.includes(ql)){const preview=Object.values(p.data||{}).find(v=>v.toLowerCase().includes(ql))||'';hits.push({pi,label:tlbl(p),preview});}});if(!hits.length){drop.innerHTML=`<div class="sr0">No results for "${q}"</div>`;drop.classList.add('open');return;}const re=new RegExp(q.replace(/[.*+?^${}()|[]\]/g,'\$&'),'gi');drop.innerHTML=hits.map(h=>`<div class="sri" data-action="search-jump" data-page-idx="${h.pi}"><div class="srd">${h.label}</div><div class="srt">${h.preview.replace(/</g,'&lt;').replace(re,m=>`<mark>${m}</mark>`)}</div></div>`).join('');drop.classList.add('open');}

function doPrint(){if(cur<0){toast('Open a page first');return;}saveNow();window.print();}
function openM(id){document.getElementById(id).classList.add('open');}
function closeM(id){document.getElementById(id).classList.remove('open');}
function closeWelcome(){document.getElementById('welcomeModal').style.display='none';localStorage.setItem('nbd-welcome-seen','1');}
// 📖 reopen: #welcomeModal is shown via inline display (welcome-gate.js sets
// display:flex on first visit; closeWelcome sets display:none) and has no
// .open CSS rule — openM's classList.add('open') alone never re-showed it
// (confirmed live 2026-06-10: class added, computed display stayed none).
// Set the inline display to match the close path.
function openWelcomeGuide(){const m=document.getElementById('welcomeModal');m.style.display='flex';openM('welcomeModal');}
// 2026-07-19 consolidation: delegates to the shared /pro/js/toast.js module
// (dashboard contract, loaded by index.html before this script). The old
// #toast singleton here was always-green, so calls map to 'success'.
function toast(msg){window.showToast(msg,'success');}

// ═══════════════════════════════════════════
// WIDGET BRIDGE — sync DS data → Home widget keys
// ═══════════════════════════════════════════
function syncToWidgetKeys(){
try{
const cfg=getUserConfig();
const today=todayKey();
const floors=getFloors();
const todayPage=pages.find(p=>p.dk===today);
const td=todayPage?todayPage.data||{}:{};

// Write nbd_ds_config (what widgets read)
const widgetCfg={
northStar:cfg?.northStar?.target||cfg?.northStar?.category||'',
northStarDeadline:cfg?.northStar?.deadline||'',
floors:floors.map(f=>({label:f.label,target:parseFloat(f.targetValue)||1,unit:f.unit||''})),
goldenGoose:cfg?.goose||''
};
localStorage.setItem('nbd_ds_config',JSON.stringify(widgetCfg));

// Write nbd_floor_progress_<date> (what Daily Floors widget reads)
const progress={};
floors.forEach((f,i)=>{
if(td['floormet-'+f.id]==='1') progress[i]=parseFloat(f.targetValue)||1;
else progress[i]=0;
});
localStorage.setItem('nbd_floor_progress_'+today,JSON.stringify(progress));

// Compute and write nbd_streak (what Streak widget reads)
const sorted=[...pages].sort((a,b)=>a.dk>b.dk?1:-1);
let streak=0;
for(let i=sorted.length-1;i>=0;i--){
const p=sorted[i],d=p.data||{};
const metCount=floors.filter(f=>d['floormet-'+f.id]==='1').length;
if(metCount===floors.length&&floors.length>0)streak++;
else break;
}
localStorage.setItem('nbd_streak',String(streak));

}catch(e){console.warn('Widget sync error:',e);}
}

// ═══════════════════════════════════════════
// AUTO-SAVE TIMER (every 30s when dirty)
// ═══════════════════════════════════════════
let _autoSaveInterval=null;
function startAutoSave(){
if(_autoSaveInterval)return;
_autoSaveInterval=setInterval(()=>{
if(dirty&&cur>=0){collectPage(true);syncToWidgetKeys();markSaved();showAutoSaveBadge();}
},30000);
}
function showAutoSaveBadge(){
const el=document.getElementById('autosave-badge');
if(!el)return;
el.textContent='Auto-saved';el.style.opacity='1';
setTimeout(()=>{el.style.opacity='0';},1800);
}

// ═══════════════════════════════════════════
// STREAK CELEBRATION — confetti burst when all floors hit
// ═══════════════════════════════════════════
let _celebratedToday=false;
function checkStreakCelebration(){
if(_celebratedToday)return;
const p=pages[cur];if(!p)return;
const floors=getFloors();
const d=p.data||{};
const metCount=floors.filter(f=>d['floormet-'+f.id]==='1').length;
if(metCount===floors.length&&floors.length>0){
_celebratedToday=true;
fireConfetti();
}
}
function fireConfetti(){
const canvas=document.createElement('canvas');
canvas.id='confetti-canvas';
canvas.style.cssText='position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;pointer-events:none;';
document.body.appendChild(canvas);
const ctx=canvas.getContext('2d');
canvas.width=window.innerWidth;canvas.height=window.innerHeight;
const colors=['#BD5728','#f59e0b','#22c55e','#3b82f6','#a855f7','#ec4899'];
const particles=[];
for(let i=0;i<120;i++){
particles.push({
x:canvas.width/2+(Math.random()-.5)*200,y:canvas.height/2,
vx:(Math.random()-.5)*14,vy:-Math.random()*16-4,
size:Math.random()*6+3,color:colors[Math.floor(Math.random()*colors.length)],
rot:Math.random()*Math.PI*2,rv:(Math.random()-.5)*.3,
life:1,decay:Math.random()*.015+.008
});
}
let raf;
function draw(){
ctx.clearRect(0,0,canvas.width,canvas.height);
let alive=0;
particles.forEach(p=>{
if(p.life<=0)return;alive++;
p.x+=p.vx;p.y+=p.vy;p.vy+=.35;p.rot+=p.rv;p.life-=p.decay;
ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot);
ctx.globalAlpha=Math.max(0,p.life);
ctx.fillStyle=p.color;
ctx.fillRect(-p.size/2,-p.size/2,p.size,p.size);
ctx.restore();
});
if(alive>0)raf=requestAnimationFrame(draw);
else{cancelAnimationFrame(raf);canvas.remove();}
}
draw();
toast('🏆 ALL FLOORS HIT — GOLDEN GOOSE EARNED!');
}

// ═══════════════════════════════════════════
// WEEK-AT-A-GLANCE MINI CALENDAR
// ═══════════════════════════════════════════
function buildWeekGlance(){
const floors=getFloors();
const today=new Date();
const dayOfWeek=today.getDay();
const monday=new Date(today);monday.setDate(today.getDate()-(dayOfWeek===0?6:dayOfWeek-1));
const days=['M','T','W','T','F','S','S'];
let html='<div style="display:flex;gap:5px;align-items:center;justify-content:center;">';
for(let i=0;i<7;i++){
const d=new Date(monday);d.setDate(monday.getDate()+i);
const dk=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const pg=pages.find(p=>p.dk===dk);
const pd=pg?pg.data||{}:{};
const metCount=floors.filter(f=>pd['floormet-'+f.id]==='1').length;
const total=floors.length;
const isToday=dk===todayKey();
let bg='transparent',border='#334455',color='#556677';
if(pg&&total>0){
const pct=metCount/total;
if(pct>=1){bg='var(--grn)';border='var(--grn)';color='#fff';}
else if(pct>=.5){bg='var(--gold)';border='var(--gold)';color='#fff';}
else if(pct>0){bg='rgba(249,115,22,.3)';border='var(--ac)';color='var(--ac)';}
}
const ring=isToday?'box-shadow:0 0 0 2px var(--ac);':'';
html+=`<div style="display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;" ${pg?`data-action="switch-to" data-page-idx="${pages.indexOf(pg)}"`:''}><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;color:${isToday?'var(--ac)':'#445566'};letter-spacing:.1em;font-weight:${isToday?'700':'400'}">${days[i]}</div><div style="width:28px;height:28px;border-radius:50%;background:${bg};border:1.5px solid ${border};display:flex;align-items:center;justify-content:center;font-family:'Barlow Condensed',sans-serif;font-size:10px;color:${color};${ring}">${pg&&total>0?metCount:d.getDate()}</div></div>`;
}
html+='</div>';
return html;
}

// ═══════════════════════════════════════════
// DAILY COMPARISON PANEL (vs yesterday / vs best)
// ═══════════════════════════════════════════
function buildDailyComparison(p){
if(pages.length<2)return '';
const sorted=[...pages].sort((a,b)=>a.dk>b.dk?1:-1);
const idx=sorted.findIndex(x=>x.id===p.id);
const prev=idx>0?sorted[idx-1]:null;
const kpi=p.kpi||{},d=p.data||{};
const doors=kpi.doors||0,rev=parseFloat(d['s-revenue']||0)||0,contacts=kpi.contacts||0,closes=kpi.closes||0;
let bestDoors=0,bestRev=0,bestPage='';
pages.forEach(pg=>{
const k=pg.kpi||{},dd=pg.data||{};
if((k.doors||0)>bestDoors){bestDoors=k.doors;bestPage=tlbl(pg);}
const r=parseFloat(dd['s-revenue']||0)||0;if(r>bestRev)bestRev=r;
});
function delta(cur,prev,prefix){
if(prev===null||prev===undefined)return'<span style="color:#445566;">—</span>';
const d=cur-prev;
if(d===0)return'<span style="color:#445566;">—</span>';
return d>0?`<span style="color:var(--grn);">▲${prefix||''}${Math.abs(d)}</span>`:`<span style="color:var(--ac);">▼${prefix||''}${Math.abs(d)}</span>`;
}
const pD=prev?(prev.kpi?.doors||0):null;
const pR=prev?parseFloat(prev.data?.['s-revenue']||0)||0:null;
const pCon=prev?(prev.kpi?.contacts||0):null;
const pCl=prev?(prev.kpi?.closes||0):null;
return `<div style="background:#0a1018;width:100%;max-width:760px;border-radius:4px;padding:14px 22px;border:1px solid #1e2d40;border-left:4px solid var(--blu);">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
<span style="font-family:'Barlow Condensed',sans-serif;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#445566;">TODAY VS YESTERDAY</span>
<span style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:var(--gold);letter-spacing:.08em;">${prev?'vs '+tlbl(prev):'No previous day'}</span>
</div>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
<div style="text-align:center;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;color:#f4efe6;">${doors}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;color:#445566;letter-spacing:.1em;">DOORS</div><div style="font-size:10px;margin-top:2px;">${delta(doors,pD)}</div></div>
<div style="text-align:center;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;color:#f4efe6;">${contacts}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;color:#445566;letter-spacing:.1em;">CONTACTS</div><div style="font-size:10px;margin-top:2px;">${delta(contacts,pCon)}</div></div>
<div style="text-align:center;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;color:#f4efe6;">${closes}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;color:#445566;letter-spacing:.1em;">CLOSES</div><div style="font-size:10px;margin-top:2px;">${delta(closes,pCl)}</div></div>
<div style="text-align:center;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;color:#f4efe6;">$${Math.round(rev).toLocaleString()}</div><div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;color:#445566;letter-spacing:.1em;">REVENUE</div><div style="font-size:10px;margin-top:2px;">${delta(rev,pR,'$')}</div></div>
</div>
${bestDoors>0?`<div style="display:flex;gap:10px;margin-top:8px;padding-top:8px;border-top:1px solid #1e2d40;"><span style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:#334455;">🏆 Best: ${bestDoors} doors · $${Math.round(bestRev).toLocaleString()} rev</span></div>`:''}
</div>`;
}

// ═══════════════════════════════════════════
// HOOK INTO EXISTING SYSTEMS
// ═══════════════════════════════════════════
// Patch toggleFloor to add celebration + widget sync
const _origToggleFloor=toggleFloor;
function toggleFloorPatched(floorId){
_origToggleFloor(floorId);
checkStreakCelebration();
syncToWidgetKeys();
// Refresh week glance
const wg=document.getElementById('week-glance-wrap');
if(wg){wg.innerHTML='<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#445566;margin-bottom:8px;text-align:center;">THIS WEEK AT A GLANCE</div>'+buildWeekGlance();}
}
window.toggleFloor=toggleFloorPatched;
// Patch collectPage to sync widget keys after save
const _origCollectPage=collectPage;
function collectPagePatched(silent){
_origCollectPage(silent);
syncToWidgetKeys();
}
window.collectPage=collectPagePatched;

// ═══════════════════════════════════════════
// ONBOARDING SYSTEM
// ═══════════════════════════════════════════
function checkOnboardBanner(){
if(!localStorage.getItem(NBD_CFG)){
document.getElementById('onboard-banner').classList.add('visible');
document.body.classList.add('has-banner');
}
}

function hideBanner(){
document.getElementById('onboard-banner').classList.remove('visible');
document.body.classList.remove('has-banner');
}

function openOnboard(){
obStep=1;
obFloors=[];
const cfg=getUserConfig();
if(cfg){
if(cfg.northStar){
const s=document.getElementById('ob-cat');if(s)s.value=cfg.northStar.category||'Other';
const t=document.getElementById('ob-target');if(t)t.value=cfg.northStar.target||'';
const d=document.getElementById('ob-deadline');if(d)d.value=cfg.northStar.deadline||'';
}
if(cfg.floors&&cfg.floors.length){
obFloors=cfg.floors.map(f=>({...f}));
}
if(cfg.bodyweight){const bw=document.getElementById('ob-bodyweight');if(bw)bw.value=cfg.bodyweight;}
if(cfg.goose){const g=document.getElementById('ob-goose');if(g)g.value=cfg.goose;}
const sg=document.getElementById('ob-showgoose');if(sg)sg.checked=cfg.showGoose!==false;
}
showOnboardStep(1);
openM('mOnboard');
}

function showOnboardStep(n){
obStep=n;
for(let i=1;i<=4;i++){
const el=document.getElementById('ob-step-'+i);
if(el)el.classList.toggle('active',i===n);
const dot=document.getElementById('ob-dot-'+i);
if(dot)dot.classList.toggle('active',i===n);
}
document.getElementById('ob-progress-lbl').textContent=`Step ${n} of 4`;
const prev=document.getElementById('ob-prev');
if(prev)prev.style.display=n===1?'none':'inline-flex';
const next=document.getElementById('ob-next');
if(next)next.textContent=n===4?'Save & Launch ✓':'Next →';
if(n===3){
if(obFloors.length===0){
const cat=document.getElementById('ob-cat')?.value||'Other';
const bw=parseFloat(document.getElementById('ob-bodyweight')?.value)||150;
const checked=Array.from(document.querySelectorAll('#ob-step-2 input[type=checkbox]:checked')).map(el=>el.value);
obFloors=buildMergedFloors(cat,checked,bw);
}
renderFloorEditor();
const hint=document.getElementById('floor-regen-hint');
if(!hint){
const wrap=document.getElementById('floor-editor');
if(wrap){
const btn=document.createElement('button');
btn.id='floor-regen-hint';
btn.className='addbtn';
btn.style.cssText='margin-top:6px;margin-bottom:2px;border-color:var(--ac);color:var(--ac);';
btn.textContent='↺ Regenerate suggestions from Step 1 & 2';
btn.onclick=()=>{
const cat=document.getElementById('ob-cat')?.value||'Other';
const bw=parseFloat(document.getElementById('ob-bodyweight')?.value)||150;
const checked=Array.from(document.querySelectorAll('#ob-step-2 input[type=checkbox]:checked')).map(el=>el.value);
obFloors=buildMergedFloors(cat,checked,bw);
renderFloorEditor();
};
wrap.parentNode.insertBefore(btn,wrap.nextSibling);
}
}
}
}

function onboardNext(){
if(obStep===4){saveOnboardConfig();return;}
if(obStep===2){
const cat=document.getElementById('ob-cat')?.value||'Other';
const bw=parseFloat(document.getElementById('ob-bodyweight')?.value)||150;
const checked=Array.from(document.querySelectorAll('#ob-step-2 input[type=checkbox]:checked')).map(el=>el.value);
obFloors=buildMergedFloors(cat,checked,bw);
}
showOnboardStep(obStep+1);
}

function onboardPrev(){
if(obStep>1)showOnboardStep(obStep-1);
}

function renderFloorEditor(){
const wrap=document.getElementById('floor-editor');
if(!wrap)return;
wrap.innerHTML='';
obFloors.forEach((f,i)=>{
const row=document.createElement('div');
row.className='floor-row';
row.innerHTML=`<input class="floor-inp" placeholder="Floor label" value="${(f.label||'').replace(/"/g,'&quot;')}" data-input-action="ob-floor-label" data-floor-idx="${i}"><input class="floor-inp num" placeholder="Tgt" type="number" value="${f.targetValue||1}" data-input-action="ob-floor-target" data-floor-idx="${i}"><input class="floor-inp num" placeholder="Unit" value="${(f.unit||'done').replace(/"/g,'&quot;')}" data-input-action="ob-floor-unit" data-floor-idx="${i}"><button data-action="remove-floor-row" data-floor-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#c04040;font-size:17px;line-height:1;padding:0;">×</button>`;
wrap.appendChild(row);
});
}

function removeFloorRow(i){
obFloors.splice(i,1);
renderFloorEditor();
}

function addFloorRow(){
if(obFloors.length>=7){toast('Max 7 floors');return;}
obFloors.push({id:'f'+Date.now(),label:'',targetValue:1,unit:'done'});
renderFloorEditor();
}

function saveOnboardConfig(){
const floors=obFloors.filter(f=>(f.label||'').trim());
if(!floors.length){toast('Add at least one floor');return;}
const config={
northStar:{
category:document.getElementById('ob-cat')?.value||'Other',
target:document.getElementById('ob-target')?.value||'',
deadline:document.getElementById('ob-deadline')?.value||''
},
bodyweight:parseFloat(document.getElementById('ob-bodyweight')?.value)||0,
floors:floors,
goose:document.getElementById('ob-goose')?.value||'',
showGoose:document.getElementById('ob-showgoose')?.checked!==false
};
localStorage.setItem(NBD_CFG,JSON.stringify(config));
closeM('mOnboard');
hideBanner();
toast('Your Daily OS is live ✓');
if(cur===-1)renderDash();else renderPage();
}

function quickStartDefaults(){
const bw=getBodyweight();
const config={
northStar:{category:'Other',target:'',deadline:''},
bodyweight:bw,
floors:getDefaultFloors(),
goose:'30 min of guilt-free screen time',
showGoose:true
};
localStorage.setItem(NBD_CFG,JSON.stringify(config));
hideBanner();
toast('Quick Start applied ✓');
if(cur===-1)renderDash();else renderPage();
}

document.addEventListener('keydown',e=>{
if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveNow();}
if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();toggleSearch();}
if(e.key==='Escape'){closeM('mDel');closeM('mRen');closeM('mPRH');closeM('mOnboard');if(searchOpen)toggleSearch();}
});
window.addEventListener('beforeunload',()=>{if(dirty)collectPage(true);});

initTheme();loadPages();renderTabs();renderDash();markSaved();checkOnboardBanner();syncToWidgetKeys();startAutoSave();

// ── DAILY SUCCESS THEME SYSTEM ──────────────────
/* ═══════════════════════════════════════════════════════════════════
   NBD UNIFIED APPEARANCE ENGINE v1.0
   Shared by: pro/dashboard.html + pro/daily-success/index.html
   DO NOT EDIT independently in each file — keep in sync.
   ═══════════════════════════════════════════════════════════════════ */

/* ── THEME REGISTRY (100 themes) ──────────────────────────────────── */
const NBD_THEMES = [
  // STANDARD
  {id:'default',          name:'NBD Default',       cat:'standard', plan:'blueprint', accent:'#BD5728', bg:'#0A0C0F', s:'#13171d', jp:true},
  {id:'matrix',           name:'Matrix',            cat:'standard', plan:'blueprint', accent:'#00ff41', bg:'#000300', s:'#000800'},
  {id:'neon',             name:'Neon',              cat:'standard', plan:'foundation',accent:'#ff00ff', bg:'#08000f', s:'#120018'},
  {id:'galaxy',           name:'Galaxy',            cat:'standard', plan:'foundation',accent:'#9c27b0', bg:'#06000e', s:'#0e0020'},
  {id:'space',            name:'Space',             cat:'standard', plan:'blueprint', accent:'#4fc3f7', bg:'#000508', s:'#000e18'},
  {id:'ghost',            name:'Ghost',             cat:'standard', plan:'blueprint', accent:'#aab8e0', bg:'#050810', s:'#0c1020'},
  {id:'glow',             name:'Glow',              cat:'standard', plan:'blueprint', accent:'#ff6d00', bg:'#050200', s:'#0e0600'},
  {id:'grayscale',        name:'Grayscale',         cat:'standard', plan:'blueprint', accent:'#c8c8c8', bg:'#0a0a0a', s:'#141414'},
  {id:'blackwhite',       name:'Black & White',     cat:'standard', plan:'blueprint', accent:'#ffffff', bg:'#000000', s:'#0a0a0a'},
  {id:'old-timey',        name:'Old Timey',         cat:'standard', plan:'blueprint', accent:'#c8840a', bg:'#1e1408', s:'#2c1e10'},
  // HEROES
  {id:'batman',           name:'Batman',            cat:'heroes',   plan:'foundation',accent:'#f5c518', bg:'#080808', s:'#111115', jp:true},
  {id:'superman',         name:'Superman',          cat:'heroes',   plan:'foundation',accent:'#e53935', bg:'#030060', s:'#050090'},
  {id:'captain-america',  name:'Captain America',  cat:'heroes',   plan:'foundation',accent:'#b71c1c', bg:'#030a20', s:'#071430'},
  {id:'wolverine',        name:'Wolverine',         cat:'heroes',   plan:'infused',   accent:'#ffd600', bg:'#0e0a00', s:'#1e1600'},
  {id:'magneto',          name:'Magneto',           cat:'heroes',   plan:'infused',   accent:'#ce0000', bg:'#0e000a', s:'#1e0018'},
  {id:'darth-vader',      name:'Darth Vader',       cat:'heroes',   plan:'foundation',accent:'#cc0000', bg:'#000000', s:'#080808', jp:true},
  {id:'stormtrooper',     name:'Stormtrooper',      cat:'heroes',   plan:'foundation',accent:'#111118', bg:'#f2f2f4', s:'#ffffff', lt:true},
  {id:'lightsaber',       name:'Lightsaber',        cat:'heroes',   plan:'foundation',accent:'#00e5ff', bg:'#000508', s:'#000d14'},
  {id:'halo',             name:'Halo',              cat:'heroes',   plan:'foundation',accent:'#00e676', bg:'#010a04', s:'#031408'},
  // GAMING
  {id:'pokemon',          name:'Pokémon',           cat:'gaming',   plan:'foundation',accent:'#ffcc02', bg:'#12223D', s:'#16213e'},
  {id:'mario',            name:'Mario',             cat:'gaming',   plan:'foundation',accent:'#e52222', bg:'#1a0800', s:'#2e1200'},
  {id:'mario-underground',name:'Mario Underground',cat:'gaming',   plan:'infused',   accent:'#6666ff', bg:'#000018', s:'#00002e'},
  {id:'kirby',            name:'Kirby',             cat:'gaming',   plan:'infused',   accent:'#ff4081', bg:'#120008', s:'#200014'},
  {id:'zelda',            name:'Zelda',             cat:'gaming',   plan:'infused',   accent:'#c8a800', bg:'#060e00', s:'#0e1c00'},
  {id:'megaman',          name:'Mega Man',          cat:'gaming',   plan:'infused',   accent:'#00a8e8', bg:'#00060e', s:'#000e20'},
  {id:'digimon',          name:'Digimon',           cat:'gaming',   plan:'team',      accent:'#ff6600', bg:'#0a0014', s:'#160028'},
  {id:'lego',             name:'Lego',              cat:'gaming',   plan:'team',      accent:'#ffd700', bg:'#0c0c00', s:'#1c1c00'},
  {id:'retro',            name:'Retro',             cat:'gaming',   plan:'blueprint', accent:'#ff8c00', bg:'#120a00', s:'#201400'},
  {id:'arcade',           name:'Arcade',            cat:'gaming',   plan:'blueprint', accent:'#ff0055', bg:'#000018', s:'#000030', jp:true},
  // OS / TECH
  {id:'android',          name:'Android',           cat:'os',       plan:'blueprint', accent:'#4caf50', bg:'#0a0f0a', s:'#141c14'},
  {id:'ios',              name:'iOS',               cat:'os',       plan:'blueprint', accent:'#0a84ff', bg:'#000000', s:'#1c1c1e'},
  {id:'ios26',            name:'iOS 26',            cat:'os',       plan:'foundation',accent:'#30d158', bg:'#050508', s:'#0e0e14', jp:true},
  {id:'windows',          name:'Windows',           cat:'os',       plan:'foundation',accent:'#0078d4', bg:'#001828', s:'#002040'},
  {id:'terminal',         name:'Terminal',          cat:'os',       plan:'blueprint', accent:'#00ff00', bg:'#000000', s:'#0a0a0a'},
  // MATERIAL
  {id:'liquid',           name:'Liquid',            cat:'material', plan:'foundation',accent:'#78c8e8', bg:'#080c12', s:'#101820'},
  {id:'material-metal',   name:'Metal',             cat:'material', plan:'team',      accent:'#c8ccd8', bg:'#0e0e10', s:'#1a1a1e'},
  {id:'translucent',      name:'Translucent',       cat:'material', plan:'infused',   accent:'#e8eeff', bg:'#030408', s:'#080c14'},
  {id:'frosted',          name:'Frosted',           cat:'material', plan:'infused',   accent:'#5064c8', bg:'#e8eaf2', s:'#f0f2fa', lt:true},
  {id:'glass',            name:'Glass',             cat:'material', plan:'team',      accent:'#64c8f8', bg:'#010610', s:'#081828'},
  // AMBIENT / MOOD
  {id:'candlelit',        name:'Candlelit',         cat:'ambient',  plan:'blueprint', accent:'#e8820a', bg:'#0c0600', s:'#180e00', jp:true},
  {id:'ember',            name:'Ember',             cat:'ambient',  plan:'blueprint', accent:'#ff4500', bg:'#0a0300', s:'#160800'},
  {id:'midnight-oil',     name:'Midnight Oil',      cat:'ambient',  plan:'foundation',accent:'#d4900a', bg:'#060402', s:'#100c06'},
  {id:'deep-focus',       name:'Deep Focus',        cat:'ambient',  plan:'foundation',accent:'#0d9488', bg:'#020404', s:'#060c0c'},
  {id:'neon-rain',        name:'Neon Rain',         cat:'ambient',  plan:'infused',   accent:'#ff2d9b', bg:'#06000e', s:'#0e0018'},
  {id:'noir',             name:'Noir',              cat:'ambient',  plan:'team',      accent:'#d8cfa8', bg:'#080604', s:'#121008'},
  {id:'blood-moon',       name:'Blood Moon',        cat:'ambient',  plan:'team',      accent:'#e8001a', bg:'#080002', s:'#140006'},
  {id:'aurora',           name:'Aurora',            cat:'ambient',  plan:'infused',   accent:'#00ffc0', bg:'#020810', s:'#040e18'},
  {id:'obsidian',         name:'Obsidian',          cat:'ambient',  plan:'infused',   accent:'#8b5cf6', bg:'#06040a', s:'#0e0c14'},
  {id:'copper',           name:'Copper',            cat:'ambient',  plan:'foundation',accent:'#b87333', bg:'#0c0800', s:'#1a1200'},
  {id:'sakura',           name:'Sakura',            cat:'ambient',  plan:'team',      accent:'#e8346c', bg:'#fff0f4', s:'#ffe8f0', lt:true},
  // ABSTRACT
  {id:'typewriter',       name:'Typewriter',        cat:'abstract', plan:'blueprint', accent:'#8b4513', bg:'#f0e8d4', s:'#e8dfc8', lt:true},
  {id:'ink',              name:'Ink',               cat:'abstract', plan:'blueprint', accent:'#0f0a04', bg:'#f5f0e8', s:'#ece6d8', lt:true},
  {id:'brutalist',        name:'Brutalist',         cat:'abstract', plan:'command',   accent:'#000000', bg:'#e8e8e8', s:'#ffffff', lt:true},
  {id:'vapor',            name:'Vaporwave',         cat:'abstract', plan:'infused',   accent:'#ff71ce', bg:'#0a0014', s:'#140028'},
  {id:'chalk',            name:'Chalk',             cat:'abstract', plan:'team',      accent:'#f8f8f8', bg:'#12223D', s:'#202040'},
  {id:'blueprint-art',    name:'Blueprint',         cat:'abstract', plan:'foundation',accent:'#ffffff', bg:'#001428', s:'#001e3c'},
  // TACTICAL
  {id:'army',             name:'Army',              cat:'tactical', plan:'infused',   accent:'#6a8c2a', bg:'#060a02', s:'#0e1808'},
  {id:'cia',              name:'CIA',               cat:'tactical', plan:'infused',   accent:'#c8a000', bg:'#020202', s:'#0c0c0c'},
  {id:'fbi',              name:'FBI',               cat:'tactical', plan:'infused',   accent:'#c0c8d8', bg:'#000410', s:'#000820'},
  {id:'ninja',            name:'Ninja',             cat:'tactical', plan:'foundation',accent:'#cc0000', bg:'#040400', s:'#0c0c00'},
  {id:'stoic',            name:'Stoic',             cat:'tactical', plan:'blueprint', accent:'#8a8a8a', bg:'#080808', s:'#101010'},
  // SEASONAL
  {id:'halloween',        name:'Halloween',         cat:'seasonal', plan:'blueprint', accent:'#ff6d00', bg:'#080200', s:'#100400'},
  {id:'christmas',        name:'Christmas',         cat:'seasonal', plan:'blueprint', accent:'#e53935', bg:'#000e04', s:'#001808'},
  {id:'easter',           name:'Easter',            cat:'seasonal', plan:'blueprint', accent:'#9c27b0', bg:'#f0e8f8', s:'#ffe8f8', lt:true},
  {id:'thanksgiving',     name:'Thanksgiving',      cat:'seasonal', plan:'blueprint', accent:'#bf6000', bg:'#120800', s:'#201200'},
  {id:'usa',              name:'USA',               cat:'seasonal', plan:'blueprint', accent:'#cc0000', bg:'#010614', s:'#020c28'},
  // NATURE
  {id:'underwater',       name:'Underwater',        cat:'nature',   plan:'foundation',accent:'#00e5cc', bg:'#000c14', s:'#001828'},
  {id:'forest',           name:'Forest',            cat:'nature',   plan:'infused',   accent:'#4caf50', bg:'#010a02', s:'#03140a'},
  {id:'ocean',            name:'Ocean',             cat:'nature',   plan:'infused',   accent:'#1565c0', bg:'#000612', s:'#000e22'},
  {id:'desert',           name:'Desert',            cat:'nature',   plan:'infused',   accent:'#d4870a', bg:'#100800', s:'#201400'},
  {id:'storm',            name:'Storm',             cat:'nature',   plan:'infused',   accent:'#7eb8f7', bg:'#04060e', s:'#080e18'},
  {id:'tundra',           name:'Tundra',            cat:'nature',   plan:'team',      accent:'#a8e8f0', bg:'#040e1c', s:'#081a2e'},
  {id:'volcanic',         name:'Volcanic',          cat:'nature',   plan:'team',      accent:'#ff3d00', bg:'#120000', s:'#220000'},
  // MUSIC
  {id:'hiphop',           name:'Hip Hop',           cat:'music',    plan:'team',      accent:'#ffd600', bg:'#08040c', s:'#120818'},
  {id:'jazz',             name:'Jazz',              cat:'music',    plan:'team',      accent:'#d4a020', bg:'#0e0800', s:'#1e1400'},
  {id:'metal',            name:'Heavy Metal',       cat:'music',    plan:'team',      accent:'#888888', bg:'#000000', s:'#080808'},
  {id:'synthwave',        name:'Synthwave',         cat:'music',    plan:'infused',   accent:'#f706cf', bg:'#0d0018', s:'#180030'},
  {id:'lofi',             name:'Lo-Fi',             cat:'music',    plan:'foundation',accent:'#c8a878', bg:'#f2ede4', s:'#ebe4d8', lt:true},
  {id:'punk',             name:'Punk',              cat:'music',    plan:'team',      accent:'#ff1744', bg:'#0e0000', s:'#1e0000'},
  // REGION
  {id:'japan',            name:'Japan',             cat:'region',   plan:'team',      accent:'#c41c24', bg:'#0a0608', s:'#180e12'},
  {id:'viking',           name:'Viking',            cat:'region',   plan:'team',      accent:'#9a7c28', bg:'#080c14', s:'#101820'},
  {id:'roman',            name:'Roman',             cat:'region',   plan:'team',      accent:'#c8960a', bg:'#100e08', s:'#1e1c10'},
  {id:'wildwest',         name:'Wild West',         cat:'region',   plan:'command',   accent:'#c87840', bg:'#120a00', s:'#201400'},
  {id:'samurai',          name:'Samurai',           cat:'region',   plan:'command',   accent:'#cc2200', bg:'#080208', s:'#120810'},
  {id:'pharaoh',          name:'Pharaoh',           cat:'region',   plan:'command',   accent:'#c8980a', bg:'#0e0c00', s:'#1e1c00'},
  // CULTURE
  {id:'american-dad',     name:'American Dad',      cat:'culture',  plan:'command',   accent:'#e53935', bg:'#010614', s:'#030e28'},
  {id:'family-guy',       name:'Family Guy',        cat:'culture',  plan:'command',   accent:'#f5c518', bg:'#001020', s:'#001c38'},
  {id:'south-park',       name:'South Park',        cat:'culture',  plan:'command',   accent:'#ff8c00', bg:'#08100a', s:'#101e12'},
];

/* ── FONT PAIRINGS (8 fonts) ──────────────────────────────────────── */
const NBD_FONTS = [
  { id:'nbd-default',    name:'NBD Default',    plan:'blueprint', css:{fd:"'Barlow Condensed',sans-serif",   fu:"'Barlow Condensed',sans-serif", fb:"'Barlow',sans-serif",          fm:"'DM Mono',monospace"},          preview:{d:'NBD PRO', b:'Sharp. Direct. Built for the field.'} },
  { id:'operator',       name:'Operator',       plan:'foundation',css:{fd:"'Unbounded',sans-serif",     fu:"'Unbounded',sans-serif",        fb:"'Inter',sans-serif",            fm:"'JetBrains Mono',monospace"},    preview:{d:'NBD PRO', b:'Technical. Futuristic. Command-grade.'} },
  { id:'editorial',      name:'Editorial',      plan:'infused',   css:{fd:"'Playfair Display',serif",   fu:"'Barlow Condensed',sans-serif", fb:"'Barlow',sans-serif",          fm:"'IBM Plex Mono',monospace"},     preview:{d:'NBD Pro', b:'Refined. Authoritative. Premium feel.'} },
  { id:'terminal-font',  name:'Terminal',       plan:'blueprint', css:{fd:"'Share Tech Mono',monospace",fu:"'Share Tech Mono',monospace",   fb:"'Share Tech Mono',monospace",   fm:"'Share Tech Mono',monospace"},   preview:{d:'> NBD_PRO', b:'All mono. Pure signal. Zero noise.'} },
  { id:'typewriter-font',name:'Typewriter',     plan:'foundation',css:{fd:"'Courier Prime',monospace",  fu:"'Barlow Condensed',sans-serif", fb:"'Courier Prime',monospace",     fm:"'Courier Prime',monospace"},     preview:{d:'NBD PRO', b:'Worn-in. Tactile. Old iron feel.'} },
  { id:'syne',           name:'Syne / Exo',     plan:'team',      css:{fd:"'Syne',sans-serif",           fu:"'Exo 2',sans-serif",            fb:"'Exo 2',sans-serif",            fm:"'JetBrains Mono',monospace"},    preview:{d:'NBD PRO', b:'Geometric. Modern. Interface-native.'} },
  { id:'chakra',         name:'Chakra Petch',   plan:'infused',   css:{fd:"'Chakra Petch',sans-serif",  fu:"'Chakra Petch',sans-serif",     fb:"'Barlow',sans-serif",           fm:"'Space Mono',monospace"},        preview:{d:'NBD PRO', b:'Military-tech. Tactical. Clean edge.'} },
  { id:'classic',        name:'Classic Serif',  plan:'command',   css:{fd:"'Anton',sans-serif",          fu:"'Barlow Condensed',sans-serif", fb:"'Libre Baskerville',serif",     fm:"'IBM Plex Mono',monospace"},     preview:{d:'NBD PRO', b:'Heavy headline. Old press authority.'} },
];

/* ── STATE ────────────────────────────────────────────────────────── */
const NBD_PLAN_ORDER  = ['blueprint','foundation','infused','team','command','professional'];
const NBD_USER_PLAN = (() => {
  // Map from Firestore subscription plan to daily-success plan tier
  const planMap = {
    'professional': 'professional',
    'blueprint': 'blueprint',
    'foundation': 'foundation',
    'pro': 'professional',
    'command': 'command'
  };
  try {
    // Try to read from parent window (dashboard context) or localStorage
    const stored = localStorage.getItem('nbd_user_plan') || 'professional';
    return planMap[stored] || 'professional';
  } catch(e) { return 'professional'; }
})();
let _nbd_activeTheme  = localStorage.getItem('nbd-theme') || 'default';
let _nbd_activeFont   = localStorage.getItem('nbd-font')  || 'nbd-default';
let _nbd_activeCat    = 'all';
let _nbd_customs      = JSON.parse(localStorage.getItem('nbd-customs') || '[]');

// All themes/fonts unlocked — single-tier mode (no plan gating)
const _nbdUnlocked  = p => true;
const _nbdGetTheme  = id => [...NBD_THEMES, ..._nbd_customs].find(t => t.id === id);

/* ── APPLY THEME ──────────────────────────────────────────────────── */
function nbdApplyTheme(id) {
  const t = _nbdGetTheme(id);
  if (!t) return;
  if (!_nbdUnlocked(t.plan) && t.cat !== 'custom') {
    nbdToast('🔒 Requires ' + t.plan + ' plan');
    return;
  }
  // 1. body class (v5 system)
  document.body.className = id === 'default' ? '' : 'theme-' + id;
  // 2. data-theme attr (v3 system)
  document.documentElement.setAttribute('data-theme', id);
  // 3. Force --ac + legacy DS vars immediately
  const R = document.documentElement.style;
  R.setProperty('--ac',     t.accent);
  R.setProperty('--orange', t.accent);
  R.setProperty('--gold',   t.accent);
  // bg/surface for DS pages that use --bg/--bar
  R.setProperty('--bg',  t.bg  || '#0A0C0F');
  R.setProperty('--bar', t.s   || '#13171d');
  // 4. Persist — write the legacy key AND the canonical engine key (PR #557 F-1
  //    cross-surface convergence) so a theme picked on this standalone page
  //    survives the dashboard's canonical-key read instead of being silently
  //    reverted. The engine calls the legacy 'default' id 'nbd-original'.
  _nbd_activeTheme = id;
  localStorage.setItem('nbd-theme', id);
  try { localStorage.setItem('nbd_pro_theme', id === 'default' ? 'nbd-original' : id); } catch (e) {}
  // 5. (removed, audit 2026-06-10) A compat-SDK Firestore theme sync lived
  //    here guarded on global `db`/`currentUser` — neither exists on this
  //    page (modular SDK only, module-scoped in ds-firebase-sync.js), so the
  //    guard skipped it on every call since the page was built. localStorage
  //    (above) is the real persistence; the dashboard reads the canonical
  //    key. If cross-device theme sync is ever wanted here, route it through
  //    ds-firebase-sync's authed module instead.
  // 6. UI
  _nbdUpdateLabels(t);
  nbdRenderThemes();
  nbdToast('✓ ' + t.name);
}

/* ── APPLY FONT ───────────────────────────────────────────────────── */
// opts.silent: boot-time restore — no "✓ Font:" toast on every load.
function nbdApplyFont(id, opts) {
  const silent = !!(opts && opts.silent);
  const f = NBD_FONTS.find(f => f.id === id);
  if (!f) return;
  if (!_nbdUnlocked(f.plan)) { if (!silent) nbdToast('🔒 Font requires ' + f.plan + ' plan'); return; }
  const R = document.documentElement.style;
  R.setProperty('--fd', f.css.fd);
  R.setProperty('--fu', f.css.fu);
  R.setProperty('--fb', f.css.fb);
  R.setProperty('--fm', f.css.fm);
  document.body.style.fontFamily = f.css.fb;
  _nbd_activeFont = id;
  localStorage.setItem('nbd-font', id);
  nbdRenderFonts();
  if (!silent) nbdToast('✓ Font: ' + f.name);
}

/* ── LABELS ───────────────────────────────────────────────────────── */
function _nbdUpdateLabels(t) {
  const badge = document.getElementById('abadge') || document.querySelector('.tbb');
  if (badge) badge.textContent = t.name.toUpperCase();
  const nl = document.getElementById('npm-active-name');
  if (nl) nl.textContent = t.name;
  const ns = document.getElementById('npm-active-sub');
  if (ns) {
    const f = NBD_FONTS.find(f => f.id === _nbd_activeFont);
    ns.textContent = t.name + ' · ' + (f ? f.name : 'Default') + ' font';
  }
}

/* ── PICKER MODAL ─────────────────────────────────────────────────── */
function nbdPickerOpen()  { document.getElementById('nbd-picker-modal').classList.add('open'); nbdRenderCats(); nbdRenderThemes(); nbdRenderFonts(); }
function nbdPickerClose() { document.getElementById('nbd-picker-modal').classList.remove('open'); }
document.addEventListener('DOMContentLoaded', () => {
  const pm = document.getElementById('nbd-picker-modal');
  if (pm) pm.addEventListener('click', function(e) { if (e.target === this) nbdPickerClose(); });
});

function nbdPickerTab(tab, el) {
  document.querySelectorAll('.npm-tab').forEach(t => t.classList.remove('on'));
  el.classList.add('on');
  document.querySelectorAll('.npm-panel').forEach(p => p.classList.remove('on'));
  document.getElementById('npm-panel-' + tab).classList.add('on');
}

/* ── RENDER THEMES ────────────────────────────────────────────────── */
function nbdRenderThemes() {
  const grid = document.getElementById('npm-grid');
  if (!grid) return;
  const q = (document.getElementById('npm-search')?.value || '').toLowerCase();
  let list = [...NBD_THEMES, ..._nbd_customs];
  if (_nbd_activeCat !== 'all') list = list.filter(t => t.cat === _nbd_activeCat);
  if (q) list = list.filter(t => t.name.toLowerCase().includes(q));
  if (!list.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;font-size:11px;color:#5a6478;">No themes found.</div>'; return; }
  grid.innerHTML = '';
  list.forEach(t => {
    const ok = _nbdUnlocked(t.plan) || t.cat === 'custom';
    const isAct = t.id === _nbd_activeTheme;
    const hexLum = h => { const n=parseInt((h||'#000').replace('#',''),16); const r=((n>>16)&255)/255,g=((n>>8)&255)/255,b=(n&255)/255; const tl=c=>c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4); return 0.2126*tl(r)+0.7152*tl(g)+0.0722*tl(b); };
    const textCol = hexLum(t.bg||'#000') > 0.12 ? '#1a1208' : '#e8eaf0';
    const d = document.createElement('div');
    d.className = 'npm-bubble' + (isAct ? ' active' : '') + (ok ? '' : ' locked');
    d.onclick = () => { if (ok) nbdApplyTheme(t.id); else nbdToast('🔒 ' + t.plan + ' required'); };
    d.style.cssText = `background:${t.s||'#13171d'};border-color:${t.accent};box-shadow:inset 0 0 0 1px ${t.accent}33;`;
    if (isAct) d.style.boxShadow = `0 0 0 2.5px #fff, 0 4px 22px rgba(0,0,0,0.6)`;
    d.innerHTML = `<div class="npm-dot" style="background:${t.accent};box-shadow:0 0 5px ${t.accent}88"></div><span class="npm-lbl" style="color:${textCol}">${t.name}</span>${t.jp?`<span class="npm-star" style="color:${t.accent}">★</span>`:''}<div class="npm-activedot"></div>${!ok?'<div class="npm-lock-overlay">🔒</div>':''}`;
    grid.appendChild(d);
  });
}

function nbdRenderCats() {
  const el = document.getElementById('npm-cats');
  if (!el) return;
  const cats = ['all','standard','heroes','gaming','os','material','ambient','abstract','tactical','nature','music','region','seasonal','culture','custom'];
  const labels = {all:'All',standard:'Standard',heroes:'Heroes',gaming:'Gaming',os:'OS/Tech',material:'Material',ambient:'Ambient',abstract:'Abstract',tactical:'Tactical',nature:'Nature',music:'Music',region:'Region',seasonal:'Seasonal',culture:'Culture',custom:'⚡ Custom'};
  el.innerHTML = cats.map(c => `<button class="npm-cat${_nbd_activeCat===c?' on':''}" data-action="nbd-set-cat" data-cat="${c}">${labels[c]||c}</button>`).join('');
}

function nbdSetCat(cat, el) {
  _nbd_activeCat = cat;
  document.querySelectorAll('.npm-cat').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  nbdRenderThemes();
}

function nbdRandom() {
  const ok = NBD_THEMES.filter(t => _nbdUnlocked(t.plan));
  nbdApplyTheme(ok[Math.floor(Math.random() * ok.length)].id);
}

/* ── RENDER FONTS ─────────────────────────────────────────────────── */
function nbdRenderFonts() {
  const el = document.getElementById('npm-fonts');
  if (!el) return;
  el.innerHTML = '';
  NBD_FONTS.forEach(f => {
    const isAct = f.id === _nbd_activeFont;
    const ok = _nbdUnlocked(f.plan);
    const d = document.createElement('div');
    d.className = 'npm-font-card' + (isAct ? ' active' : '');
    d.style.opacity = ok ? '1' : '0.45';
    d.style.cursor = ok ? 'pointer' : 'default';
    d.onclick = () => nbdApplyFont(f.id);
    d.innerHTML = `<div class="npm-font-head">${f.name} ${!ok?'🔒':''}<div class="npm-font-check"></div></div><div class="npm-font-display" style="font-family:${f.css.fd}">${f.preview.d}</div><div class="npm-font-body" style="font-family:${f.css.fb}">${f.preview.b}</div><div class="npm-font-mono" style="font-family:${f.css.fm}">const lead = { name: 'Dave Pruitt' }</div>`;
    el.appendChild(d);
  });
}

/* ── CUSTOM BUILDER ───────────────────────────────────────────────── */
function nbdLiveCustom() {
  const bg=document.getElementById('ncp-bg').value, s=document.getElementById('ncp-s').value, ac=document.getElementById('ncp-accent').value, t=document.getElementById('ncp-t').value, m=document.getElementById('ncp-m').value;
  _nbdApplyCustomVars(ac,bg,s,t,m);
}
function nbdApplyCustom() { nbdLiveCustom(); nbdToast('Custom preview applied'); }
function nbdSaveCustom() {
  if (!_nbdUnlocked('command')) { nbdToast('🔒 Custom themes require Command plan'); return; }
  const ac=document.getElementById('ncp-accent').value, bg=document.getElementById('ncp-bg').value, s=document.getElementById('ncp-s').value, tc=document.getElementById('ncp-t').value, m=document.getElementById('ncp-m').value;
  const slot = { id:'custom-'+Date.now(), name:'Custom '+((_nbd_customs.length)+1), cat:'custom', plan:'command', accent:ac, bg, s, tc, m };
  _nbd_customs.push(slot);
  localStorage.setItem('nbd-customs', JSON.stringify(_nbd_customs));
  nbdToast('Saved: ' + slot.name);
  nbdRenderThemes();
}
function _nbdApplyCustomVars(accent,bg,s,text,muted) {
  const R = document.documentElement.style;
  const adj=(h,p)=>{const n=parseInt((h||'#000').replace('#',''),16);const r=Math.min(255,Math.max(0,((n>>16)&255)+Math.round(p*2.55)));const g=Math.min(255,Math.max(0,((n>>8)&255)+Math.round(p*2.55)));const b=Math.min(255,Math.max(0,(n&255)+Math.round(p*2.55)));return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);};
  R.setProperty('--bg',bg); R.setProperty('--s',s); R.setProperty('--bar',s);
  R.setProperty('--s2',adj(s,5)); R.setProperty('--s3',adj(s,10)); R.setProperty('--rule',adj(s,12));
  R.setProperty('--orange',accent); R.setProperty('--ac',accent);
  R.setProperty('--orange-h',adj(accent,12)); R.setProperty('--orange-a',adj(accent,-10));
  R.setProperty('--t',text); R.setProperty('--m',muted); R.setProperty('--muted',muted);
  try { const rr=parseInt(accent.slice(1,3),16),gg=parseInt(accent.slice(3,5),16),bb=parseInt(accent.slice(5,7),16); R.setProperty('--glow',`rgba(${rr},${gg},${bb},0.28)`); R.setProperty('--glow2',`rgba(${rr},${gg},${bb},0.09)`); } catch(e){}
}

/* ── COPY HELPERS ─────────────────────────────────────────────────── */
function nbdCopyClass() { const c=_nbd_activeTheme==='default'?'(default — no class needed)':`body.theme-${_nbd_activeTheme}`; navigator.clipboard?.writeText(c); nbdToast('Copied: '+c); }
function nbdCopyFS()    { const c=`await db.collection('users').doc(uid).update({ theme: '${_nbd_activeTheme}', font: '${_nbd_activeFont}' });`; navigator.clipboard?.writeText(c); nbdToast('Firestore write copied'); }

/* ── HOW-TO MODAL ─────────────────────────────────────────────────── */
function nbdHowtoOpen()  { document.getElementById('nbd-howto-modal').classList.add('open'); }
function nbdHowtoClose() { document.getElementById('nbd-howto-modal').classList.remove('open'); }
document.addEventListener('DOMContentLoaded', () => {
  const hm = document.getElementById('nbd-howto-modal');
  if (hm) hm.addEventListener('click', function(e) { if (e.target === this) nbdHowtoClose(); });
});

/* ── TOAST ────────────────────────────────────────────────────────── */
function nbdToast(msg) {
  let el = document.getElementById('nbd-toast') || document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id='nbd-toast'; el.className='nbd-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

/* ── GLOBAL ALIASES (backward compat for both pages) ─────────────── */
window.toggleThemeMenu         = nbdPickerOpen;
window.dsApplyTheme            = nbdApplyTheme;
window.buildTopbarThemeGrid    = nbdRenderThemes;
window.buildWelcomeThemePicker = () => {};  // DS welcome modal — no-op, full picker replaces it

/* ── BOOT ─────────────────────────────────────────────────────────── */
(function nbdBoot() {
  // Prefer the canonical engine key (nbd_pro_theme) so a theme picked on the
  // dashboard carries to this page; fall back to the legacy keys. Map the
  // engine's 'nbd-original' back to this surface's legacy 'default' (PR #557 F-1).
  let saved = localStorage.getItem('nbd_pro_theme');
  if (saved === 'nbd-original') saved = 'default';
  if (!saved) saved = localStorage.getItem('nbd-theme') || localStorage.getItem('ds-theme') || 'default';
  const t = _nbdGetTheme(saved) || _nbdGetTheme('default');
  if (t) {
    document.body.className = t.id === 'default' ? '' : 'theme-' + t.id;
    document.documentElement.setAttribute('data-theme', t.id);
    const R = document.documentElement.style;
    R.setProperty('--ac',     t.accent);
    R.setProperty('--orange', t.accent);
    R.setProperty('--gold',   t.accent);
    R.setProperty('--bg',     t.bg  || '#0A0C0F');
    R.setProperty('--bar',    t.s   || '#13171d');
    _nbd_activeTheme = t.id;
    _nbdUpdateLabels(t);
  }
  nbdApplyFont(localStorage.getItem('nbd-font') || 'nbd-default', { silent: true });
  nbdRenderCats();
})();

// Welcome modal gating now handled by the inline script directly
// after the modal's HTML block. The modal is hidden by default,
// so no late-hide check is needed here.

// ─────────────────────────────────────────────────
// CSP-safe event delegation. Every inline onclick/oninput/onmouseover/
// onmouseout the page used to carry is now expressed as data-action /
// data-input-action / data-hover-opacity, dispatched here. Keeps the
// strict ** CSP (script-src-attr 'none') applicable to this page.
// ─────────────────────────────────────────────────
(function nbdWireDelegates() {
  const clickHandlers = {
    'close-welcome':       () => closeWelcome(),
    'toggle-search':       () => toggleSearch(),
    'nbd-picker-open':     () => nbdPickerOpen(),
    'nbd-picker-close':    () => nbdPickerClose(),
    'nbd-picker-tab':      (el) => nbdPickerTab(el.dataset.arg, el),
    'open-onboard':        () => openOnboard(),
    'open-welcome-guide':  () => openWelcomeGuide(),
    'smart-new-page':      () => smartNewPage(),
    'open-rename':         () => openRename(),
    'trigger-del':         () => triggerDel(),
    'trigger-del-tab':     (el, ev) => { ev.stopPropagation(); triggerDel(+el.dataset.tabIdx); },
    'export-csv':          () => exportCSV(),
    'do-print':            () => doPrint(),
    'save-now':            () => saveNow(),
    'quick-start-defaults':() => quickStartDefaults(),
    'hide-banner':         () => hideBanner(),
    'close-m':             (el) => closeM(el.dataset.arg),
    'do-delete':           () => doDelete(),
    'apply-ren':           () => applyRen(),
    'add-floor-row':       () => addFloorRow(),
    'remove-floor-row':    (el) => removeFloorRow(+el.dataset.floorIdx),
    'onboard-prev':        () => onboardPrev(),
    'onboard-next':        () => onboardNext(),
    'nbd-random':          () => nbdRandom(),
    'nbd-apply-custom':    () => nbdApplyCustom(),
    'nbd-save-custom':     () => nbdSaveCustom(),
    'nbd-howto-open':      () => nbdHowtoOpen(),
    'nbd-howto-close':     () => nbdHowtoClose(),
    'nbd-copy-fs':         () => nbdCopyFS(),
    'nbd-set-cat':         (el) => nbdSetCat(el.dataset.cat, el),
    'switch-to':           (el) => switchTo(+el.dataset.pageIdx),
    'search-jump':         (el) => { switchTo(+el.dataset.pageIdx); toggleSearch(); },
    'toggle-floor':        (el) => toggleFloor(el.dataset.floorId),
    'toggle-mindset':      (el) => toggleMindset(el.dataset.mindsetId, el),
    'toggle-habit':        (el) => toggleHabit(el, el.dataset.habitKey, +el.dataset.habitRow),
    'toggle-section':      (el) => toggleSection(el),
    'add-exercise':        () => addExercise({}, true),
    'delete-exercise':     (el) => { el.closest('tr').remove(); markDirty(); },
    'open-pr-history':     (el) => openPRHistory(el.dataset.lift, el.dataset.prKey),
  };

  const inputHandlers = {
    'do-search':         (el) => doSearch(el.value),
    'nbd-render-themes': () => nbdRenderThemes(),
    'nbd-live-custom':   () => nbdLiveCustom(),
    'mark-dirty':        () => markDirty(),
    'calc-macros':       () => { calcMacros(); markDirty(); },
    'pr-stamp':          (el) => { prStamp(el.dataset.prKey, el.value); markDirty(); },
    'ob-floor-label':    (el) => { obFloors[+el.dataset.floorIdx].label = el.value; },
    'ob-floor-target':   (el) => { obFloors[+el.dataset.floorIdx].targetValue = +el.value; },
    'ob-floor-unit':     (el) => { obFloors[+el.dataset.floorIdx].unit = el.value; },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const fn = clickHandlers[el.dataset.action];
    if (fn) fn(el, ev);
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-input-action]');
    if (!el) return;
    const fn = inputHandlers[el.dataset.inputAction];
    if (fn) fn(el, ev);
  });

  document.addEventListener('mouseover', (ev) => {
    const el = ev.target.closest('[data-hover-opacity]');
    if (!el) return;
    el.style.opacity = el.dataset.hoverOpacity;
  });
  document.addEventListener('mouseout', (ev) => {
    const el = ev.target.closest('[data-hover-opacity]');
    if (!el) return;
    el.style.opacity = '1';
  });
})();

