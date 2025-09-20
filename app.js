/* ===== App state / mode switch ===== */
let appMode = 'planning'; // planning | survey

const modePicker  = document.getElementById('modePicker');
const appPlanning = document.getElementById('appPlanning');
const appSurvey   = document.getElementById('appSurvey');
const pillPlanning= document.getElementById('pillPlanning');
const pillSurvey  = document.getElementById('pillSurvey');
const pickPlanning= document.getElementById('pickPlanning');
const pickSurvey  = document.getElementById('pickSurvey');

function setModeApp(mode){
  appMode = mode;
  if(mode==='planning'){
    appPlanning.style.display='grid';
    appSurvey.style.display='none';
    pillPlanning.classList.add('active');
    pillSurvey.classList.remove('active');
  }else{
    appPlanning.style.display='none';
    appSurvey.style.display='grid';
    pillPlanning.classList.remove('active');
    pillSurvey.classList.add('active');
  }
  modePicker.style.display='none';
}
pillPlanning.onclick = ()=> setModeApp('planning');
pillSurvey.onclick   = ()=> setModeApp('survey');
pickPlanning.onclick = ()=> setModeApp('planning');
pickSurvey.onclick   = ()=> setModeApp('survey');

/* ===== Constants (colors / thresholds) ===== */
const RSSI_MIN = -80, RSSI_MAX = -50;
const P_GRAY   = -67, P_YELLOW = -60, P_GREEN=-30; // mapping สี
const GRAY_BASE=[128,128,128], GRAY_LIGHT=[220,220,220];
const N_BY_BAND = {'2.4':2.2,'5':2.4}; // Ekahau-like: fixed per band
const CONTOUR_LEVELS = [-20,-25,-30,-35,-40,-45,-50,-55,-60,-65,-70,-75,-80];

/* ===== Helpers ===== */
const $=s=>document.querySelector(s);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const clamp01=v=>Math.max(0,Math.min(1,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a,b,t)=>a+(b-a)*t;
const mix=(c1,c2,t)=>[Math.round(lerp(c1[0],c2[0],t)),Math.round(lerp(c1[1],c2[1],t)),Math.round(lerp(c1[2],c2[2],t))];
const rgbStr=([r,g,b])=>`rgb(${r},${g},${b})`;

/* ===== Materials ===== */
const MATERIALS={
  drywall:{name:'ผนังยิปซัม (Drywall)',color:'#98c1ff',att:3},
  glass:{name:'กระจก',color:'#7de1ff',att:4},
  wood:{name:'ไม้',color:'#9ae27b',att:5},
  brick:{name:'อิฐ/คอนกรีตมวลเบา',color:'#ffb673',att:8},
  concrete:{name:'คอนกรีตเสริมเหล็ก',color:'#ff8f8f',att:12},
  metal:{name:'โลหะแผ่น/ประตูเหล็ก',color:'#ffd36a',att:20},
  human:{name:'ร่างกายคน (เฉลี่ย)',color:'#d6b3ff',att:3}
};
(function fillMaterialSelect(){
  const sel=$('#matType');
  Object.keys(MATERIALS).forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=MATERIALS[k].name; sel.appendChild(o); });
  sel.value='brick'; $('#matAtt').value=MATERIALS['brick'].att;
  sel.addEventListener('change',()=>$('#matAtt').value=MATERIALS[sel.value].att);
})();

/* ===== Canvas & drawing state ===== */
const canvas=$('#canvas'), ctx=canvas.getContext('2d',{willReadFrequently:true});
const overlay=$('#overlay'), octx=overlay.getContext('2d',{willReadFrequently:true});
let floorImg=null;
let aps=[];         // [{x,y,label,p0,band,preset?}]
let segments=[];    // [{a:{x,y}, b:{x,y}, type, att}]
let mode='idle';    // idle | scale | ap | mat
let dragging=false, dragStart=null;
let scale={ pxPerMeter:null }; // simple version (ไม่ normalize)
let hasRendered=false;

