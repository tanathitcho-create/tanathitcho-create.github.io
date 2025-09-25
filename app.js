/* ===== Mode switch (Planning/Survey) ===== */
let appMode = 'planning';
const appPlanning = document.getElementById('appPlanning');
const appSurvey   = document.getElementById('appSurvey');
const pillPlanning= document.getElementById('pillPlanning');
const pillSurvey  = document.getElementById('pillSurvey');

function setModeApp(mode){
  appMode = mode;
  if(mode==='planning'){
    appPlanning.style.display='grid'; appSurvey.style.display='none';
    pillPlanning.classList.add('active'); pillSurvey.classList.remove('active');
  }else{
    appPlanning.style.display='none'; appSurvey.style.display='grid';
    pillPlanning.classList.remove('active'); pillSurvey.classList.add('active');
  }
}
pillPlanning.onclick=()=>setModeApp('planning');
pillSurvey.onclick  =()=>setModeApp('survey');

/* ===== Constants ===== */
const RSSI_MIN=-80, RSSI_MAX=-50;
const P_GRAY=-67, P_YELLOW=-60, P_GREEN=-30;
const GRAY_BASE=[128,128,128], GRAY_LIGHT=[220,220,220];

/* “ของจริง” — ให้ 5 GHz ตกไวกว่า 2.4 GHz */
const N_BY_BAND={'2.4':2.2,'5':2.5};

/* เส้นคอนทัวร์ทุก -5 dBm */
const CONTOUR_LEVELS=[-20,-25,-30,-35,-40,-45,-50,-55,-60,-65,-70,-75,-80];

/* ===== Helpers ===== */
const $=s=>document.querySelector(s);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const lerp=(a,b,t)=>a+(b-a)*t;
const mix=(c1,c2,t)=>[Math.round(lerp(c1[0],c2[0],t)),Math.round(lerp(c1[1],c2[1],t)),Math.round(lerp(c1[2],c2[2],t))];
const rgbStr=([r,g,b])=>`rgb(${r},${g},${b})`;

/* ===== Materials (per-band attenuation) =====
   ตัวเลขนี้เป็นแนวทางใช้หน้างาน: 5 GHz แพ้วัสดุมากกว่า
   คุณยัง “ใส่ค่า 2.4 GHz” เองได้จากช่อง input; ระบบจะคำนวณ 5 GHz ตามอัตราส่วน default ของชนิดนั้น */
const MATERIALS={
  drywall:{name:'ผนังยิปซัม (Drywall)',color:'#98c1ff',att:{'2.4':3, '5':4}},
  glass:{name:'กระจก',color:'#7de1ff',att:{'2.4':4, '5':6}},
  wood:{name:'ไม้',color:'#9ae27b',att:{'2.4':5, '5':7}},
  brick:{name:'อิฐ/คอนกรีตมวลเบา',color:'#ffb673',att:{'2.4':8, '5':10}},
  concrete:{name:'คอนกรีตเสริมเหล็ก',color:'#ff8f8f',att:{'2.4':12,'5':15}},
  metal:{name:'โลหะแผ่น/ประตูเหล็ก',color:'#ffd36a',att:{'2.4':20,'5':24}},
  human:{name:'ร่างกายคน (เฉลี่ย)',color:'#d6b3ff',att:{'2.4':3, '5':4}}
};

(function fillMat(){
  const sel=$('#matType');
  Object.keys(MATERIALS).forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=MATERIALS[k].name; sel.appendChild(o); });
  sel.value='brick'; $('#matAtt').value=MATERIALS['brick'].att['2.4'];
  sel.addEventListener('change',()=>$('#matAtt').value=MATERIALS[sel.value].att['2.4']);
})();

/* ===== Canvas, world/viewport transform (ซูม/แพน) ===== */
const canvas=$('#canvas'), ctx=canvas.getContext('2d',{willReadFrequently:true});
const overlay=$('#overlay'), octx=overlay.getContext('2d',{willReadFrequently:true});
const stage=$('#stage');
let floorImg=null;
let worldW=1280, worldH=800;
let view={ scale:1, tx:0, ty:0, min:0.2, max:6 };

function setView(scale, tx, ty){ view.scale=clamp(scale,view.min,view.max); view.tx=tx; view.ty=ty; drawAll(); }
function resetView(){
  const pad=20, sx=(canvas.width-2*pad)/worldW, sy=(canvas.height-2*pad)/worldH, s=Math.min(sx,sy);
  setView(s, pad, pad);
}
function worldToScreen(p){ return { x:p.x*view.scale+view.tx, y:p.y*view.scale+view.ty }; }
function screenToWorld(p){ return { x:(p.x-view.tx)/view.scale, y:(p.y-view.ty)/view.scale }; }
function getCanvasPos(e){ const r=canvas.getBoundingClientRect(); const sx=e.clientX-r.left, sy=e.clientY-r.top; return { screen:{x:sx,y:sy}, world:screenToWorld({x:sx,y:sy}), rect:r }; }

