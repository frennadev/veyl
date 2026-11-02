(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var clamp=function(v,a,b){return v<a?a:v>b?b:v};
var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* nav hairline once the page has moved */
var nav=$('nav');
var onScrollNav=function(){ nav.classList.toggle('scrolled',window.scrollY>8); };
onScrollNav(); window.addEventListener('scroll',onScrollNav,{passive:true});

/* ---- the stage: public deposits of every size drift in from the left, slip into the ghost (the proof your browser makes)
   and come out on the right as identical private pieces that settle into the pool's bins. A wave every 3.6 s; the three
   tags and the ghost's eyes follow the wave. ---- */
var cv=$('flowCv'), fig=$('flow'), ctx=cv.getContext('2d'), wrap=$('ghostWrap'), hero=wrap.querySelector('.hero-ghost'), tags=Array.prototype.slice.call(fig.querySelectorAll('.ft'));
var css=getComputedStyle(document.documentElement), hex=function(n,d){ return (css.getPropertyValue(n)||d).trim(); };
var rgb=function(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; };
var I=rgb(hex('--ink','#F2F2F0')), P=rgb(hex('--priv','#CBD8E8')), S=rgb(hex('--silver','#9B9C98'));
var col=function(c,a){ return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a.toFixed(3)+')'; };
var MONO=(hex('--mono','monospace'));
var AMTS=['12.4 SOL','1,830 USDC','0.8 SOL','250 USDT','41M BONK','3.1 JUP','9,400 USDC','2.2 SOL','640 USDC','18 JTO','0.35 SOL','5,000 USDT'];
var W=0,H=0,DPR=1, NB=25, MID=12, G={}, bins=[], deps=[], bits=[], T=0, wave=-1, stageNow=-1, CYCLE=3.6, glow=0;
var rnd=function(a,b){ return a+Math.random()*(b-a); }, gauss=function(){ var u=1-Math.random(), v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
function geo(){ var r=cv.getBoundingClientRect(), g=hero.getBoundingClientRect(), pad=Math.max(16,W*0.035);
  var gx=g.left-r.left+g.width/2, gy=g.top-r.top+g.height*0.48;
  return {gx:gx, gy:gy, gw:g.width, gh:g.height, x0:Math.min(W-pad-40,gx+g.width*0.78), x1:W-pad, base:H*0.86, inL:gx-g.width*0.12}; }
function size(){ var r=cv.getBoundingClientRect(); DPR=Math.min(2,window.devicePixelRatio||1); W=Math.max(1,r.width); H=Math.max(1,r.height); cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR); ctx.setTransform(DPR,0,0,DPR,0,0);
  G=geo(); NB=W<640?13:25; MID=(NB-1)/2; bins=[]; for(var i=0;i<NB;i++){ var d=(i-MID)/(NB/5), hb=H*(0.05+0.26*Math.exp(-d*d)); bins.push({hb:hb,h:hb,f:0}); }
  var tg=fig.querySelector('.ft.gate'); if(tg) tg.style.left=(G.gx/W*100).toFixed(2)+'%'; }
function spawn(n){
  for(var k=0;k<n;k++){ var s=rnd(9,30), y0=rnd(H*0.18,H*0.82), x0=-s-rnd(0,50), dur=rnd(2.6,3.4);
    deps.push({x:x0,y:y0,s:s,x0:x0,y0:y0,t:0,dur:dur,shade:rnd(0.5,0.95),amt:AMTS[(Math.random()*AMTS.length)|0]}); } }
function gulp(d){ glow=1; if(!reduce&&hero.animate) hero.animate([{scale:'1 1'},{scale:'1.045 .955'},{scale:'.985 1.02'},{scale:'1 1'}],{duration:420,easing:'cubic-bezier(.2,.7,.2,1)'});
  var k=Math.max(3,Math.round(d.s*0.45)), bw=(G.x1-G.x0)/NB;
  for(var j=0;j<k;j++){ var bi=Math.round(clamp(MID+gauss()*NB/7,0,NB-1)), tx=G.x0+bw*(bi+0.5)+rnd(-bw*0.15,bw*0.15), ty=G.base-bins[bi].h-3;
    var sx=G.gx+G.gw*rnd(0.2,0.34), sy=G.gy+rnd(-G.gh*0.12,G.gh*0.22); bits.push({sx:sx,sy:sy,cx:(sx+tx)/2+rnd(-10,30),cy:Math.min(sy,ty)-rnd(30,80),tx:tx,ty:ty,bi:bi,t:-rnd(0.05,0.4),dur:rnd(0.9,1.35)}); } }
function ease(t){ return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2; }
var nextDep=0;
function step(dt){ T+=dt; var w=Math.floor(T/CYCLE); if(w!==wave){ wave=w; } if(T>=nextDep){ spawn(Math.random()<0.35?2:1); nextDep=T+rnd(0.55,1.15)*(W<640?1.5:1); }
  var ph=(T%CYCLE)/CYCLE, st=ph<0.42?0:ph<0.62?1:2; if(st!==stageNow){ stageNow=st; tags.forEach(function(el){ el.classList.toggle('on',+el.dataset.stage===st); }); }
  for(var i=deps.length-1;i>=0;i--){ var d=deps[i]; d.t+=dt; var q=Math.min(1,d.t/d.dur), e=q*q*(3-2*q); d.x=d.x0+(G.inL-d.x0)*e; d.y=d.y0+(G.gy-d.y0)*Math.pow(q,1.6); if(q>=1){ gulp(d); deps.splice(i,1); } }
  for(var j=bits.length-1;j>=0;j--){ var b=bits[j]; b.t+=dt; if(b.t>=b.dur){ var bn=bins[b.bi]; bn.h+=H*0.005; bn.f=1; bits.splice(j,1); } }
  bins.forEach(function(bn){ bn.h+=(bn.hb-bn.h)*(1-Math.exp(-dt/6)); bn.f=Math.max(0,bn.f-dt*3.2); });
  glow=Math.max(0,glow-dt*1.8); }
function rr(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function draw(){ ctx.clearRect(0,0,W,H);
  /* the veil: a soft light behind the ghost that breathes when it takes a deposit */
  var R=Math.min(G.gh*(0.95+0.12*glow),G.gy-2,H-G.gy-2), rg=ctx.createRadialGradient(G.gx,G.gy,0,G.gx,G.gy,R); rg.addColorStop(0,col(I,0.07+0.06*glow)); rg.addColorStop(1,col(I,0)); ctx.fillStyle=rg; ctx.fillRect(G.gx-R,G.gy-R,2*R,2*R);
  /* public lane: every deposit is a different size and its amount is readable, until it reaches the ghost */
  ctx.font='500 10.5px '+MONO; ctx.textBaseline='bottom';
  deps.forEach(function(d){ var fade=clamp((d.x+d.s)/70,0,1)*clamp((G.inL-d.x)/(G.gw*0.5),0,1); if(fade<=0) return;
    ctx.strokeStyle=col(I,0.07*fade); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(Math.max(0,d.x-80),d.y); ctx.lineTo(d.x-d.s/2-4,d.y); ctx.stroke();
    ctx.fillStyle=col(I,0.9*fade*d.shade); rr(d.x-d.s/2,d.y-d.s/2,d.s,d.s,Math.min(5,d.s*0.24)); ctx.fill();
    if(d.s>11&&W>=640){ ctx.fillStyle=col(I,0.42*fade); ctx.fillText(d.amt,d.x-d.s/2,d.y-d.s/2-6); } });
  /* the bins: silver liquidity, a bin flashes the private colour when a piece lands in it */
  var bw=(G.x1-G.x0)/NB; ctx.fillStyle=col(I,0.1); ctx.fillRect(G.x0,G.base+0.5,G.x1-G.x0,1);
  bins.forEach(function(bn,i){ var x=G.x0+bw*i+bw*0.2, w=bw*0.6, h=Math.min(H*0.7,bn.h), a=i===Math.round(MID)?0.95:0.28+0.4*(bn.hb/(H*0.31));
    ctx.fillStyle=col(S,a); rr(x,G.base-h,w,h,Math.min(2.5,w/3)); ctx.fill(); if(bn.f>0){ ctx.fillStyle=col(P,0.7*bn.f*bn.f); rr(x,G.base-h,w,h,Math.min(2.5,w/3)); ctx.fill(); } });
  /* the private pieces: all the same size, all the same colour, nothing to tell them apart */
  ctx.fillStyle=col(P,1); bits.forEach(function(b){ if(b.t<0) return; var q=ease(Math.min(1,b.t/b.dur)), u=1-q, x=u*u*b.sx+2*u*q*b.cx+q*q*b.tx, y=u*u*b.sy+2*u*q*b.cy+q*q*b.ty; ctx.globalAlpha=clamp(b.t/0.18,0,1); ctx.fillRect(x-1.75,y-1.75,3.5,3.5); }); ctx.globalAlpha=1; }
var last=null, raf=null, visible=true;
function frame(now){ raf=null; if(last===null) last=now; var dt=Math.min(0.05,(now-last)/1000); last=now; step(dt); draw(); if(visible&&!document.hidden) raf=requestAnimationFrame(frame); else last=null; }
function run(){ if(reduce) return; if(!raf){ last=null; raf=requestAnimationFrame(frame); } }
size(); if(reduce){ for(var s0=0;s0<Math.round(CYCLE*2.6/0.02);s0++) step(0.02); bits.forEach(function(b){ b.t=Math.max(b.t,b.dur*0.55); }); draw(); fig.classList.add('static'); }
else { fig.classList.add('ready'); run(); if('IntersectionObserver' in window) new IntersectionObserver(function(es){ visible=es.some(function(e){ return e.isIntersecting; }); if(visible) run(); },{rootMargin:'80px'}).observe(fig); document.addEventListener('visibilitychange',function(){ if(!document.hidden) run(); }); }
window.addEventListener('resize',function(){ clearTimeout(size.t); size.t=setTimeout(function(){ size(); if(reduce) draw(); },120); });

/* ---- the ghosts' eyes: they follow the pointer; left alone, the hero ghost watches the deposits come in, then the bins.
   Now and then they blink. ---- */
var ghosts=Array.prototype.slice.call(document.querySelectorAll('svg.ghost')), px=null, py=null, lastMove=0, eyeRaf=null;
function look(svg,dx,dy){ var e=svg.querySelector('.g-eyes'); if(!e) return; e.style.setProperty('--ex',(clamp(dx,-1,1)*13).toFixed(2)+'px'); e.style.setProperty('--ey',(clamp(dy,-1,1)*10).toFixed(2)+'px'); }
function eyes(){ eyeRaf=null; var idle=px===null||performance.now()-lastMove>3500;
  ghosts.forEach(function(svg){ var r=svg.getBoundingClientRect(); if(r.bottom<0||r.top>innerHeight) return;
    if(idle){ if(svg===hero) look(svg,stageNow===0?-0.9:stageNow===1?0:0.9,stageNow===2?0.5:0.15); else look(svg,0,0.2); return; }
    look(svg,(px-(r.left+r.width/2))/Math.max(260,r.width*1.6),(py-(r.top+r.height*0.45))/Math.max(260,r.height*1.6)); }); }
function queue(){ if(!eyeRaf) eyeRaf=requestAnimationFrame(eyes); }
window.addEventListener('pointermove',function(e){ if(e.pointerType==='touch') return; px=e.clientX; py=e.clientY; lastMove=performance.now(); queue(); },{passive:true});
document.addEventListener('pointerleave',function(){ px=null; queue(); });
window.addEventListener('scroll',queue,{passive:true});
if(!reduce){ setInterval(queue,400);
  (function blink(){ setTimeout(function(){ ghosts.forEach(function(svg,i){ setTimeout(function(){ svg.classList.add('blink'); setTimeout(function(){ svg.classList.remove('blink'); },150); },i*60); }); blink(); },rnd(2600,6200)); })(); }
queue();

/* ---- the veil lifts: sections arrive slightly blurred and settle as they enter. Visible without script. ---- */
var veils=Array.prototype.slice.call(document.querySelectorAll('.veil'));
if(!reduce&&'IntersectionObserver' in window){
  veils.forEach(function(el){ if(el.getBoundingClientRect().top>innerHeight*0.92) el.classList.add('veiled'); });
  var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.remove('veiled'); io.unobserve(e.target); } }); },{rootMargin:'0px 0px -10% 0px'});
  veils.forEach(function(el){ if(el.classList.contains('veiled')) io.observe(el); }); }