const UI={
  modeBadge:$('#modeBadge'), scaleLabel:$('#scaleLabel'),
  apList:$('#apList'), matList:$('#matList'),
  legendMin:$('#legendMin'), legendMax:$('#legendMax'),
  probe:$('#probe'), probeVal:$('#probeVal'), probeMeta:$('#probeMeta'), probeSw:$('#sw'),
  stage:$('#stage'),
};

/* ===== Size sync ===== */
function applyCanvasCSSSize(){
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  overlay.style.width = canvas.width + 'px';
  overlay.style.height = canvas.height + 'px';
  overlay.style.left = '0px';
  overlay.style.top  = '0px';
}
function fitCanvasToImage(img){
  const maxW=1920,maxH=1080;
  const k=Math.min(maxW/img.width, maxH/img.height, 1);
  const w=Math.round(img.width*k), h=Math.round(img.height*k);
  canvas.width=w; canvas.height=h;
  overlay.width=w; overlay.height=h;
  applyCanvasCSSSize();
}
window.addEventListener('resize', applyCanvasCSSSize);

/* ===== Base / Permanent drawing ===== */
function drawBase(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(floorImg){ ctx.drawImage(floorImg,0,0,canvas.width,canvas.height); }
  else{
    ctx.fillStyle='#0c1022'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='#1c264a'; ctx.lineWidth=1;
    for(let x=0;x<canvas.width;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke()}
    for(let y=0;y<canvas.height;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke()}
  }
  hideProbe();
}
function drawPermanent(){
  // materials
  ctx.lineWidth=3;
  segments.forEach(s=>{
    const m=MATERIALS[s.type]||{color:'#fff',name:s.type};
    ctx.strokeStyle=m.color; ctx.beginPath(); ctx.moveTo(s.a.x,s.a.y); ctx.lineTo(s.b.x,s.b.y); ctx.stroke();
    const mx=(s.a.x+s.b.x)/2, my=(s.a.y+s.b.y)/2;
    ctx.fillStyle='#e8ecf1'; ctx.font='11px ui-monospace,monospace';
    ctx.fillText(`${m.name} · ${s.att} dB`, mx+6, my-6);
  });
  // APs
  aps.forEach(a=>{
    ctx.fillStyle='#8fd3ff';
    ctx.beginPath(); ctx.arc(a.x,a.y,7,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#2a7fff'; ctx.lineWidth=2; ctx.stroke();
    ctx.fillStyle='#cfe6ff'; ctx.font='12px ui-monospace,monospace';
    ctx.fillText(`${a.label||'AP'} · P0:${a.p0}dBm ${a.band||'5'}GHz`, a.x+10, a.y-8);
  });
}

/* ===== Overlay helpers ===== */
function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }
function drawArrow(a,b,opts={}){
  const {color='#6ae3ff',width=3.5,head=12,dash=[10,6],label=''}=opts;
  octx.save();
  octx.lineWidth=width; octx.setLineDash(dash); octx.strokeStyle=color;
  octx.beginPath(); octx.moveTo(a.x,a.y); octx.lineTo(b.x,b.y); octx.stroke();
  octx.setLineDash([]);
  const ang=Math.atan2(b.y-a.y,b.x-a.x);
  octx.beginPath();
  octx.moveTo(b.x,b.y);
  octx.lineTo(b.x-head*Math.cos(ang - Math.PI/7), b.y-head*Math.sin(ang - Math.PI/7));
  octx.lineTo(b.x-head*Math.cos(ang + Math.PI/7), b.y-head*Math.sin(ang + Math.PI/7));
  octx.closePath(); octx.fillStyle=color; octx.fill();
  octx.fillStyle='#fff'; octx.strokeStyle='#000'; octx.lineWidth=2;
  [a,b].forEach(p=>{ octx.beginPath(); octx.arc(p.x,p.y,4,0,Math.PI*2); octx.fill(); octx.stroke(); });
  if(label){ octx.font='12px ui-monospace,monospace'; octx.fillStyle='#cfe6ff'; octx.fillText(label, b.x+10, b.y-8); }
  octx.restore();
}