/* ===== State ===== */
let aps=[];       // {x,y,label,p0,band,preset?}
let segments=[];  // {a:{x,y}, b:{x,y}, type, att24, att5}
let mode='idle'; let dragging=false; let dragStart=null;
let spacePan=false; let panAnchor=null;
let scalePxPerMeter=null;
let hasRendered=false;

/* Heat buffers */
let heatCanvas=null, heatField=null;

/* ===== UI refs ===== */
const UI={
  modeBadge:$('#modeBadge'), scaleLabel:$('#scaleLabel'),
  apList:$('#apList'), matList:$('#matList'),
  legendMin:$('#legendMin'), legendMax:$('#legendMax'),
  probe:$('#probe'), probeVal:$('#probeVal'), probeMeta:$('#probeMeta'), probeSw:$('#sw'),
};

/* ===== Base drawing ===== */
function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }
function drawBase(){
  ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvas.width,canvas.height); ctx.restore();
  ctx.save(); ctx.setTransform(view.scale,0,0,view.scale,view.tx,view.ty);
  if(!floorImg){
    ctx.fillStyle='#0c1022'; ctx.fillRect(0,0,worldW,worldH);
    ctx.strokeStyle='#1c264a'; ctx.lineWidth=1/view.scale;
    for(let x=0;x<worldW;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,worldH);ctx.stroke()}
    for(let y=0;y<worldH;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(worldW,y);ctx.stroke()}
  }else ctx.drawImage(floorImg,0,0,worldW,worldH);
  ctx.restore();
  hideProbe();
}