/* ---- the showcase: an illustration of a shielded position going into the bins. No balances, prices or proofs here. ---- */
var POOLS={'sol-usdc':{x:'SOL',y:'USDC',c:['c-eth','c-usdc'],bs:'0.10%',fee:'0.05%'},'sol-usdt':{x:'SOL',y:'USDT',c:['c-eth','c-usde'],bs:'0.10%',fee:'0.05%'},'usdt-usdc':{x:'USDT',y:'USDC',c:['c-usde','c-usdc'],bs:'0.01%',fee:'0.01%'}};
var L={pool:'sol-usdc',shape:'spot',w:5,busy:false,lit:false};
var SHAPE={spot:'Spot',curve:'Curve',bidask:'Bid-Ask'};
var N=25;
function lpStep(k,state){ var li=document.querySelector('#lpSteps [data-k="'+k+'"]'); if(!li) return; li.className=state||''; var lis=Array.prototype.slice.call(document.querySelectorAll('#lpSteps li')), lastOk=-1; lis.forEach(function(x,i){ if(/\b(on|ok)\b/.test(x.className)) lastOk=i; }); $('lpSteps').style.setProperty('--p',lastOk<0?0:(lastOk/(lis.length-1)).toFixed(3)); }
function seg(id,key,fn){ $(id).addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b||L.busy) return; Array.prototype.forEach.call($(id).querySelectorAll('button'),function(x){ x.setAttribute('aria-pressed',x===b); }); L[key]=key==='w'?+b.dataset.w:b.dataset.s; L.lit=false; reset(); fn(); }); }
function poolShape(i){ var d=i/9; return 0.18+0.82*Math.exp(-d*d); }               /* the pool's liquidity around the price, as a shape */
function weight(i){ var r=Math.abs(i)/(L.w+0.5); if(L.shape==='curve') return Math.max(0.15,1-r*r); if(L.shape==='bidask') return 0.25+r*r; return 1; }
function lpDraw(){ var svg=$('lpBins'), SW=svg.clientWidth||520, SH=svg.clientHeight||170; var n=2*N+1, gap=Math.max(1.5,SW/n*0.24), bw=(SW-gap*(n-1))/n;
  if(svg.dataset.w!==String(SW)||svg.querySelectorAll('rect.b').length!==n){ svg.setAttribute('viewBox','0 0 '+SW+' '+SH); var h='<rect class="rng" x="0" y="0" width="0" height="'+SH+'" rx="4"/>';
    for(var k=0;k<n;k++){ var i0=k-N; h+='<rect class="b '+(i0<0?'y':i0>0?'x':'a')+'" x="'+(k*(bw+gap)).toFixed(1)+'" width="'+bw.toFixed(1)+'" rx="1.5" y="'+SH+'" height="0"/>'; }
    svg.innerHTML=h; svg.dataset.w=String(SW); svg.getBoundingClientRect(); }
  var rg=svg.querySelector('rect.rng'), k0=N-L.w, k1=N+L.w; rg.style.x=(k0*(bw+gap)-gap/2).toFixed(1)+'px'; rg.style.width=((k1-k0+1)*(bw+gap)).toFixed(1)+'px'; rg.setAttribute('height',SH);
  Array.prototype.forEach.call(svg.querySelectorAll('rect.b'),function(el,k){ var i=k-N, add=(L.lit&&Math.abs(i)<=L.w)?0.42*weight(i):0, hh=(poolShape(i)+add)/1.5*(SH-8);
    el.style.y=(SH-hh).toFixed(1)+'px'; el.style.height=hh.toFixed(1)+'px'; el.classList.toggle('mine',add>0); });
  var p=POOLS[L.pool]; $('lpPrev').textContent=SHAPE[L.shape]+' across '+(2*L.w+1)+' bins around the price, one or both of '+p.x+' and '+p.y+'.'; }