/* ===== Legend & color mapping ===== */
function makeFixedLegend(){
  const g=$('#grad'); const cvs=document.createElement('canvas'); cvs.width=256; cvs.height=1;
  const c=cvs.getContext('2d');
  const span1=P_GRAY-RSSI_MIN, span2=P_YELLOW-P_GRAY, span3=P_GREEN-P_YELLOW, usable=240;
  const s=usable/(span1+span2+span3);
  const px1=Math.round(span1*s), px2=Math.round(span2*s), px3=Math.round(span3*s), pxG=256-(px1+px2+px3);
  let x=0;
  for(let i=0;i<px1;i++,x++){ const t=i/(px1||1), col=mix(GRAY_LIGHT,GRAY_BASE,t); c.fillStyle=rgbStr(col); c.fillRect(x,0,1,1); }
  for(let i=0;i<px2;i++,x++){ const t=i/(px2||1), col=mix(GRAY_BASE,[255,255,0],t); c.fillStyle=rgbStr(col); c.fillRect(x,0,1,1); }
  for(let i=0;i<px3;i++,x++){ const t=i/(px3||1), col=mix([255,255,0],[0,255,0],t); c.fillStyle=rgbStr(col); c.fillRect(x,0,1,1); }
  c.fillStyle='rgb(0,255,0)'; c.fillRect(x,0,pxG,1);
  g.style.backgroundImage=`url(${cvs.toDataURL()})`;
}
function colorFromRSSI(v){
  if(v<=P_GRAY){ const t=clamp((P_GRAY-v)/(P_GRAY-RSSI_MIN),0,1); return mix(GRAY_BASE,GRAY_LIGHT,t); }
  if(v<=P_YELLOW){ const t=(v-P_GRAY)/(P_YELLOW-P_GRAY); return mix(GRAY_BASE,[255,255,0],t); }
  if(v<=P_GREEN){ const t=(v-P_YELLOW)/(P_GREEN-P_YELLOW); return mix([255,255,0],[0,255,0],t); }
  return [0,255,0];
}

/* ===== Geometry & intersections ===== */
function orient(a,b,c){ return (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x); }
function onSeg(a,b,c){ return Math.min(a.x,b.x)-1e-6<=c.x && c.x<=Math.max(a.x,b.x)+1e-6 && Math.min(a.y,b.y)-1e-6<=c.y && c.y<=Math.max(a.y,b.y)+1e-6; }
function segIntersect(p1,p2,q1,q2){
  const o1=orient(p1,p2,q1),o2=orient(p1,p2,q2),o3=orient(q1,q2,p1),o4=orient(q1,q2,p2);
  if((o1*o2<0)&&(o3*o4<0)) return true;
  if(Math.abs(o1)<1e-8 && onSeg(p1,p2,q1)) return true;
  if(Math.abs(o2)<1e-8 && onSeg(p1,p2,q2)) return true;
  if(Math.abs(o3)<1e-8 && onSeg(q1,q2,p1)) return true;
  if(Math.abs(o4)<1e-8 && onSeg(q1,q2,p2)) return true;
  return false;
}
function pathObstacleLoss(pFrom,pTo){
  let loss=0; for(const s of segments){ if(segIntersect(pFrom,pTo,s.a,s.b)) loss+=(+s.att||0); } return loss;
}

/* ===== RSSI Model (sum power) ===== */
function rssiFromAPs(x,y){
  if(!aps.length) return RSSI_MIN;
  if(!scale.pxPerMeter) return RSSI_MIN;
  const P={x,y}; let sum_mW=0;
  for(const a of aps){
    const d_px=Math.hypot(x-a.x,y-a.y);
    const d_m=Math.max(1e-3,d_px/scale.pxPerMeter);
    const lossObs=pathObstacleLoss(P,a);
    const n = N_BY_BAND[a.band||'5'] ?? 2.3; // fixed per band
    const rssi=a.p0 - 10*n*Math.log10(d_m) - lossObs;
    sum_mW += Math.pow(10, rssi/10);
  }
  return 10*Math.log10(Math.max(1e-15,sum_mW));
}

