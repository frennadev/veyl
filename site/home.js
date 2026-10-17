(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var clamp=function(v,a,b){return v<a?a:v>b?b:v};
var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var esc=function(s){ return String(s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };

/* nav hairline once the page has moved */
var nav=$('nav');
var onScrollNav=function(){ nav.classList.toggle('scrolled',window.scrollY>8); };
onScrollNav(); window.addEventListener('scroll',onScrollNav,{passive:true});

/* ---- the flow: deposits of every size go in on the left (public, each one different), pass the proof gate and come
   out as identical pieces that settle into the pool's bins. Waves every 3.6 s; the stage row follows the wave. ---- */
var cv=$('flowCv'), fig=$('flow'), ctx=cv.getContext('2d'), stages=Array.prototype.slice.call($('stages').children), tags=Array.prototype.slice.call(fig.querySelectorAll('.ft'));
var css=getComputedStyle(document.documentElement), C={ink:(css.getPropertyValue('--ink')||'#ECEFE6').trim(), g:(css.getPropertyValue('--oxblood')||'#C8F560').trim()};
var rgb=function(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }, G=rgb(C.g), I=rgb(C.ink);
var col=function(c,a){ return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a.toFixed(3)+')'; };
var W=0,H=0,DPR=1, NB=31, MID=15, bins=[], deps=[], bits=[], glows=[], T=0, wave=-1, stageNow=-1, CYCLE=3.6;
var rnd=function(a,b){ return a+Math.random()*(b-a); }, gauss=function(){ var u=1-Math.random(), v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
function fGeo(){ return {gx:W*0.40, gy0:H*0.2, gy1:H*0.86, x0:W*0.53, x1:W*0.955, base:H*0.86}; }
function fSize(){ var r=cv.getBoundingClientRect(); DPR=Math.min(2,window.devicePixelRatio||1); W=Math.max(1,r.width); H=Math.max(1,r.height); cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
  var g=fGeo(); bins=[]; for(var i=0;i<NB;i++){ var d=(i-MID)/6.2, hb=H*(0.07+0.44*Math.exp(-d*d)); bins.push({hb:hb,h:hb,f:0}); }
  var tg=fig.querySelector('.ft.gate'); if(tg) tg.style.left=(g.gx/W*100).toFixed(2)+'%'; }
function spawnWave(){ var g=fGeo(), n=3+(Math.random()*3|0), cy=(g.gy0+g.gy1)/2;
  for(var k=0;k<n;k++){ var s=rnd(9,28), y0=rnd(H*0.26,H*0.74), x0=-s-k*rnd(36,70)-rnd(0,24), dur=1.25+k*0.16;
    deps.push({x:x0,y:y0,s:s,x0:x0,y0:y0,y1:cy+(y0-cy)*0.32,t:0,dur:dur,shade:rnd(0.55,0.95)}); } }
function fHit(d){ var g=fGeo(), k=Math.max(4,Math.round(d.s*0.75)); glows.push({y:d.y,t:0});
  for(var j=0;j<k;j++){ var bi=Math.max(0,Math.min(NB-1,Math.round(MID+gauss()*4.2))), bw=(g.x1-g.x0)/NB, tx=g.x0+bw*(bi+0.5)+rnd(-bw*0.18,bw*0.18), ty=g.base-bins[bi].h-3;
    var sx=g.gx+rnd(2,8), sy=d.y+rnd(-d.s/2,d.s/2); bits.push({sx:sx,sy:sy,cx:(sx+tx)/2+rnd(-20,20),cy:Math.min(sy,ty)-rnd(30,90),tx:tx,ty:ty,bi:bi,t:-rnd(0,0.25),dur:rnd(0.85,1.3)}); } }
function ease(t){ return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2; }
function fStep(dt){ T+=dt; var g=fGeo(), w=Math.floor(T/CYCLE); if(w!==wave){ wave=w; spawnWave(); }
  var ph=(T%CYCLE)/CYCLE, st=ph<0.34?0:ph<0.6?1:2; if(st!==stageNow){ stageNow=st; stages.forEach(function(el){ el.classList.toggle('on',+el.dataset.stage===st); }); tags.forEach(function(el){ el.classList.toggle('on',+el.dataset.stage===st); }); }
  for(var i=deps.length-1;i>=0;i--){ var d=deps[i]; d.t+=dt; var q=Math.min(1,d.t/d.dur); d.x=d.x0+(g.gx-d.x0)*q; d.y=d.y0+(d.y1-d.y0)*ease(q); if(q>=1){ fHit(d); deps.splice(i,1); } }
  for(var j=bits.length-1;j>=0;j--){ var b=bits[j]; b.t+=dt; if(b.t>=b.dur){ var bn=bins[b.bi]; bn.h+=H*0.006; bn.f=1; bits.splice(j,1); } }
  bins.forEach(function(bn){ bn.h+=(bn.hb-bn.h)*(1-Math.exp(-dt/5)); bn.f=Math.max(0,bn.f-dt*2.2); });
  for(var k=glows.length-1;k>=0;k--){ glows[k].t+=dt; if(glows[k].t>0.9) glows.splice(k,1); } }
function rr(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function fDraw(){ var g=fGeo(); ctx.clearRect(0,0,W,H);
  ctx.strokeStyle=col(I,0.06); ctx.lineWidth=1; ctx.setLineDash([2,7]); for(var l=0;l<5;l++){ var ly=H*(0.3+l*0.1); ctx.beginPath(); ctx.moveTo(0,ly); ctx.lineTo(g.gx-14,ly); ctx.stroke(); } ctx.setLineDash([]);
  var gr=ctx.createLinearGradient(0,g.gy0,0,g.gy1); gr.addColorStop(0,col(G,0)); gr.addColorStop(0.5,col(G,0.55)); gr.addColorStop(1,col(G,0)); ctx.fillStyle=gr; ctx.fillRect(g.gx-1,g.gy0,2,g.gy1-g.gy0);
  glows.forEach(function(o){ var a=1-o.t/0.9, rg=ctx.createRadialGradient(g.gx,o.y,0,g.gx,o.y,46); rg.addColorStop(0,col(G,0.42*a)); rg.addColorStop(1,col(G,0)); ctx.fillStyle=rg; ctx.fillRect(g.gx-46,o.y-46,92,92); ctx.fillStyle=col(G,0.9*a); ctx.fillRect(g.gx-1.5,o.y-14,3,28); });
  deps.forEach(function(d){ var a=Math.min(1,(d.x+d.s)/60); if(a<=0) return; ctx.fillStyle=col(I,0.9*a*d.shade); rr(d.x-d.s/2,d.y-d.s/2,d.s,d.s,Math.min(5,d.s*0.22)); ctx.fill(); });
  var bw=(g.x1-g.x0)/NB, hmax=H*0.6;
  ctx.fillStyle=col(I,0.12); ctx.fillRect(g.x0,g.base+0.5,g.x1-g.x0,1);
  bins.forEach(function(bn,i){ var x=g.x0+bw*i+bw*0.19, w=bw*0.62, h=Math.min(hmax,bn.h), k=h/hmax; ctx.fillStyle=i===MID?col(G,1):col(G,Math.min(0.92,0.14+0.62*k+0.35*bn.f)); rr(x,g.base-h,w,h,Math.min(2.5,w/3)); ctx.fill(); });
  ctx.fillStyle=col(G,1); bits.forEach(function(b){ if(b.t<0) return; var q=ease(Math.min(1,b.t/b.dur)), u=1-q, x=u*u*b.sx+2*u*q*b.cx+q*q*b.tx, y=u*u*b.sy+2*u*q*b.cy+q*q*b.ty; ctx.fillRect(x-1.5,y-1.5,3,3); }); }
var last=null, raf=null, visible=true;
function fFrame(now){ raf=null; if(last===null) last=now; var dt=Math.min(0.05,(now-last)/1000); last=now; fStep(dt); fDraw(); if(visible&&!document.hidden) raf=requestAnimationFrame(fFrame); else last=null; }
function fRun(){ if(reduce) return; if(!raf){ last=null; raf=requestAnimationFrame(fFrame); } }
fSize(); if(reduce){ for(var s0=0;s0<Math.round(2.9/0.02)+Math.round(3.6*2/0.02);s0++) fStep(0.02); fDraw(); fig.classList.add('static'); }
else { fig.classList.add('ready'); fRun(); if('IntersectionObserver' in window) new IntersectionObserver(function(es){ visible=es.some(function(e){ return e.isIntersecting; }); if(visible) fRun(); },{rootMargin:'80px'}).observe(fig); document.addEventListener('visibilitychange',function(){ if(!document.hidden) fRun(); }); }
window.addEventListener('resize',function(){ clearTimeout(fSize.t); fSize.t=setTimeout(function(){ fSize(); if(reduce) fDraw(); },120); });

/* ---- reveal figures once ---- */
var rev=Array.prototype.slice.call(document.querySelectorAll('.reveal'));
if(reduce||!('IntersectionObserver' in window)) rev.forEach(function(el){ el.classList.add('in'); });
else { var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }); },{rootMargin:'0px 0px -8% 0px'}); rev.forEach(function(el){ io.observe(el); }); }