function reset(){ ['deposit','prove','verify','apply','earn'].forEach(function(k){ lpStep(k,''); }); $('lpSteps').dataset.state='idle'; $('lpRun').hidden=true; }
function pool(){ var p=POOLS[L.pool]; $('lpDots').innerHTML='<i class="'+p.c[0]+'"></i><i class="'+p.c[1]+'"></i>'; $('lpMk').textContent='Bin step '+p.bs+' · base fee '+p.fee; }
seg('lpShape','shape',lpDraw); seg('lpRange','w',lpDraw);
$('lpPool').addEventListener('change',function(){ if(L.busy) return; L.pool=this.value; L.lit=false; reset(); pool(); lpDraw(); });
$('lpGo').addEventListener('click',function(){ if(L.busy) return; L.busy=true; L.lit=false; reset(); lpDraw(); $('lpSteps').dataset.state='running'; $('lpRun').hidden=false; $('lpBar').style.width='0%';
  var seq=[['deposit','Your tokens become private notes.',18],['prove','Your browser proves the notes are yours, without showing them.',52],['verify','The proof is checked before anything moves.',70],['apply','The bins fill. On-chain, the owner is the pool\'s shared shielded position.',90],['earn','Swaps through your bins pay you; you claim privately.',100]];
  var t=0; seq.forEach(function(s,i){ setTimeout(function(){ if(i>0) lpStep(seq[i-1][0],'ok'); lpStep(s[0],'on'); $('lpMsg').textContent=s[1]; $('lpBar').style.width=s[2]+'%'; if(s[0]==='apply'){ L.lit=true; lpDraw(); } if(i===seq.length-1) setTimeout(function(){ lpStep(s[0],'ok'); $('lpSteps').dataset.state='done'; $('lpMsg').textContent='That\'s the whole flow. Do it for real in the app.'; L.busy=false; },900); }, reduce?0:t); t+=i===1?1500:900; }); });
pool(); lpDraw(); window.addEventListener('resize',function(){ clearTimeout(lpDraw.r); lpDraw.r=setTimeout(lpDraw,150); });
})();