/* ===== Heatmap render + Contours ===== */
function drawContours(field,w,h,levels,step=2){
  ctx.save(); ctx.strokeStyle='#fff'; ctx.lineWidth=1.3;
  const nx=Math.floor((w-1)/step), ny=Math.floor((h-1)/step);
  for(const L of levels){
    for(let gy=0;gy<ny;gy++){
      const y0=gy*step,y1=y0+step;
      for(let gx=0;gx<nx;gx++){
        const x0=gx*step,x1=x0+step;
        const i00=y0*w+x0,i10=y0*w+x1,i11=y1*w+x1,i01=y1*w+x0;
        const v00=field[i00],v10=field[i10],v11=field[i11],v01=field[i01];
        const b0=v00>=L?1:0,b1=v10>=L?1:0,b2=v11>=L?1:0,b3=v01>=L?1:0;
        const code=(b0)|(b1<<1)|(b2<<2)|(b3<<3); if(code===0||code===15) continue;
        const interp=(xa,ya,xb,yb,va,vb)=>{const t=(L-va)/((vb-va)||1e-9);return [xa+(xb-xa)*t,ya+(yb-ya)*t];};
        const T=interp(x0,y0,x1,y0,v00,v10), R=interp(x1,y0,x1,y1,v10,v11),
              B=interp(x0,y1,x1,y1,v01,v11), Lp=interp(x0,y0,x0,y1,v00,v01);
        const seg=(p,q)=>{ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(q[0],q[1]);ctx.stroke();};
        switch(code){
          case 1: case 14: seg(Lp,T); break;
          case 2: case 13: seg(T,R); break;
          case 3: case 12: seg(Lp,R); break;
          case 4: case 11: seg(R,B); break;
          case 5:           seg(Lp,T); seg(R,B); break;
          case 6: case 9 : seg(T,B); break;
          case 7: case 8 : seg(Lp,B); break;
          case 10:          seg(T,R); seg(Lp,B); break;
        }
      }
    }
  }
  ctx.restore();
}

function renderHeatmap(){
  if(aps.length===0){ alert('ยังไม่มี AP — วาง AP ก่อน'); return; }
  const alpha=clamp(parseFloat($('#alpha').value||'0.6'),0,1);
  const blurPx=Math.max(0,parseInt($('#blurPx').value||'16',10));
  UI.legendMin.textContent=RSSI_MIN; UI.legendMax.textContent=RSSI_MAX; makeFixedLegend();
  drawBase();
  const heat=document.createElement('canvas'); heat.width=canvas.width; heat.height=canvas.height;
  const hctx=heat.getContext('2d',{willReadFrequently:true});
  let img=hctx.createImageData(heat.width,heat.height), arr=img.data;
  const field=new Float32Array(heat.width*heat.height);
  for(let y=0;y<heat.height;y++){
    for(let x=0;x<heat.width;x++){
      const rssi=rssiFromAPs(x,y); const [r,g,b]=colorFromRSSI(rssi);
      field[y*heat.width+x]=rssi;
      const i=(y*heat.width+x)*4; arr[i]=r; arr[i+1]=g; arr[i+2]=b; arr[i+3]=255;
    }
  }
  hctx.putImageData(img,0,0);
  ctx.save(); ctx.globalAlpha=alpha; if(blurPx>0) ctx.filter=`blur(${blurPx}px)`;
  ctx.drawImage(heat,0,0); ctx.filter='none'; ctx.restore();
  drawPermanent(); // ผนัง/AP
  drawContours(field,heat.width,heat.height,CONTOUR_LEVELS,2); // เส้นขาวทับผนังให้เห็นชัด
  hasRendered=true;
}