/* ---- the showcase: an illustration of a shielded position going into the bins. No balances, prices or proofs here. ---- */
var POOLS={'sol-usdc':{x:'SOL',y:'USDC',c:['c-eth','c-usdc'],bs:'0.10%',fee:'0.05%'},'sol-usdt':{x:'SOL',y:'USDT',c:['c-eth','c-usde'],bs:'0.10%',fee:'0.05%'},'usdt-usdc':{x:'USDT',y:'USDC',c:['c-usde','c-usdc'],bs:'0.01%',fee:'0.01%'}};
var L={pool:'sol-usdc',shape:'spot',w:5,busy:false,lit:false};
var SHAPE={spot:'Spot',curve:'Curve',bidask:'Bid-Ask'};
var N=25;
function lpStep(k,state){ var li=document.querySelector('#lpSteps [data-k="'+k+'"]'); if(!li) return; li.className=state||''; var lis=Array.prototype.slice.call(document.querySelectorAll('#lpSteps li')), last=-1; lis.forEach(function(x,i){ if(/\b(on|ok)\b/.test(x.className)) last=i; }); $('lpSteps').style.setProperty('--p',last<0?0:(last/(lis.length-1)).toFixed(3)); }
function seg(id,key,fn){ $(id).addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b||L.busy) return; Array.prototype.forEach.call($(id).querySelectorAll('button'),function(x){ x.setAttribute('aria-pressed',x===b); }); L[key]=key==='w'?+b.dataset.w:b.dataset.s; L.lit=false; reset(); fn(); }); }
function poolShape(i){ var d=i/9; return 0.18+0.82*Math.exp(-d*d); }               /* the pool's liquidity around the price, as a shape */
function weight(i){ var r=Math.abs(i)/(L.w+0.5); if(L.shape==='curve') return Math.max(0.15,1-r*r); if(L.shape==='bidask') return 0.25+r*r; return 1; }
function draw(){ var svg=$('lpBins'), W=svg.clientWidth||520, H=svg.clientHeight||170; var n=2*N+1, gap=Math.max(1.5,W/n*0.2), bw=(W-gap*(n-1))/n;
  if(svg.dataset.w!==String(W)||svg.querySelectorAll('rect.b').length!==n){ svg.setAttribute('viewBox','0 0 '+W+' '+H); var h='<rect class="rng" x="0" y="0" width="0" height="'+H+'" rx="3"/>';
    for(var k=0;k<n;k++){ var i0=k-N; h+='<rect class="b '+(i0<0?'y':i0>0?'x':'a')+'" x="'+(k*(bw+gap)).toFixed(1)+'" width="'+bw.toFixed(1)+'" rx="1.5" y="'+H+'" height="0"/>'; }
    svg.innerHTML=h; svg.dataset.w=String(W); svg.getBoundingClientRect(); }
  var rg=svg.querySelector('rect.rng'), k0=N-L.w, k1=N+L.w; rg.style.x=(k0*(bw+gap)-gap/2).toFixed(1)+'px'; rg.style.width=((k1-k0+1)*(bw+gap)).toFixed(1)+'px'; rg.setAttribute('height',H);
  Array.prototype.forEach.call(svg.querySelectorAll('rect.b'),function(el,k){ var i=k-N, add=(L.lit&&Math.abs(i)<=L.w)?0.42*weight(i):0, hh=(poolShape(i)+add)/1.5*(H-8);
    el.style.y=(H-hh).toFixed(1)+'px'; el.style.height=hh.toFixed(1)+'px'; el.classList.toggle('mine',add>0); });
  var p=POOLS[L.pool]; $('lpPrev').textContent=SHAPE[L.shape]+' across '+(2*L.w+1)+' bins around the price, one or both of '+p.x+' and '+p.y+'.'; }