function drawPermanent(){
  ctx.save(); ctx.setTransform(view.scale,0,0,view.scale,view.tx,view.ty);
  // materials
  segments.forEach(s=>{
    const m=MATERIALS[s.type]||{color:'#fff',name:s.type};
    ctx.lineWidth=3/view.scale; ctx.strokeStyle=m.color;
    ctx.beginPath(); ctx.moveTo(s.a.x,s.a.y); ctx.lineTo(s.b.x,s.b.y); ctx.stroke();

    const mx=(s.a.x+s.b.x)/2, my=(s.a.y+s.b.y)/2, sp=worldToScreen({x:mx,y:my});
    ctx.save(); ctx.scale(1/view.scale,1/view.scale);
    ctx.fillStyle='#e8ecf1'; ctx.font='11px ui-monospace,monospace';
    const label=`${m.name} · 2.4:${s.att24} dB · 5:${s.att5} dB`;
    ctx.fillText(label, sp.x+6, sp.y-6);
    ctx.restore();
  });
  // APs
  aps.forEach(a=>{
    ctx.fillStyle='#8fd3ff';
    ctx.beginPath(); ctx.arc(a.x,a.y,7/view.scale,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#2a7fff'; ctx.lineWidth=2/view.scale; ctx.stroke();

    const sp=worldToScreen(a);
    ctx.save(); ctx.scale(1/view.scale,1/view.scale);
    ctx.fillStyle='#cfe6ff'; ctx.font='12px ui-monospace,monospace';
    ctx.fillText(`${a.label||'AP'} · P0:${a.p0}dBm ${a.band||'5'}GHz`, sp.x+10, sp.y-8);
    ctx.restore();
  });
  ctx.restore();
}

/* ===== Legend & color ===== */
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

/* ===== Intersections ===== */
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

/* ===== Obstacle loss (ใช้ตามย่าน) ===== */
function pathObstacleLoss(pFrom,pTo,band){
  let loss=0;
  for(const s of segments){
    if(segIntersect(pFrom,pTo,s.a,s.b)){
      if(band==='2.4') loss += (s.att24 ?? s.att ?? 0);
      else             loss += (s.att5  ?? s.att ?? 0);
    }
  }
  return loss;
}

/* ===== RSSI ===== */
function rssiFromAPs(x,y){
  if(!aps.length || !scalePxPerMeter) return RSSI_MIN;
  const P={x,y}; let sum_mW=0;
  for(const a of aps){
    const d_px=Math.hypot(x-a.x,y-a.y);
    const d_m=Math.max(1e-3, d_px/scalePxPerMeter);
    const n=N_BY_BAND[a.band||'5'] ?? 2.3;
    const lossObs=pathObstacleLoss(P,a,a.band||'5');
    const rssi=a.p0 - 10*n*Math.log10(d_m) - lossObs;
    sum_mW += Math.pow(10, rssi/10);
  }
  return 10*Math.log10(Math.max(1e-15,sum_mW));
}

/* ===== Heatmap & Contours ===== */
let buildingHeat=false;
function buildHeat(){
  if(buildingHeat) return;
  buildingHeat=true;
  heatCanvas=document.createElement('canvas'); heatCanvas.width=worldW; heatCanvas.height=worldH;
  const hctx=heatCanvas.getContext('2d',{willReadFrequently:true});
  const img=hctx.createImageData(worldW,worldH), arr=img.data;
  heatField=new Float32Array(worldW*worldH);
  for(let y=0;y<worldH;y++){
    for(let x=0;x<worldW;x++){
      const rssi=rssiFromAPs(x,y); const [r,g,b]=colorFromRSSI(rssi);
      heatField[y*worldW+x]=rssi;
      const i=(y*worldW+x)*4; arr[i]=r; arr[i+1]=g; arr[i+2]=b; arr[i+3]=255;
    }
  }
  hctx.putImageData(img,0,0);
  buildingHeat=false;
}
function drawContours(levels, step=2){
  if(!heatField) return;
  ctx.save(); ctx.setTransform(view.scale,0,0,view.scale,view.tx,view.ty);
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.3/view.scale;
  const w=worldW, h=worldH, nx=Math.floor((w-1)/step), ny=Math.floor((h-1)/step);
  for(const L of levels){
    for(let gy=0;gy<ny;gy++){
      const y0=gy*step,y1=y0+step;
      for(let gx=0;gx<nx;gx++){
        const x0=gx*step,x1=x0+step;
        const i00=y0*w+x0,i10=y0*w+x1,i11=y1*w+x1,i01=y1*w+x0;
        const v00=heatField[i00],v10=heatField[i10],v11=heatField[i11],v01=heatField[i01];
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
  if(!aps.length){ alert('ยังไม่มี AP — วาง AP ก่อน'); return; }
  UI.legendMin.textContent=RSSI_MIN; UI.legendMax.textContent=RSSI_MAX; makeFixedLegend();
  buildHeat();
  const alpha=clamp(parseFloat($('#alpha').value||'0.6'),0,1);
  const blurPx=Math.max(0,parseInt($('#blurPx').value||'16',10));
  drawBase();
  if(heatCanvas){
    ctx.save(); ctx.setTransform(view.scale,0,0,view.scale,view.tx,view.ty);
    ctx.globalAlpha=alpha; if(blurPx>0) ctx.filter=`blur(${blurPx}px)`;
    ctx.drawImage(heatCanvas,0,0,worldW,worldH);
    ctx.filter='none'; ctx.globalAlpha=1; ctx.restore();
  }
  drawPermanent();
  drawContours(CONTOUR_LEVELS,2);
  hasRendered=true;
}

/* ===== Lists ===== */
function escapeHtml(s){ return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function refreshAPList(){
  UI.apList.innerHTML='';
  aps.forEach((a,i)=>{
    const row=document.createElement('div'); row.className='apRow small';
    row.innerHTML=`<div><strong>${escapeHtml(a.label||'AP')}</strong> · P0:${a.p0} dBm · ${a.band||'5'}GHz
      <div class="muted">(${a.x|0},${a.y|0}) ${a.preset?`· preset: ${escapeHtml(a.preset.presetName)}`:''}</div></div>
      <div class="row"><button data-i="${i}" class="danger" style="padding:4px 8px">ลบ</button></div>`;
    row.querySelector('button').onclick=e=>{ aps.splice(+e.target.getAttribute('data-i'),1); drawAll(); refreshAPList(); };
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
        <div><div><strong>${m.name}</strong> · 2.4:${s.att24} dB · 5:${s.att5} dB</div>
        <div class="muted">A(${s.a.x|0},${s.a.y|0}) → B(${s.b.x|0},${s.b.y|0})</div></div>
      </div>
      <div class="row"><button data-i="${i}" class="danger" style="padding:4px 8px">ลบ</button></div>`;
    row.querySelector('button').onclick=e=>{ segments.splice(+e.target.getAttribute('data-i'),1); drawAll(); refreshMatList(); };
    UI.matList.appendChild(row);
  });
}

/* ===== Toolbar ===== */
$('#btnScale').onclick=()=>{ mode='scale'; $('#modeBadge').textContent='โหมด: ตั้งสเกล'; hideProbe(); };
$('#btnIdle').onclick =()=>{ mode='idle';  $('#modeBadge').textContent='โหมด: Idle'; hideProbe(); };
$('#btnAP').onclick   =()=>{ mode='ap';    $('#modeBadge').textContent='โหมด: วาง AP (คลิก)'; hideProbe(); };
$('#btnMat').onclick  =()=>{ mode='mat';   $('#modeBadge').textContent='โหมด: วัสดุ (ลากเส้น)'; hideProbe(); };

$('#btnAPUndo').onclick =()=>{ aps.pop(); drawAll(); refreshAPList(); };
$('#btnAPClear').onclick=()=>{ if(confirm('ล้าง AP ทั้งหมด?')){ aps=[]; drawAll(); refreshAPList(); } };

$('#btnMatUndo').onclick =()=>{ segments.pop(); drawAll(); refreshMatList(); };
$('#btnMatClear').onclick=()=>{ if(confirm('ล้างวัสดุทั้งหมด?')){ segments=[]; drawAll(); refreshMatList(); } };

$('#btnRender').onclick =()=>{ renderHeatmap(); hideProbe(); };
$('#btnExport').onclick =()=>{ const a=document.createElement('a'); a.download='heatmap.png'; a.href=canvas.toDataURL('image/png'); a.click(); };

$('#btnSave').onclick=()=>{
  const payload={ aps, segments, alpha:+($('#alpha').value||0.6), blurPx:+($('#blurPx').value||16),
    scale:scalePxPerMeter, worldW, worldH };
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
      aps=obj.aps||[]; segments=(obj.segments||[]).map(s=>{
        if(s.att24==null && s.att5==null){
          // โปรเจ็กต์เก่า: มี s.att เดี่ยว → แปลงเป็น per-band ตาม default ของชนิด
          const base24 = s.att ?? 8;
          const def = MATERIALS[s.type]?.att || {'2.4':base24,'5':base24};
          const ratio = (def['5']||base24)/(def['2.4']||base24);
          return {...s, att24: base24, att5: +(base24*ratio).toFixed(1)};
        }
        return s;
      });
      $('#alpha').value=obj.alpha??0.6; $('#blurPx').value=obj.blurPx??16;
      scalePxPerMeter=obj.scale||null; worldW=obj.worldW||worldW; worldH=obj.worldH||worldH;
      $('#scaleLabel').textContent=scalePxPerMeter?`${scalePxPerMeter.toFixed(1)} px/เมตร`:'ยังไม่ตั้ง';
      resetView(); drawAll(); refreshAPList(); refreshMatList();
    }catch(err){ alert('Invalid project JSON'); }
  };
  reader.readAsText(f);
});

/* ===== File / image ===== */
$('#fileInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const img=new Image();
  img.onload=()=>{ floorImg=img; worldW=img.naturalWidth; worldH=img.naturalHeight; resetView(); drawAll(); };
  img.src=URL.createObjectURL(f);
});
$('#btnClear').onclick=()=>{ floorImg=null; resetView(); drawAll(); };

/* ===== Zoom controls ===== */
function zoomAt(cx, cy, factor){
  const old=view.scale, ns=clamp(old*factor, view.min, view.max); if(ns===old) return;
  const wx=(cx-view.tx)/old, wy=(cy-view.ty)/old;
  const ntx=cx-wx*ns, nty=cy-wy*ns;
  setView(ns,ntx,nty);
}
$('#btnZoomIn').onclick =()=>zoomAt(canvas.width/2, canvas.height/2, 1.25);
$('#btnZoomOut').onclick=()=>zoomAt(canvas.width/2, canvas.height/2, 0.8);
$('#btnZoomReset').onclick=()=>resetView();

canvas.addEventListener('wheel', e=>{
  if(appMode!=='planning') return;
  e.preventDefault();
  const r=canvas.getBoundingClientRect(), cx=e.clientX-r.left, cy=e.clientY-r.top;
  zoomAt(cx,cy, e.deltaY<0 ? 1.12 : 0.9);
},{passive:false});

/* ===== Pan with Space + drag ===== */
document.addEventListener('keydown', e=>{ if(e.code==='Space') spacePan=true; if(e.key==='Escape'){ mode='idle'; $('#modeBadge').textContent='โหมด: Idle'; hideProbe(); }});
document.addEventListener('keyup',   e=>{ if(e.code==='Space') spacePan=false; });

canvas.addEventListener('mousedown', e=>{
  if(appMode!=='planning') return;
  const {screen,world}=getCanvasPos(e);
  if(spacePan || e.button===1){ panAnchor={ x:screen.x, y:screen.y, tx:view.tx, ty:view.ty }; return; }
  if(mode==='scale' || mode==='mat') startDrag(world.x,world.y);
});
canvas.addEventListener('mousemove', e=>{
  if(appMode!=='planning') return;
  const {screen,world}=getCanvasPos(e);
  if(panAnchor){ const dx=screen.x-panAnchor.x, dy=screen.y-panAnchor.y; setView(view.scale, panAnchor.tx+dx, panAnchor.ty+dy); return; }
  if(mode==='scale' || mode==='mat') updateDrag(world.x,world.y);
});
canvas.addEventListener('mouseup', e=>{
  if(appMode!=='planning') return;
  if(panAnchor){ panAnchor=null; return; }
  const {world}=getCanvasPos(e);
  if(mode==='scale' || mode==='mat') endDrag(world.x,world.y);
});
canvas.addEventListener('mouseleave', ()=>{ panAnchor=null; if(appMode!=='planning') return; dragging=false; dragStart=null; clearOverlay(); });

/* ===== Drag helpers (world coords) ===== */
function drawArrowWorld(a,b,opts={}){
  const {color='#6ae3ff',width=3.5,head=12,dash=[10,6],label=''}=opts;
  octx.save(); octx.clearRect(0,0,overlay.width,overlay.height); octx.setTransform(1,0,0,1,0,0);
  const A=worldToScreen(a), B=worldToScreen(b);
  octx.lineWidth=width; octx.setLineDash(dash); octx.strokeStyle=color;
  octx.beginPath(); octx.moveTo(A.x,A.y); octx.lineTo(B.x,B.y); octx.stroke();
  octx.setLineDash([]);
  const ang=Math.atan2(B.y-A.y,B.x-A.x);
  octx.beginPath(); octx.moveTo(B.x,B.y);
  octx.lineTo(B.x-head*Math.cos(ang - Math.PI/7), B.y-head*Math.sin(ang - Math.PI/7));
  octx.lineTo(B.x-head*Math.cos(ang + Math.PI/7), B.y-head*Math.sin(ang + Math.PI/7));
  octx.closePath(); octx.fillStyle=color; octx.fill();
  octx.fillStyle='#fff'; octx.strokeStyle='#000'; octx.lineWidth=2;
  [A,B].forEach(p=>{ octx.beginPath(); octx.arc(p.x,p.y,4,0,Math.PI*2); octx.fill(); octx.stroke(); });
  if(label){ octx.font='12px ui-monospace,monospace'; octx.fillStyle='#cfe6ff'; octx.fillText(label, B.x+10, B.y-8); }
  octx.restore();
}
function startDrag(x,y){ dragging=true; dragStart={x,y}; clearOverlay(); }
function updateDrag(x,y){
  if(!dragging||!dragStart) return;
  const label=(mode==='scale')? `${dist(dragStart,{x,y}).toFixed(1)} px`
    : `${MATERIALS[$('#matType').value]?.name||'วัสดุ'} · 2.4:${($('#matAtt').value||'0')} dB`;
  drawArrowWorld(dragStart,{x,y},{color:(mode==='scale')?'#6ae3ff':'#ffd36a', label});
}
function endDrag(x,y){
  if(!dragging||!dragStart) return;
  clearOverlay();
  const a={...dragStart}, b={x,y};
  if(mode==='scale'){
    const Lpx=dist(a,b), real=prompt(`ความยาวจริง (เมตร) ของไม้บรรทัด ${Lpx.toFixed(1)} px = ?`, '5');
    if(real && +real>0){ scalePxPerMeter=Lpx/(+real); $('#scaleLabel').textContent=`${scalePxPerMeter.toFixed(1)} px/เมตร`; }
    mode='idle'; $('#modeBadge').textContent='โหมด: Idle'; drawAll();
  }else if(mode==='mat'){
    const type=$('#matType').value;
    // เอาค่าที่ผู้ใช้ใส่เป็น “ค่า 2.4 GHz” แล้วอนุมานค่า 5 GHz ตามอัตราส่วน default ของวัสดุนั้น
    const base24=parseFloat($('#matAtt').value)|| (MATERIALS[type]?.att?.['2.4'] ?? 8);
    const def = MATERIALS[type]?.att || {'2.4':base24,'5':base24};
    const ratio = (def['5']||base24)/(def['2.4']||base24);
    const att24=+base24.toFixed(1), att5=+(base24*ratio).toFixed(1);
    segments.push({a,b,type,att24,att5});
    mode='idle'; $('#modeBadge').textContent='โหมด: Idle'; drawAll(); refreshMatList();
  }
  dragging=false; dragStart=null;
}

/* ===== Click: AP / Probe ===== */
canvas.addEventListener('click', e=>{
  if(appMode!=='planning') return;
  if(panAnchor) return;
  const {world,screen}=getCanvasPos(e);
  if(mode==='ap'){
    if(!scalePxPerMeter){ scalePxPerMeter=100; $('#scaleLabel').textContent='100 px/เมตร (อัตโนมัติ)'; }
    const label=$('#apLabel').value.trim()||`AP-${aps.length+1}`;
    const p0=parseFloat($('#apP0').value||'-40');
    const band=$('#apBand').value||'5';
    const preset=window.__currentApPreset?{presetName:window.__currentApPreset.name}:undefined;
    aps.push({x:world.x,y:world.y,label,p0,band,preset});
    drawAll(); refreshAPList();
  }else if(mode==='idle'){
    if(!hasRendered) return;
    showProbeAtScreen(screen.x, screen.y, world.x, world.y);
  }
});

function showProbeAtScreen(sx,sy,wx,wy){
  drawAll();
  ctx.save(); ctx.setTransform(1,0,0,1,0,0);
  ctx.beginPath(); ctx.arc(sx,sy,6,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.globalAlpha=.9; ctx.fill();
  ctx.lineWidth=2; ctx.strokeStyle='#000'; ctx.globalAlpha=1; ctx.stroke(); ctx.restore();

  const rssi=rssiFromAPs(wx,wy), col=colorFromRSSI(rssi);
  UI.probeVal.textContent=`${rssi.toFixed(1)} dBm`; UI.probeMeta.textContent=`x=${wx|0}, y=${wy|0}`;
  UI.probe.style.left=`${sx+10}px`; UI.probe.style.top=`${sy-10}px`; UI.probe.style.display='block';
  UI.probe.querySelector('#sw').style.background = rgbStr(col);
}
function hideProbe(){ UI.probe.style.display='none'; }

/* ===== AP presets ===== */
let AP_PRESETS={};
async function loadApPresets(){
  const sel=$('#apPreset'); if(!sel) return;
  sel.innerHTML='<option value="">(กำลังโหลดพรีเซ็ต...)</option>';
  try{
    const res=await fetch('./ap_presets.json',{cache:'no-store'});
    if(!res.ok) throw new Error(res.statusText);
    AP_PRESETS=await res.json();
    sel.innerHTML='<option value="">-- เลือกรุ่น --</option>';
    Object.keys(AP_PRESETS).forEach(name=>{ const o=document.createElement('option'); o.value=name; o.textContent=name; sel.appendChild(o); });
  }catch(e){ sel.innerHTML='<option value="">(โหลดพรีเซ็ตไม่ได้)</option>'; console.error(e); }
}
$('#btnUsePreset')?.addEventListener('click', ()=>{
  const sel=$('#apPreset'); if(!sel) return;
  const name=(sel.value||'').trim(); if(!name||!AP_PRESETS[name]) return;
  const ap=AP_PRESETS[name];
  $('#apLabel').value=name;
  const bandSel=$('#apBand'); const band=ap.bands?.includes('5')?'5':(ap.bands?.[0]||'2.4'); bandSel.value=band;
  if(ap.p0 && ap.p0[band]!=null) $('#apP0').value=ap.p0[band];
  window.__currentApPreset={name};
});

/* ===== Keyboard ===== */
document.addEventListener('keydown', e=>{
  if(appMode!=='planning') return;
  if(e.key==='s'||e.key==='S'){ mode='scale'; $('#modeBadge').textContent='โหมด: ตั้งสเกล'; hideProbe(); }
  if(e.key==='a'||e.key==='A'){ mode='ap';    $('#modeBadge').textContent='โหมด: วาง AP (คลิก)'; hideProbe(); }
  if(e.key==='w'||e.key==='W'){ mode='mat';   $('#modeBadge').textContent='โหมด: วัสดุ (ลากเส้น)'; hideProbe(); }
  if(e.key==='h'||e.key==='H'){ renderHeatmap(); hideProbe(); }
  if(e.key==='Escape'){ mode='idle'; $('#modeBadge').textContent='โหมด: Idle'; hideProbe(); }
});

/* ===== Draw all ===== */
function drawAll(){
  UI.legendMin.textContent=RSSI_MIN; UI.legendMax.textContent=RSSI_MAX;
  drawBase();
  if(heatCanvas){
    const alpha=clamp(parseFloat($('#alpha').value||'0.6'),0,1);
    const blurPx=Math.max(0,parseInt($('#blurPx').value||'16',10));
    ctx.save(); ctx.setTransform(view.scale,0,0,view.scale,view.tx,view.ty);
    ctx.globalAlpha=alpha; if(blurPx>0) ctx.filter=`blur(${blurPx}px)`;
    ctx.drawImage(heatCanvas,0,0,worldW,worldH);
    ctx.filter='none'; ctx.globalAlpha=1; ctx.restore();
  }
  drawPermanent();
  if(heatField) drawContours(CONTOUR_LEVELS,2);
}

/* ===== Init ===== */
function applyCanvasCSSSize(){ overlay.width=canvas.width; overlay.height=canvas.height; }
window.addEventListener('resize', applyCanvasCSSSize);
(function init(){
  setModeApp('planning'); makeFixedLegend();
  worldW=canvas.width; worldH=canvas.height;
  resetView(); applyCanvasCSSSize(); drawAll(); loadApPresets();
})();
/* ===== SURVEY MODE: live RSSI + file ingest + IDW heatmap ===== */
let ws=null, surveyPts=[], curPos=null, freezePos=false, surveyMarkMode=false;

// refs
const wsUrl=$('#wsUrl'), wsStatus=$('#wsStatus');
const btnWSConnect=$('#btnWSConnect'), btnWSDisconnect=$('#btnWSDisconnect');
const btnMarkHere=$('#btnMarkHere'), btnFreeze=$('#btnFreeze'), btnUnfreeze=$('#btnUnfreeze'), curPosLabel=$('#curPosLabel');
const surveyFile=$('#surveyFile'), btnLoadFile=$('#btnLoadFile');
const svCount=$('#svCount'), btnRenderSurvey=$('#btnRenderSurvey'), btnExportSurvey=$('#btnExportSurvey');

function setWSStatus(s){ if(wsStatus) wsStatus.textContent="WS: "+s; }
function fmtPos(p){ return p?`(${p.x|0}, ${p.y|0})`:'ยังไม่ตั้ง'; }
function addSurveySample(t,rssi,bssid=null,ssid=null){ if(!curPos) return; surveyPts.push({x:curPos.x,y:curPos.y,time:+t,rssi:+rssi,bssid,ssid}); if(svCount) svCount.textContent=surveyPts.length; }

if(btnWSConnect){
  btnWSConnect.onclick=()=>{
    try{
      ws?.close(); const url=(wsUrl.value||'').trim(); if(!url){ alert("ใส่ WS URL ก่อน เช่น ws://192.168.1.50:8765"); return; }
      ws=new WebSocket(url); setWSStatus("connecting...");
      ws.onopen =()=>setWSStatus("connected");
      ws.onclose=()=>setWSStatus("disconnected");
      ws.onerror=()=>setWSStatus("error");
      ws.onmessage=(ev)=>{ try{ const m=JSON.parse(ev.data); if(m.type==="sample") addSurveySample(m.time,m.rssi_dbm,m.bssid||null,m.ssid||null);}catch{} };
    }catch{ setWSStatus("error"); }
  };
  btnWSDisconnect.onclick=()=>{ try{ws?.close()}catch{}; ws=null; setWSStatus("disconnected"); };
}

if(btnMarkHere){ btnMarkHere.onclick=()=>{ surveyMarkMode=true; UI.modeBadge.textContent='โหมด: เลือกตำแหน่งสำรวจ (คลิกบนแปลน)'; }; }
if(btnFreeze){ btnFreeze.onclick = ()=>{ freezePos=true;  }; }
if(btnUnfreeze){ btnUnfreeze.onclick= ()=>{ freezePos=false; }; }

// ใช้คลิกบน canvas เพื่อกำหนด/ย้ายตำแหน่ง (เฉพาะตอนอยู่โหมด Survey)
canvas.addEventListener('click', e=>{
  if(appMode!=='survey') return;
  const {world}=getCanvasPos(e);
  if(surveyMarkMode){
    curPos={x:world.x,y:world.y}; curPosLabel.textContent=fmtPos(curPos);
    surveyMarkMode=false; UI.modeBadge.textContent='โหมด: Survey';
  }else if(!freezePos && curPos){
    curPos={x:world.x,y:world.y}; curPosLabel.textContent=fmtPos(curPos);
  }
});

// โหลดไฟล์ออฟไลน์ (รองรับ .csv/.tsv/.json)
if(btnLoadFile){
  btnLoadFile.onclick=()=>{
    const f=surveyFile.files?.[0]; if(!f){ alert('เลือกไฟล์ก่อน'); return; }
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const txt=reader.result;
        if(f.name.endsWith(".json")||txt.trim().startsWith("{")||txt.trim().startsWith("[")){
          const arr=JSON.parse(txt);
          arr.forEach(o=>{
            const t=+o.time, r=+o.rssi_dbm; if(!Number.isFinite(t)||!Number.isFinite(r)) return;
            const p=(Number.isFinite(o.x)&&Number.isFinite(o.y))?{x:+o.x,y:+o.y}:curPos; if(!p) return;
            surveyPts.push({x:p.x,y:p.y,time:t,rssi:r,bssid:o.bssid||null,ssid:o.ssid||null});
          });
        }else{
          const delim=txt.indexOf("\t")>=0?"\t":","; const lines=txt.split(/\r?\n/).filter(Boolean);
          const head=lines[0].split(delim).map(s=>s.trim().toLowerCase());
          const idx=k=>head.findIndex(h=>h===k||h.includes(k));
          const it=idx("time"), ir=idx("rssi"), ix=idx("x"), iy=idx("y"), ib=idx("bssid"), isd=idx("ssid");
          for(let i=1;i<lines.length;i++){
            const cols=lines[i].split(delim); const t=+cols[it], r=+cols[ir]; if(!Number.isFinite(t)||!Number.isFinite(r)) continue;
            const hasXY=ix>=0&&iy>=0&&Number.isFinite(+cols[ix])&&Number.isFinite(+cols[iy]);
            const p=hasXY?{x:+cols[ix],y:+cols[iy]}:curPos; if(!p) continue;
            surveyPts.push({x:p.x,y:p.y,time:t,rssi:r,bssid:ib>=0?(cols[ib]||null):null,ssid:isd>=0?(cols[isd]||null):null});
          }
        }
        if(svCount) svCount.textContent=surveyPts.length;
        alert("โหลดข้อมูลสำรวจแล้ว: "+surveyPts.length+" จุด"); drawAll();
      }catch{ alert("อ่านไฟล์ไม่สำเร็จ"); }
    };
    reader.readAsText(f);
  };
}

// ส่งออกจุดสำรวจ
if(btnExportSurvey){
  btnExportSurvey.onclick=()=>{
    const rows=[["x","y","time","rssi_dbm","bssid","ssid"], ...surveyPts.map(p=>[p.x,p.y,p.time,p.rssi,p.bssid||"",p.ssid||""])];
    const csv=rows.map(r=>r.join(",")).join("\n");
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download="survey_points.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
}

// IDW heatmap จากจุดจริง (ใช้ colorFromRSSI / drawContours เดิม)
function renderSurveyHeatmap(){
  if(!surveyPts.length){ alert("ยังไม่มีจุดสำรวจ"); return; }
  if(!scalePxPerMeter){ alert("ยังไม่ตั้งสเกล (ตั้งที่แท็บ Planning)"); return; }
  const step=Math.max(1,parseInt($('#svStep').value||'3',10));
  const pow =Math.max(0.1,parseFloat($('#svPow').value||'2.0'));
  const radM=Math.max(0.1,parseFloat($('#svRadiusM').value||'6'));
  const kmin=Math.max(1,parseInt($('#svKMin').value||'1',10));
  const radPx=radM*scalePxPerMeter;

  heatCanvas=document.createElement('canvas'); heatCanvas.width=worldW; heatCanvas.height=worldH;
  const hctx=heatCanvas.getContext('2d',{willReadFrequently:true});
  const img=hctx.createImageData(worldW,worldH); heatField=new Float32Array(worldW*worldH); const arr=img.data;

  // spatial buckets เร่งค้นหาเพื่อนบ้าน
  const cell=Math.max(step*4,24), nx=Math.ceil(worldW/cell), ny=Math.ceil(worldH/cell);
  const buckets=Array.from({length:nx*ny},()=>[]);
  const bkey=(x,y)=>Math.min(ny-1,Math.max(0,Math.floor(y/cell)))*nx + Math.min(nx-1,Math.max(0,Math.floor(x/cell)));
  surveyPts.forEach(p=>buckets[bkey(p.x,p.y)].push(p));
  const neigh=(x,y)=>{ const ix=Math.min(nx-1,Math.max(0,Math.floor(x/cell)));
    const iy=Math.min(ny-1,Math.max(0,Math.floor(y/cell))); const out=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ const jx=ix+dx,jy=iy+dy; if(jx<0||jy<0||jx>=nx||jy>=ny) continue; out.push(...buckets[jy*nx+jx]); }
    return out; };

  for(let y=0;y<worldH;y+=step){
    for(let x=0;x<worldW;x+=step){
      const N=neigh(x,y); let num=0,den=0,cnt=0;
      for(const p of N){
        const d=Math.hypot(x-p.x,y-p.y);
        if(d<=radPx){ const w=1/Math.pow(Math.max(d,1e-6),pow); num+=w*p.rssi; den+=w; cnt++; }
      }
      const rssi=(cnt>=kmin && den>0)?(num/den):RSSI_MIN;
      const [r,g,b]=colorFromRSSI(rssi);
      for(let yy=0;yy<step;yy++){ const Y=y+yy; if(Y>=worldH) break;
        for(let xx=0;xx<step;xx++){ const X=x+xx; if(X>=worldW) break;
          heatField[Y*worldW+X]=rssi; const i=(Y*worldW+X)*4; arr[i]=r; arr[i+1]=g; arr[i+2]=b; arr[i+3]=255;
        }}
    }
  }
  hctx.putImageData(img,0,0);
  drawAll(); hasRendered=true; drawContours(CONTOUR_LEVELS,2);
}
if(btnRenderSurvey){ btnRenderSurvey.onclick=renderSurveyHeatmap; }