/* ===== Probe ===== */
function showProbeAt(x,y){
  ctx.save(); ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.globalAlpha=.9; ctx.fill();
  ctx.lineWidth=2; ctx.strokeStyle='#000'; ctx.globalAlpha=1; ctx.stroke(); ctx.restore();
  const rssi=rssiFromAPs(x,y), col=colorFromRSSI(rssi);
  UI.probeVal.textContent=`${rssi.toFixed(1)} dBm`; UI.probeMeta.textContent=`x=${x|0}, y=${y|0}`; UI.probeSw.style.background=rgbStr(col);
  const stageRect=UI.stage.getBoundingClientRect(); const cRect=canvas.getBoundingClientRect();
  const px=(x/canvas.width)*cRect.width + (cRect.left-stageRect.left);
  const py=(y/canvas.height)*cRect.height + (cRect.top-stageRect.top);
  UI.probe.style.left=`${px}px`; UI.probe.style.top=`${py}px`; UI.probe.style.display='block';
}
function hideProbe(){ UI.probe.style.display='none'; }

/* ===== Lists ===== */
function escapeHtml(s){ return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function refreshAPList(){
  UI.apList.innerHTML='';
  aps.forEach((a,i)=>{
    const row=document.createElement('div'); row.className='apRow small';
    row.innerHTML=`<div><strong>${escapeHtml(a.label||'AP')}</strong> · P0:${a.p0} dBm · ${a.band||'5'}GHz
      <div class="muted">(${a.x|0},${a.y|0}) ${a.preset?`· preset: ${escapeHtml(a.preset.presetName)}`:''}</div></div>
      <div class="row"><button data-i="${i}" class="danger" style="padding:4px 8px">ลบ</button></div>`;
    row.querySelector('button').onclick=e=>{ aps.splice(+e.target.getAttribute('data-i'),1);
      drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshAPList(); };
    UI.apList.appendChild(row);
  });
}
function refreshMatList(){
  UI.matList.innerHTML='';
  segments.forEach((s,i)=>{
    const m=MATERIALS[s.type]||{name:s.type,color:'#fff'};
    const row=document.createElement('div'); row.className='matRow small';
    row.innerHTML=`<div style="display:flex;align-items:center;gap:8px">
        <span class="dot" style="background:${m.color}"></span>
        <div><div><strong>${m.name}</strong> · ${s.att} dB</div>
        <div class="muted">A(${s.a.x|0},${s.a.y|0}) → B(${s.b.x|0},${s.b.y|0})</div></div>
      </div>
      <div class="row"><button data-i="${i}" class="danger" style="padding:4px 8px">ลบ</button></div>`;
    row.querySelector('button').onclick=e=>{ segments.splice(+e.target.getAttribute('data-i'),1);
      drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshMatList(); };
    UI.matList.appendChild(row);
  });
}

/* ===== Toolbar handlers ===== */
$('#btnScale').onclick=()=>{ mode='scale'; $('#modeBadge').textContent='โหมด: ตั้งสเกล'; hideProbe(); };
$('#btnIdle').onclick =()=>{ mode='idle';  $('#modeBadge').textContent='โหมด: Idle'; hideProbe(); };
$('#btnAP').onclick   =()=>{ mode='ap';    $('#modeBadge').textContent='โหมด: วาง AP (คลิก)'; hideProbe(); };
$('#btnMat').onclick  =()=>{ mode='mat';   $('#modeBadge').textContent='โหมด: วัสดุ (ลากเส้น)'; hideProbe(); };

$('#btnAPUndo').onclick =()=>{ aps.pop(); drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshAPList(); };
$('#btnAPClear').onclick=()=>{ if(confirm('ล้าง AP ทั้งหมด?')){ aps=[]; drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshAPList(); } };

$('#btnMatUndo').onclick =()=>{ segments.pop(); drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshMatList(); };
$('#btnMatClear').onclick=()=>{ if(confirm('ล้างวัสดุทั้งหมด?')){ segments=[]; drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshMatList(); } };

$('#btnRender').onclick =()=>{ renderHeatmap(); hideProbe(); };
$('#btnExport').onclick =()=>{ const a=document.createElement('a'); a.download='heatmap.png'; a.href=canvas.toDataURL('image/png'); a.click(); };

/* ===== Save / Load project ===== */
$('#btnSave').onclick=()=>{
  const payload={ aps, segments, alpha:+($('#alpha').value||0.6), blurPx:+($('#blurPx').value||16), scale:scale.pxPerMeter };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='heatmap_project_planning.json'; a.click();
  URL.revokeObjectURL(a.href);
};
$('#loadJson').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      const obj=JSON.parse(reader.result);
      aps=obj.aps||[]; segments=obj.segments||[];
      $('#alpha').value=obj.alpha??0.6; $('#blurPx').value=obj.blurPx??16;
      scale.pxPerMeter=obj.scale||null;
      $('#scaleLabel').textContent=scale.pxPerMeter?`${(scale.pxPerMeter).toFixed(1)} px/เมตร`:'ยังไม่ตั้ง';
      drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent();
      refreshAPList(); refreshMatList();
    }catch(err){ alert('Invalid project JSON'); }
  };
  reader.readAsText(f);
});