function reset(){ ['deposit','prove','verify','apply','earn'].forEach(function(k){ lpStep(k,''); }); $('lpSteps').dataset.state='idle'; $('lpRun').hidden=true; }
function pool(){ var p=POOLS[L.pool]; $('lpDots').innerHTML='<i class="'+p.c[0]+'"></i><i class="'+p.c[1]+'"></i>'; $('lpMk').textContent='Bin step '+p.bs+' · base fee '+p.fee; }
seg('lpShape','shape',draw); seg('lpRange','w',draw);
$('lpPool').addEventListener('change',function(){ if(L.busy) return; L.pool=this.value; L.lit=false; reset(); pool(); draw(); });
$('lpGo').addEventListener('click',function(){ if(L.busy) return; L.busy=true; L.lit=false; reset(); draw(); $('lpSteps').dataset.state='running'; $('lpRun').hidden=false; $('lpBar').style.width='0%';
  var seq=[['deposit','Your tokens become private notes.',18],['prove','Your browser proves the notes are yours, without showing them.',52],['verify','The proof is checked before anything moves.',70],['apply','The bins fill. On-chain, the owner is the pool\'s shared shielded position.',90],['earn','Swaps through your bins pay you; you claim privately.',100]];
  var t=0; seq.forEach(function(s,i){ setTimeout(function(){ if(i>0) lpStep(seq[i-1][0],'ok'); lpStep(s[0],'on'); $('lpMsg').textContent=s[1]; $('lpBar').style.width=s[2]+'%'; if(s[0]==='apply'){ L.lit=true; draw(); } if(i===seq.length-1) setTimeout(function(){ lpStep(s[0],'ok'); $('lpSteps').dataset.state='done'; $('lpMsg').textContent='That\'s the whole flow. Do it for real in the app.'; L.busy=false; },900); }, reduce?0:t); t+=i===1?1500:900; }); });
pool(); draw(); window.addEventListener('resize',function(){ clearTimeout(draw.r); draw.r=setTimeout(draw,150); });
})();