/* ===== Image handlers ===== */
$('#fileInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const img=new Image();
  img.onload=()=>{ floorImg=img; fitCanvasToImage(img); drawBase(); drawPermanent(); };
  img.src=URL.createObjectURL(f);
});
$('#btnClear').onclick=()=>{ floorImg=null; drawBase(); drawPermanent(); };

/* ===== Mouse interactions (drag, click) ===== */
function getCanvasPos(e){
  const rect=canvas.getBoundingClientRect();
  const scaleX=canvas.width/rect.width, scaleY=canvas.height/rect.height;
  return { x:(e.clientX-rect.left)*scaleX, y:(e.clientY-rect.top)*scaleY, rect };
}
function startDrag(x,y){ dragging=true; dragStart={x,y}; clearOverlay(); }
function updateDrag(x,y){
  if(!dragging||!dragStart) return;
  clearOverlay();
  const label=(mode==='scale')
    ? `${dist(dragStart,{x,y}).toFixed(1)} px`
    : `${MATERIALS[$('#matType').value]?.name||'วัสดุ'} · ${($('#matAtt').value||'0')} dB`;
  const color=(mode==='scale')?'#6ae3ff':'#ffd36a';
  drawArrow(dragStart,{x,y},{color, width:3.5, head:12, dash:[10,6], label});
}
function endDrag(x,y){
  if(!dragging||!dragStart) return;
  clearOverlay();
  const a={...dragStart}, b={x,y};
  if(mode==='scale'){
    const Lpx=dist(a,b);
    const real=prompt(`ความยาวจริง (เมตร) ของไม้บรรทัด ${Lpx.toFixed(1)} px = ?`, '5');
    if(real && +real>0){
      scale.pxPerMeter=Lpx/(+real);
      $('#scaleLabel').textContent=`${scale.pxPerMeter.toFixed(1)} px/เมตร`;
    }
    mode='idle'; $('#modeBadge').textContent='โหมด: Idle';
    drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent();
  }else if(mode==='mat'){
    const type=$('#matType').value;
    const att=parseFloat($('#matAtt').value || (MATERIALS[type]?.att||8));
    segments.push({a,b,type,att});
    mode='idle'; $('#modeBadge').textContent='โหมด: Idle';
    drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshMatList();
  }
  dragging=false; dragStart=null;
}

/* bind drag */
canvas.addEventListener('mousedown', e=>{
  if(appMode!=='planning') return;
  const {x,y}=getCanvasPos(e);
  if(mode==='scale' || mode==='mat') startDrag(x,y);
});
canvas.addEventListener('mousemove', e=>{
  if(appMode!=='planning') return;
  const {x,y}=getCanvasPos(e);
  if(mode==='scale' || mode==='mat') updateDrag(x,y);
});
canvas.addEventListener('mouseup', e=>{
  if(appMode!=='planning') return;
  const {x,y}=getCanvasPos(e);
  if(mode==='scale' || mode==='mat') endDrag(x,y);
});
canvas.addEventListener('mouseleave', ()=>{ if(appMode!=='planning') return; dragging=false; dragStart=null; clearOverlay(); });

/* click for AP / probe */
canvas.addEventListener('click', e=>{
  if(appMode!=='planning') return;
  const {x,y}=getCanvasPos(e);
  if(mode==='ap'){
    if(!scale.pxPerMeter){
      // ตั้งชั่วคราวเพื่อใช้งานได้—คุณควรตั้งสเกลจริงภายหลัง
      scale.pxPerMeter=100; $('#scaleLabel').textContent='100 px/เมตร (อัตโนมัติ)';
    }
    const label=$('#apLabel').value.trim()||`AP-${aps.length+1}`;
    const p0=parseFloat($('#apP0').value||'-40');
    const band=$('#apBand').value||'5';
    const preset = window.__currentApPreset ? { presetName: window.__currentApPreset.name } : undefined;

    aps.push({x,y,label,p0,band,preset});
    drawBase(); if(hasRendered) renderHeatmap(); else drawPermanent(); refreshAPList();
  }else if(mode==='idle'){
    if(!hasRendered) return;
    renderHeatmap(); showProbeAt(x,y);
  }
});

/* keyboard (Planning) */
document.addEventListener('keydown', e=>{
  if(appMode!=='planning') return;
  if(e.key==='s'||e.key==='S'){ mode='scale'; $('#modeBadge').textContent='โหมด: ตั้งสเกล'; hideProbe(); }
  if(e.key==='a'||e.key==='A'){ mode='ap';    $('#modeBadge').textContent='โหมด: วาง AP (คลิก)'; hideProbe(); }
  if(e.key==='w'||e.key==='W'){ mode='mat';   $('#modeBadge').textContent='โหมด: วัสดุ (ลากเส้น)'; hideProbe(); }
  if(e.key==='h'||e.key==='H'){ renderHeatmap(); hideProbe(); }
  if(e.key==='Escape'){         mode='idle';  $('#modeBadge').textContent='โหมด: Idle'; hideProbe(); }
});

/* ===== AP Presets (load from JSON) ===== */
let AP_PRESETS = {};
async function loadApPresets(){
  const sel = document.getElementById('apPreset');
  sel.innerHTML = '<option value="">(กำลังโหลดพรีเซ็ต...)</option>';
  try{
    const res = await fetch('./ap_presets.json', { cache: 'no-store' });
    if(!res.ok) throw new Error(res.status+' '+res.statusText);
    AP_PRESETS = await res.json();
    sel.innerHTML = '<option value="">-- เลือกรุ่น --</option>';
    Object.keys(AP_PRESETS).forEach(name=>{
      const o=document.createElement('option'); o.value=name; o.textContent=name; sel.appendChild(o);
    });
  }catch(err){
    sel.innerHTML = '<option value="">(โหลดพรีเซ็ตไม่ได้)</option>';
    console.error('โหลดพรีเซ็ตผิดพลาด', err);
  }
}
document.getElementById('btnUsePreset').onclick=()=>{
  const name = (document.getElementById('apPreset').value||'').trim();
  if(!name || !AP_PRESETS[name]) return;
  const ap = AP_PRESETS[name];

  // ตั้งชื่อให้เลย
  $('#apLabel').value = name;

  // เลือกย่าน ถ้ารองรับ 5GHz ใช้ 5 ก่อน
  const bandSel=$('#apBand');
  const band = ap.bands?.includes('5') ? '5' : (ap.bands?.[0] || '2.4');
  bandSel.value = band;

  // ตั้งค่า P0 ถ้ามีให้ในพรีเซ็ต
  const p0Input=$('#apP0');
  if(ap.p0 && ap.p0[band]!=null) p0Input.value = ap.p0[band];

  // เก็บชื่อพรีเซ็ตไว้กับ AP ที่จะถูกวาง (field: presetName)
  window.__currentApPreset = { name };
};

/* ===== init ===== */
(function init(){
  applyCanvasCSSSize();
  setModeApp('planning');
  makeFixedLegend();
  drawBase(); drawPermanent();
  loadApPresets(); // โหลดไฟล์พรีเซ็ต AP
})();
