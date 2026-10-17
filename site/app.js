(function(){
'use strict';
const $=id=>document.getElementById(id);
/// Mode: Sandbox (default: a chain simulated in this page, practice tokens, real proofs) or Devnet (the deployment, when there is one).
const MODE=(()=>{ let q=null; try{ q=new URLSearchParams(location.search).get('mode'); }catch(e){} try{ if(q==='sandbox-dev'||q==='devnet') localStorage.setItem('veyl:mode',q); return (q||localStorage.getItem('veyl:mode'))==='sandbox-dev'?'sandbox':'devnet'; }catch(e){ return q==='sandbox-dev'?'sandbox':'devnet'; } })();
let SBE=null; if(MODE==='sandbox'&&window.Veyl&&window.Veyl.Sandbox){ try{ SBE=new Veyl.Sandbox(Object.assign({},window.VEYL_SANDBOX||{})); }catch(e){ console.error('sandbox',e); } }
const SBX=!!SBE;
const CFG=SBX?SBE.cfg:(window.VEYL_CONFIG||null); const LIVE=SBX||!!(CFG&&CFG.programs&&window.Veyl&&window.Veyl.Engine);
const E=SBX?SBE:(LIVE?new Veyl.Engine(CFG):null); const SDK=window.Veyl&&window.Veyl.SDK;
const CHAIN=SBX?'the demo':(CFG&&CFG.chainName)||'Solana';
if(SBX) document.body.classList.add('sbx');
let ME='';
const ic=(n,c)=>'<svg class="ic'+(c?' '+c:'')+'"><use href="#i-'+n+'"/></svg>';
const short=a=>a.slice(0,4)+'…'+a.slice(-4);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DASH='<span class="dim">—</span>';

/* ---------- formatting ---------- */
const SUBS='₀₁₂₃₄₅₆₇₈₉';
function tiny(n){ if(!isFinite(n)||n<=0) return '0';
  if(n>=1e6) return (n/1e6).toFixed(2)+'M'; if(n>=1e4) return n.toLocaleString('en-US',{maximumFractionDigits:0}); if(n>=1000) return n.toLocaleString('en-US',{maximumFractionDigits:2}); if(n>=1) return n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
  if(n>=0.001) return String(+n.toPrecision(4));
  const z=-Math.floor(Math.log10(n))-1; const d=String(Math.round(n*Math.pow(10,z+4))).slice(0,4).replace(/0+$/,'')||'0';
  return '0.0'+String(z).split('').map(c=>SUBS[c]).join('')+d; }
const amt=(sym,v)=>tiny(E.fmt(sym,v));
const pct=(pips)=>(pips/1e4).toFixed(pips<1000?3:2).replace(/0$/,'')+'%';
function age(ms){ const s=Math.max(0,ms/1000|0); if(s<60) return s+'s'; const m=s/60|0; if(m<60) return m+'m'; const h=m/60|0; if(h<24) return h+'h'; return (h/24|0)+'d'; }
const clean=el=>{ const c=el.value.replace(/[^0-9.]/g,'').replace(/(\..*)\./g,'$1'); if(c!==el.value) el.value=c; return parseFloat(c)||0; };

/* ---------- token marks (drawn, never fetched) ---------- */
const TK={WIF:{name:'dogwifhat',c:'#B07A4F',g:'T:W'},JTO:{name:'Jito',c:'#5B7F86',g:'T:J'},PYTH:{name:'Pyth Network',c:'#6E5A9E',g:'T:P'},RAY:{name:'Raydium',c:'#4A63A8',g:'T:R'},JUP:{name:'Jupiter',c:'#4F8F7A',g:'jup'},SOL:{name:'Solana',c:'#8E98A6',g:'sol'},USDC:{name:'USD Coin',c:'#3B5410',g:'dollar'},USDT:{name:'Tether USD',c:'#5E6B7C',g:'dollar'},BONK:{name:'Bonk',c:'#D9843B',g:'bonk'},WISP:{name:'Wisp · made-up, volatile',c:'#6F7C93',g:'wisp'}};
const hueHex=h=>{ const f=n=>{ const k=(n+h/30)%12, a=0.28*Math.min(0.42,1-0.42); return Math.round(255*(0.42-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0'); }; return '#'+f(0)+f(8)+f(4); };
const TKN={"HYPE":"Hyperliquid","TRUMP":"Official Trump","MU":"Micron (tokenized)","STONK":"STONK","cbBTC":"Coinbase Wrapped BTC","TTWO":"Take-Two (tokenized)","SKHY":"SKHY","SI":"SI","BP":"BP","SPCX":"SpaceX (tokenized)","wNEAR":"Wrapped NEAR","PUMP":"Pump.fun","MUSK":"MUSK","ZEC":"Zcash","WETH":"Wrapped Ether","MET":"Meteora","ANSEM":"ANSEM","BORDR":"BORDR","ANTFUN":"ANTFUN","DOPE":"DOPE","CARDS":"CARDS","STRK":"Starknet","baton":"baton","ORE":"Ore","HOOKED":"HOOKED","CLAUDIA":"CLAUDIA","Agency":"Agency","NVDAx":"NVIDIA xStock","MASK":"MASK","wXMR":"Wrapped Monero","DARK":"DARK","ZCAT":"ZCAT","ENA":"Ethena","DOGE":"Dogecoin","Dacity":"Dacity","PENGU":"Pudgy Penguins","LOAD":"LOAD","PEPE":"Pepe","CTM":"CTM","GOOGLx":"Alphabet xStock","WBTC":"Wrapped BTC","USDe":"Ethena USDe","USDG":"Global Dollar","JEANPHIL":"JEANPHIL","SNDK":"SanDisk (tokenized)","JupSOL":"Jupiter Staked SOL","JitoSOL":"Jito Staked SOL","CRAWL":"CRAWL","DBR":"DBR","OMNI":"OMNI","USELESS":"USELESS","JLP":"Jupiter LP","CATE":"CATE","FTR":"FTR","ANTHROPIC":"ANTHROPIC","INF":"Sanctum Infinity","swordcat":"swordcat","INJ":"Injective","JupUSD":"Jupiter USD","VEIL":"VEIL"};
const tkOf=s=>TK[s]||(TK[s]={name:TKN[s]||s,c:hueHex([...s].reduce((h,ch)=>(h*31+ch.charCodeAt(0))%360,7)),g:'T:'+s.replace(/^[a-z]+(?=[A-Z])/,'').slice(0,1).toUpperCase()});
function shade(h,f){ const n=parseInt(h.slice(1),16); let r=n>>16,g=n>>8&255,b=n&255; const t=f<0?0:255,p=Math.abs(f); r=Math.round((t-r)*p+r); g=Math.round((t-g)*p+g); b=Math.round((t-b)*p+b); return 'rgb('+r+','+g+','+b+')'; }
function glyph(g,k){ const cut=f=>{ g.save(); g.globalCompositeOperation='destination-out'; f(); g.restore(); }; const P=pts=>{ g.beginPath(); pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1])); g.closePath(); };
  if(k==='sol'){ [[30,40,98,40,86,54,18,54],[18,60,86,60,98,74,30,74],[30,80,98,80,86,94,18,94]].forEach(q=>{ P([[q[0],q[1]],[q[2],q[3]],[q[4],q[5]],[q[6],q[7]]]); g.fill(); }); }
  else if(k&&k.startsWith('T:')){ g.font='700 58px Manrope, Arial, sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(k.slice(2),64,68); }
  else if(k==='dollar'){ g.font='600 70px Manrope, Arial, sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('$',64,68); }
    else if(k==='jup'){ g.lineWidth=8; g.lineCap='round'; [[64,64,34,3.6,5.6],[64,64,22,3.4,5.8],[64,64,34,0.5,2.5],[64,64,22,0.35,2.7]].forEach(a=>{ g.beginPath(); g.arc(a[0],a[1],a[2],a[3],a[4]); g.stroke(); }); }
  else if(k==='wisp'){ g.beginPath(); g.moveTo(64,22); g.bezierCurveTo(84,48,94,62,94,78); g.bezierCurveTo(94,96,80,106,64,106); g.bezierCurveTo(48,106,34,96,34,78); g.bezierCurveTo(34,60,52,52,56,36); g.bezierCurveTo(60,48,66,52,70,58); g.bezierCurveTo(72,46,70,34,64,22); g.closePath(); g.fill(); cut(()=>{ g.beginPath(); g.ellipse(64,84,11,14,0,0,7); g.fill(); }); }
  else if(k==='bonk'){ P([[30,62],[36,22],[60,44]]); g.fill(); P([[98,62],[92,22],[68,44]]); g.fill(); g.beginPath(); g.ellipse(64,72,32,28,0,0,7); g.fill(); cut(()=>{ g.beginPath(); g.ellipse(52,66,5,5,0,0,7); g.ellipse(76,66,5,5,0,0,7); g.ellipse(64,84,7,5,0,0,7); g.fill(); }); }
  else if(k==='bridge'){ g.lineWidth=9; g.lineCap='round'; g.beginPath(); g.arc(64,86,34,Math.PI,0); g.stroke(); g.beginPath(); g.moveTo(22,86); g.lineTo(106,86); g.stroke(); }
  else { g.beginPath(); g.arc(64,64,22,0,7); g.fill(); } }
const LOGO={};
function logo(sym){ if(LOGO[sym]) return LOGO[sym]; const t=tkOf(sym), S=128, c=document.createElement('canvas'); c.width=c.height=S; const g=c.getContext('2d'); if(!g) return '';
  const bg=g.createLinearGradient(0,0,S*0.4,S); bg.addColorStop(0,shade(t.c,0.15)); bg.addColorStop(1,shade(t.c,-0.2)); g.fillStyle=bg; g.beginPath(); g.arc(64,64,64,0,7); g.fill();
  const gl=document.createElement('canvas'); gl.width=gl.height=S; const gg=gl.getContext('2d'); gg.fillStyle=gg.strokeStyle='#fff'; glyph(gg,t.g); g.drawImage(gl,0,0);
  try{ return LOGO[sym]=c.toDataURL('image/png'); }catch(e){ return ''; } }
const tokImg=(sym,cls)=>'<img class="'+(cls===undefined?'tok':cls)+'" src="'+logo(sym)+'" alt="">';
const pairImg=p=>'<span class="pairlogo">'+tokImg(p.x,'')+tokImg(p.y,'')+'</span>';

/* ---------- pools: the listed set; live values only from the chain ---------- */
const LAUNCH=[{id:'sol-usdc',x:'SOL',y:'USDC',bs:10,base:0.05},{id:'sol-usdt',x:'SOL',y:'USDT',bs:10,base:0.05},{id:'usdt-usdc',x:'USDT',y:'USDC',bs:1,base:0.01},{id:'jup-sol',x:'JUP',y:'SOL',bs:20,base:0.2},{id:'jup-usdc',x:'JUP',y:'USDC',bs:20,base:0.2},{id:'bonk-sol',x:'BONK',y:'SOL',bs:50,base:0.5},{id:'bonk-usdc',x:'BONK',y:'USDC',bs:50,base:0.5},{id:'wif-sol',x:'WIF',y:'SOL',bs:50,base:0.5},{id:'wif-usdc',x:'WIF',y:'USDC',bs:50,base:0.5},{id:'jto-sol',x:'JTO',y:'SOL',bs:20,base:0.2},{id:'pyth-usdc',x:'PYTH',y:'USDC',bs:20,base:0.2},{id:'ray-sol',x:'RAY',y:'SOL',bs:20,base:0.2},{id:'hype-sol',x:'HYPE',y:'SOL',bs:20,base:0.2},{id:'trump-usdc',x:'TRUMP',y:'USDC',bs:80,base:1.0},{id:'mu-usdc',x:'MU',y:'USDC',bs:80,base:1.0},{id:'stonk-sol',x:'STONK',y:'SOL',bs:80,base:1.0},{id:'cbbtc-sol',x:'cbBTC',y:'SOL',bs:20,base:0.2},{id:'ttwo-usdc',x:'TTWO',y:'USDC',bs:80,base:1.0},{id:'cbbtc-usdc',x:'cbBTC',y:'USDC',bs:20,base:0.2},{id:'skhy-usdc',x:'SKHY',y:'USDC',bs:80,base:1.0},{id:'si-sol',x:'SI',y:'SOL',bs:80,base:1.0},{id:'bp-usdc',x:'BP',y:'USDC',bs:80,base:1.0},{id:'spcx-sol',x:'SPCX',y:'SOL',bs:80,base:1.0},{id:'wnear-usdc',x:'wNEAR',y:'USDC',bs:20,base:0.2},{id:'pump-usdc',x:'PUMP',y:'USDC',bs:20,base:0.2},{id:'musk-usdc',x:'MUSK',y:'USDC',bs:80,base:1.0},{id:'pump-sol',x:'PUMP',y:'SOL',bs:20,base:0.2},{id:'zec-sol',x:'ZEC',y:'SOL',bs:20,base:0.2},{id:'weth-sol',x:'WETH',y:'SOL',bs:20,base:0.2},{id:'met-sol',x:'MET',y:'SOL',bs:20,base:0.2},{id:'ansem-sol',x:'ANSEM',y:'SOL',bs:80,base:1.0},{id:'bordr-sol',x:'BORDR',y:'SOL',bs:80,base:1.0},{id:'antfun-usdt',x:'ANTFUN',y:'USDT',bs:80,base:1.0},{id:'dope-sol',x:'DOPE',y:'SOL',bs:80,base:1.0},{id:'cards-usdc',x:'CARDS',y:'USDC',bs:80,base:1.0},{id:'strk-usdc',x:'STRK',y:'USDC',bs:20,base:0.2},{id:'baton-sol',x:'baton',y:'SOL',bs:80,base:1.0},{id:'wnear-sol',x:'wNEAR',y:'SOL',bs:20,base:0.2},{id:'ttwo-sol',x:'TTWO',y:'SOL',bs:80,base:1.0},{id:'ore-sol',x:'ORE',y:'SOL',bs:20,base:0.2},{id:'hooked-sol',x:'HOOKED',y:'SOL',bs:80,base:1.0},{id:'claudia-sol',x:'CLAUDIA',y:'SOL',bs:80,base:1.0},{id:'agency-sol',x:'Agency',y:'SOL',bs:80,base:1.0},{id:'nvdax-sol',x:'NVDAx',y:'SOL',bs:80,base:1.0},{id:'mask-sol',x:'MASK',y:'SOL',bs:80,base:1.0},{id:'wxmr-usdc',x:'wXMR',y:'USDC',bs:20,base:0.2},{id:'dark-sol',x:'DARK',y:'SOL',bs:80,base:1.0},{id:'zcat-sol',x:'ZCAT',y:'SOL',bs:80,base:1.0},{id:'ena-usdc',x:'ENA',y:'USDC',bs:20,base:0.2},{id:'doge-sol',x:'DOGE',y:'SOL',bs:20,base:0.2},{id:'dacity-sol',x:'Dacity',y:'SOL',bs:80,base:1.0},{id:'pengu-usdc',x:'PENGU',y:'USDC',bs:80,base:1.0},{id:'load-sol',x:'LOAD',y:'SOL',bs:80,base:1.0},{id:'pepe-sol',x:'PEPE',y:'SOL',bs:80,base:1.0},{id:'ctm-sol',x:'CTM',y:'SOL',bs:80,base:1.0},{id:'googlx-sol',x:'GOOGLx',y:'SOL',bs:80,base:1.0},{id:'wbtc-usdc',x:'WBTC',y:'USDC',bs:20,base:0.2},{id:'usde-usdg',x:'USDe',y:'USDG',bs:1,base:0.01},{id:'jeanphil-sol',x:'JEANPHIL',y:'SOL',bs:80,base:1.0},{id:'cards-sol',x:'CARDS',y:'SOL',bs:80,base:1.0},{id:'sndk-sol',x:'SNDK',y:'SOL',bs:80,base:1.0},{id:'bp-sol',x:'BP',y:'SOL',bs:80,base:1.0},{id:'spcx-usdc',x:'SPCX',y:'USDC',bs:80,base:1.0},{id:'jupsol-jitosol',x:'JupSOL',y:'JitoSOL',bs:1,base:0.01},{id:'crawl-sol',x:'CRAWL',y:'SOL',bs:80,base:1.0},{id:'dbr-usdc',x:'DBR',y:'USDC',bs:80,base:1.0},{id:'omni-sol',x:'OMNI',y:'SOL',bs:80,base:1.0},{id:'useless-sol',x:'USELESS',y:'SOL',bs:80,base:1.0},{id:'jlp-jitosol',x:'JLP',y:'JitoSOL',bs:20,base:0.2},{id:'cate-usdc',x:'CATE',y:'USDC',bs:80,base:1.0},{id:'strk-sol',x:'STRK',y:'SOL',bs:20,base:0.2},{id:'ftr-sol',x:'FTR',y:'SOL',bs:80,base:1.0},{id:'anthropic-sol',x:'ANTHROPIC',y:'SOL',bs:80,base:1.0},{id:'hype-usdc',x:'HYPE',y:'USDC',bs:20,base:0.2},{id:'jupsol-inf',x:'JupSOL',y:'INF',bs:1,base:0.01},{id:'si-usdc',x:'SI',y:'USDC',bs:80,base:1.0},{id:'wbtc-sol',x:'WBTC',y:'SOL',bs:20,base:0.2},{id:'swordcat-sol',x:'swordcat',y:'SOL',bs:80,base:1.0},{id:'inj-usdc',x:'INJ',y:'USDC',bs:20,base:0.2},{id:'inf-sol',x:'INF',y:'SOL',bs:1,base:0.01},{id:'bordr-jupusd',x:'BORDR',y:'JupUSD',bs:80,base:1.0},{id:'ansem-usdc',x:'ANSEM',y:'USDC',bs:80,base:1.0},{id:'veil-sol',x:'VEIL',y:'SOL',bs:80,base:1.0}];
const POOLS=(LIVE?CFG.binPools:LAUNCH).map(b=>({id:b.id,x:b.x,y:b.y,bs:b.bs,base:b.base,address:b.address||null,st:null,err:null}));
const byId=id=>POOLS.find(p=>p.id===id);
const byAddr=a=>POOLS.find(p=>p.address===a);
const refUsd=s=>usdOf(s);
const usd$=v=>v==null||!isFinite(v)?DASH:'$'+tiny(v);
/// Live market prices (Pyth, then Jupiter; no API key): the engine's, or a standalone one when Devnet is not deployed.
const MKT=E?E.market:(window.Veyl&&window.Veyl.Market?new Veyl.Market():null);
const mktUsd=s=>MKT?MKT.usd(s):null;
/// Dollars per token everywhere: Sandbox: its market-anchored value. On chain: the market, or through a pool's on-chain price.
let U={}; const usdOf=s=>SBX?E.usdOf(s):(U[s]!=null?U[s]:mktUsd(s));
const hp=(p,id)=>E.humanPrice(p.st,id);
const liqY=p=>p.st?E.fmt(p.x,p.st.reserves.x)*hp(p,p.st.active)+E.fmt(p.y,p.st.reserves.y):0;
const feesY=p=>p.st?E.fmt(p.x,p.st.totalFees.x)*hp(p,p.st.active)+E.fmt(p.y,p.st.totalFees.y):0;

/* ---------- state ---------- */
const LS={ get:(k,d)=>{ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } }, set:(k,v)=>{ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} } };
/// Pools table columns (persisted). Interval for volume, fees and APR (persisted).
const COLS=[['chart','Chart'],['age','Age'],['price','Price'],['apr','APR'],['fpt','Fees / TVL'],['liq','Liquidity'],['vol','Volume'],['fee','Fee now'],['bs','Bin step']];
const COLS_DEF=['chart','age','price','apr','fpt','liq','vol','fee'];
const IVN={3600:'1h',21600:'6h',86400:'24h'};
const STABLE=new Set(['USDC','USDT']), MAJOR=new Set(['SOL','USDC','USDT']);
const catOf=p=>STABLE.has(p.x)&&STABLE.has(p.y)?'stables':MAJOR.has(p.x)&&MAJOR.has(p.y)?'majors':'volatile';
const CATN={majors:'Majors',stables:'Stables',volatile:'Volatile'};
const S={page:'pools',cur:POOLS[0].id,tab:'add',src:'priv',side:'both',shape:'spot',lo:-5,hi:5,zx:false,ord:'buy',ordPrice:'',pswX:true,
  tokF:'all',cat:'all',flt:{base:'all',bs:'all'},cols:LS.get('veyl:cols',COLS_DEF),iv:LS.get('veyl:iv',86400),sort:'liq',sheet:false,hide:false,busy:false,loading:LIVE,rpc:LIVE?'checking':'none',activity:[],swMode:null};
/// Sealed batches: the current pool's batch state (from the relayer), when it was read, and this account's sealed swaps.
const SEAL={st:null,pool:null,at:0,mine:[]};
const PI={}, OI={}; const BAL={priv:{},pub:{}};
const save=()=>{ if(LIVE){ E.store.data.activity=S.activity.slice(0,300); E.store.save(); } };
const logAct=a=>{ a.ts=Date.now(); S.activity.unshift(a); save(); };

/* ---------- chain reads ---------- */
async function loadPool(p,span){ if(!LIVE||!p.address) return; try{ p.st=await E.poolState(p.address,span||1); p.err=null; }catch(e){ p.err=String(e&&e.message||e); } }
async function loadPools(){ await Promise.all(POOLS.map(p=>loadPool(p,p.id===S.cur&&S.page==='pool'?35:1))); }
async function loadBalances(){ if(!LIVE) return; try{ await E.refreshNotes(); }catch(e){}
  for(const k of Object.keys(E.tokens)){ try{ BAL.priv[k]=E.fmt(k,E.privateBalance(k)); if(E.account) BAL.pub[k]=E.fmt(k,await E.publicBalance(k)); }catch(e){} } }
async function loadPositions(){ if(!LIVE) return; for(const q of E.myPositions()){ try{ PI[q.id]=await E.positionInfo(q); }catch(e){ PI[q.id]={err:String(e.message||e)}; } }
  for(const o of E.myOrders()){ if(o.closed) continue; try{ OI[o.id]=await E.orderInfo(o); }catch(e){ OI[o.id]={err:String(e.message||e)}; } } }
async function refreshAll(){ if(!LIVE) return; document.body.dataset.loading='1'; try{ await loadBalances(); await loadPositions(); } finally{ delete document.body.dataset.loading; } render(); }
const bal=(src,sym)=>BAL[src][sym]||0;
/// Token units without the engine (the demonstration has none): the sealed panel's figures.
const fmtU=(sym,v)=>E?E.fmt(sym,v):Number(v)/10**(({USDC:6,USDT:6})[sym]||9);
async function loadSealed(p){ if(!LIVE){ SEAL.st=null; return; } if(!p||!p.address) return; try{ const st=await E.sealedState(p); SEAL.st=st; SEAL.pool=p.id; SEAL.at=Date.now(); }catch(e){ SEAL.st={enabled:false,err:String(e.message||e)}; SEAL.pool=p.id; }
  try{ SEAL.mine=await E.mySealedSwaps(); }catch(e){} }
/// Milliseconds until the current batch closes (slots left at the last read, minus the time since).
function sealLeft(){ const st=SEAL.st; if(!st||!st.batch) return 0; return Math.max(0,(Number(st.batch.endSlot)-Number(st.slot))*(st.slotMs||400)-(Date.now()-SEAL.at)); }
const mmss=ms=>{ const t=Math.ceil(ms/1000), m=Math.floor(t/60), s=t%60; return m+':'+String(s).padStart(2,'0'); };

/* ---------- toasts, dialogs, action runner ---------- */
function toast(msg,icon='check',ms=3800){ const el=document.createElement('div'); el.className='toast'; el.innerHTML=ic(icon)+'<span>'+msg+'</span>'; $('toasts').appendChild(el); setTimeout(()=>el.remove(),ms); while($('toasts').children.length>2) $('toasts').firstChild.remove(); }
let lastFocus=null;
function openModal(html){ if($('modal').hidden) lastFocus=document.activeElement; $('dlgBody').innerHTML=html; $('modal').hidden=false; $('dlgX').hidden=false; const f=$('dlgBody').querySelector('input,button'); if(f&&matchMedia('(min-width:900px)').matches) f.focus(); else $('dlgX').focus(); }
function closeModal(){ if(S.busy) return; $('modal').hidden=true; if(lastFocus&&lastFocus.focus) lastFocus.focus(); }
$('dlgX').onclick=closeModal;
$('modal').addEventListener('pointerdown',e=>{ if(e.target===$('modal')) closeModal(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ if(!$('modal').hidden) closeModal(); else if(S.sheet) sheet(false); else if($('side').classList.contains('open')) drawer(false); ['acctPop','modePop','colPop','fltPop','mkFltPop'].forEach(id=>{ const el=$(id); if(el&&!el.hidden){ el.hidden=true; const b=document.querySelector('[aria-controls="'+id+'"]'); if(b) b.setAttribute('aria-expanded','false'); } }); } });
const STEPS=SBX?{
  proof:['Building a zero-knowledge proof','Verified, then the relayer submits it','Applied'],
  sign:['Signing with the position key','Relayer submits it','Applied'],
  wallet:['Your wallet signs','Applying it','Applied']}:{
  proof:['Building a zero-knowledge proof','Relayer submits it','Confirmed on '+CHAIN],
  sign:['Signing with the position key','Relayer submits it','Confirmed on '+CHAIN],
  wallet:['Confirm in your wallet','Sending','Confirmed on '+CHAIN]};
const SUBT={proof:['On this device. It shows the funds are yours without showing which notes. This can take a minute.',SBX?'Checked with snarkjs against the circuit\'s verifying key before anything is applied.':'Your wallet never touches this transaction.',''],sign:['The one-time key that owns the position signs on this device.','Your wallet never touches this transaction.',''],wallet:['Your wallet shows what it is signing.','',''] };
/// Runs one real action. The steps follow the engine's own progress messages; nothing here is timed or simulated.
function runAct(title,kind,fn,onDone){
  const labels=STEPS[kind]; S.busy=true; if($('modal').hidden){ lastFocus=document.activeElement; $('modal').hidden=false; } $('dlgX').hidden=true;
  $('dlgBody').innerHTML='<h3 id="dlgTitle">'+title+'</h3><ol class="steps" id="stepList">'+labels.map((l,i)=>'<li id="st'+i+'"><span class="sc"></span><div><b>'+l+'</b><small id="sub'+i+'">'+SUBT[kind][i]+'</small>'+(kind==='proof'&&i===0?'<div class="ind"><i></i></div>':'')+'</div></li>').join('')+'</ol>';
  let i=0; $('st0').className='on';
  const to=k=>{ while(i<k&&i<labels.length-1){ $('st'+i).className='ok'; i++; $('st'+i).className='on'; } };
  E.onLog=m=>{ if(/Relayer submits/.test(m)) to(1); if(/^Sending/.test(m)) to(1); if(SBX&&/Applying|wallet signs/.test(m)&&kind==='wallet') to(1); const el=$('sub'+i); if(el&&!/Relayer submits/.test(m)) el.textContent=m; };
  const off=SBX?proofWatch(()=>i):null; const end=()=>{ if(off) off(); };
  fn().then(res=>{ end(); for(let k=0;k<labels.length;k++) $('st'+k).className='ok'; S.busy=false; $('dlgX').hidden=false; E.onLog=()=>{}; onDone(res); })
    .catch(e=>{ end(); S.busy=false; $('dlgX').hidden=false; E.onLog=()=>{}; if($('st'+i)) $('st'+i).className='no'; const m=(e&&(e.shortMessage||e.message))||String(e);
      $('dlgBody').insertAdjacentHTML('beforeend','<p class="err" id="actErr">'+esc(m.length>300?m.slice(0,300)+'…':m)+'</p><p class="hint">'+ic('alert')+'<span>Nothing was taken unless a step above shows confirmed. Notes created for this action stay on this device.</span></p><button class="btn ghost" type="button" id="errClose">Close</button>'); $('errClose').onclick=closeModal; });
}
/// Sandbox: the proving progress inside the running step (download, then proving against the usual time), and the verifier.
function proofWatch(stepNow){ let tick=null, cur=null; const sub=()=>$('sub'+stepNow());
  const show=()=>{ const el=sub(); if(!el||!cur) return; const pr=el.parentNode.querySelector('.ind'); const s=((Date.now()-cur.t0)/1000);
    if(cur.stage==='fetch'){ const t=cur.total||0, l=cur.loaded||0; el.textContent='Downloading the '+cur.circuit+' proving key: '+(l/1e6).toFixed(1)+(t?' of '+(t/1e6).toFixed(0):'')+' MB. Once per visit.'; if(pr&&t){ pr.classList.add('det'); pr.firstChild.style.width=Math.min(100,l/t*100).toFixed(0)+'%'; } }
    else { const ex=(cur.expect||6000)/1000; el.textContent='Proving the '+cur.circuit+' circuit on this device: '+s.toFixed(0)+' s'+(ex?' (usually about '+Math.max(1,Math.round(ex))+' s here)':'')+'.'; if(pr){ pr.classList.remove('det'); pr.firstChild.style.width=''; } } };
  const offE=E.on(ev=>{ if(ev.type==='proving'){ if(ev.proving){ cur=Object.assign(cur||{},ev.proving); if(!cur.t0) cur.t0=Date.now(); if(!tick) tick=setInterval(show,500); show(); } else { cur=null; clearInterval(tick); tick=null; } }
    if(ev.type==='verified'){ const el=sub(); if(el) el.textContent=ev.ok?'Proof verified in '+ev.verifyMs+' ms (snarkjs, '+ev.circuit+' verifying key).':'The proof did not verify.'; } });
  return ()=>{ offE(); clearInterval(tick); }; }
function receiptHtml(tx){ if(!SBX||!tx) return ''; const r=E.receipt(tx); if(!r) return '';
  const pr=(r.proofs||[]).map(p=>'<div class="vrf">'+ic('check')+'<span><b>Proof verified</b> · '+esc(p.circuit)+' circuit · made in '+(p.ms/1000).toFixed(1)+' s on this device · verified in '+p.verifyMs+' ms against its verifying key</span></div>').join('');
  const rows=l=>(l||[]).map(x=>'<div><dt>'+esc(x[0])+'</dt><dd>'+esc(x[1])+'</dd></div>').join('');
  return pr+(r.seen?'<details class="cw" open><summary>What the chain would see</summary><div class="cwg"><div class="pb"><b>Public</b><dl>'+rows(r.seen.pub)+'</dl></div><div class="hd"><b>Hidden</b><dl>'+(rows(r.seen.hidden)||'<div><dd>Nothing</dd></div>')+'</dl></div></div></details>':''); }
const txLink=tx=>(tx&&String(tx).startsWith('sandbox #'))?'':tx?'<code>tx '+esc(tx.slice(0,10))+'…'+esc(tx.slice(-6))+(CFG.explorer?' · <a href="'+esc(CFG.explorer)+'/tx/'+esc(tx)+esc(CFG.explorerSuffix||'')+'" target="_blank" rel="noopener">view</a>':'')+'</code>':'';
function doneBlock(title,sub,tx){ $('dlgBody').innerHTML='<div class="done"><span class="okc">'+ic('check')+'</span><b id="dlgTitle">'+title+'</b><p>'+sub+'</p>'+txLink(tx)+receiptHtml(tx)+'</div><button class="btn" type="button" id="doneBtn">Done</button>'; $('doneBtn').onclick=closeModal; }
/// The reason an action cannot run right now, or '' when it can.
function blocker(src){ if(!LIVE) return 'Not connected'; if(S.rpc==='down') return 'Chain not answering'; if(src!=='priv'&&!E.account) return 'Connect a wallet'; return ''; }

/* ---------- navigation ---------- */
const PAGES=['pools','pool','swap','home','activity','sealed','markets','privacy'];
function go(p,keepHash){ S.page=p; sheet(false); PAGES.forEach(x=>$('pg-'+x).hidden=x!==p); document.body.classList.toggle('on-pool',p==='pool');
  const nk=p==='pool'?'pools':p; document.querySelectorAll('.bnav [data-go],.topnav [data-go],.side-nav [data-go]').forEach(b=>{ if(b.dataset.go===nk&&!b.dataset.nav) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  $('acctPop').hidden=true; if(!keepHash){ const h=p==='pool'?'pool-'+S.cur:p==='home'?'portfolio':p; try{ history.replaceState(null,'','#'+h); }catch(e){} }
  render(); window.scrollTo({top:0}); if(p==='pool'&&!LIVE){ loadSealed(byId(S.cur)); render(); } if(p==='pool'&&LIVE){ const cp=byId(S.cur); loadPool(cp,35).then(()=>{ if(S.page==='pool') render(); }); loadSealed(cp).then(()=>{ if(S.page==='pool'&&cur()===cp) render();  }); } if(p==='home'&&LIVE&&!S.loading&&!S.busy) refreshAll(); if(p==='sealed'&&LIVE) loadSealedAll().then(()=>{ if(S.page==='sealed') renderSealedPage(); }); if(p==='markets') loadMarkets(); if(p==='privacy') loadPrivacy(); }
document.addEventListener('click',e=>{ const g=e.target.closest('[data-go]'); if(g){ if(!$('modal').hidden&&!S.busy) closeModal(); go(g.dataset.go); } });
function openPool(id){ S.cur=id; ['amtX','amtY','zapAmt','ordAmt','pswIn'].forEach(k=>$(k).value=''); S.ordPrice=''; $('ordPrice').value=''; go('pool'); }
document.addEventListener('click',e=>{ const r=e.target.closest('[data-pool]'); if(r){ if(!$('modal').hidden&&!S.busy) closeModal(); openPool(r.dataset.pool); } });
$('backBtn').onclick=()=>go('pools');

/* ---------- state line under the header ---------- */
function renderBanner(){
  const el=$('stateBanner'); let h='';
  if(SBX){ const sb=E.store.data.sandbox||{}; if(false) h='<div class="sbxline">'+ic('bolt')+'<span></span><button class="btn" type="button" data-faucet>Top up</button><button class="ib" type="button" id="sbxX" aria-label="Dismiss" style="width:32px;height:32px">'+ic('x','sm')+'</button></div>'; el.innerHTML=h; el.hidden=!h; if($('sbxX')) $('sbxX').onclick=()=>{ sb.seen=Date.now(); E.store.data.sandbox=sb; E.store.save(); renderBanner(); }; return; }
  if(!LIVE) h='';
  else if(S.rpc==='down') h='<div class="banner bad">'+ic('alert')+'<div><b>'+esc(CHAIN)+' is not answering</b>The RPC in this site\'s configuration did not respond. Nothing can be read or sent until it does.<br><button class="btn ghost" type="button" id="retryRpc">Try again</button></div></div>';
  else if(!E.account) h='<div class="banner">'+ic('key')+'<div><b>No wallet needed</b>Fund a deposit address from any wallet or exchange, or connect a wallet. Either way, everything after the deposit is private.<br><button class="btn" type="button" id="bannerConnect">Get started</button></div></div>';
  el.innerHTML=h; el.hidden=!h;
  if($('retryRpc')) $('retryRpc').onclick=()=>checkRpc(true);
  if($('bannerConnect')) $('bannerConnect').onclick=()=>$('acctBtn').click();
}
async function checkRpc(again){ if(!LIVE) return; if(again){ S.rpc='checking'; renderBanner(); } try{ await E.ping(); S.rpc='ok'; $('netLbl').className='net'; }catch(e){ S.rpc='down'; $('netLbl').className='net bad'; } renderBanner(); if(S.rpc==='ok'&&again){ await loadPools(); await refreshAll(); } }

/* ---------- pools list ---------- */
/// Live figures for a pool over the interval: from the sandbox's state; on Devnet only what the chain records (else a dash).
function pstat(p){ if(!p.address||!p.st) return null; if(SBX){ try{ return E.poolStats(p.address,S.iv); }catch(e){ return null; } } return p.cs&&p.cs.iv===S.iv?p.cs.v:null; }
/// Devnet / Local: each pool's figures from the chain (its transactions' Swapped events, its bins and vaults) and the market.
let csBusy=false; async function loadChainStats(){ if(!LIVE||SBX||csBusy) return; csBusy=true; loadChainStats.at=Date.now(); try{ U=E.usdMap(POOLS.map(p=>p.st));
    for(const p of POOLS){ if(!p.address||!p.st) continue; try{ const st10=await E.poolState(p.address,10); p.cs={iv:S.iv,v:await E.poolStatsChain(p.address,S.iv,st10,U)}; }catch(e){ p.cs=null; } } } finally{ csBusy=false; } }
function spark(vals,cls){ if(!vals||vals.length<2) return '<span class="dim">—</span>'; const W=100,H=28, mn=Math.min(...vals), mx=Math.max(...vals), r=(mx-mn)||mx*1e-4||1;
  const pts=vals.map((v,i)=>[i/(vals.length-1)*W, H-2-(v-mn)/r*(H-4)]); const d='M'+pts.map(q=>q[0].toFixed(1)+','+q[1].toFixed(1)).join('L'); const up=vals[vals.length-1]>=vals[0], col=up?'var(--good)':'var(--bad)';
  return '<svg class="spk'+(cls?' '+cls:'')+'" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" aria-hidden="true"><path class="ar" d="'+d+'L'+W+','+H+'L0,'+H+'Z" fill="'+col+'"/><path d="'+d+'" stroke="'+col+'"/></svg>'; }
const chg=c=>c==null?'':'<span class="'+(c>=0.005?'up':c<=-0.005?'dn':'dim')+'">'+(c>=0?'+':'')+c.toFixed(2)+'%</span>';
const ageS=sec=>{ if(sec==null) return DASH; const m=sec/60|0, h=m/60|0, d=h/24|0; return d?d+'d '+(h%24)+'h':h?h+'h '+(m%60)+'m':m+'m'; };
const pctS=v=>v==null?DASH:(v>=100?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2))+'%';
function poolFilters(){ const toks=[...new Set(POOLS.flatMap(p=>[p.x,p.y]))], bases=[...new Set(POOLS.map(p=>p.base))].sort((a,b)=>a-b), bss=[...new Set(POOLS.map(p=>p.bs))].sort((a,b)=>a-b); return {toks,bases,bss}; }
function renderPools(){
  $('poolTools').hidden=true;
  const F=poolFilters(), ivn=IVN[S.iv]||'24h';
  document.querySelectorAll('#ivSeg [data-iv]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.iv===S.iv)));
  $('tokChips').innerHTML=['all','majors','stables','volatile'].map(c=>'<button class="chip" type="button" data-cat="'+c+'" aria-pressed="'+(S.cat===c)+'">'+(c==='all'?'All pools':CATN[c])+'</button>').join('')+'<span class="div" aria-hidden="true"></span>'+
    ['all',...F.toks].map(t=>'<button class="chip" type="button" data-tok="'+t+'" aria-pressed="'+(S.tokF===t)+'">'+(t==='all'?'All tokens':tokImg(t,'tok" style="width:18px;height:18px')+t)+'</button>').join('');
  $('poolSort').value=S.sort;
  const nf=(S.flt.base!=='all')+(S.flt.bs!=='all')+(S.tokF!=='all'); $('fltN').textContent=nf?String(nf):'';
  const q=($('poolQ').value||'').trim().toLowerCase(); let l=POOLS.slice();
  if(S.cat!=='all') l=l.filter(p=>catOf(p)===S.cat);
  if(S.tokF!=='all') l=l.filter(p=>p.x===S.tokF||p.y===S.tokF);
  if(S.flt.base!=='all') l=l.filter(p=>String(p.base)===String(S.flt.base));
  if(S.flt.bs!=='all') l=l.filter(p=>String(p.bs)===String(S.flt.bs));
  if(q) l=l.filter(p=>(p.x+'-'+p.y+' '+p.x+'/'+p.y+' '+p.x+p.y+' '+tkOf(p.x).name+' '+tkOf(p.y).name).toLowerCase().includes(q.replace('–','-')));
  const ST={}; l.forEach(p=>{ ST[p.id]=pstat(p); });
  const usd=(p,v)=>{ const r=refUsd(p.y); return r==null?v:v*r; };
  const n=v=>v==null?-1:v;
  const key={score:p=>ST[p.id]?ST[p.id].score:n(null),age:p=>ST[p.id]?ST[p.id].ageSec:-1,liq:p=>ST[p.id]?ST[p.id].tvlUsd:usd(p,liqY(p)),vol:p=>ST[p.id]?ST[p.id].volumeUsd:-1,fpt:p=>ST[p.id]?ST[p.id].feeTvlPct:-1,apr:p=>ST[p.id]?ST[p.id].aprPct:-1,fee:p=>p.st?p.st.fee:p.base*1e4,bs:p=>p.bs,fees:p=>usd(p,feesY(p)),name:p=>0};
  const sk=key[S.sort]||key.liq; if(S.sort==='name') l.sort((a,b)=>(a.x+a.y).localeCompare(b.x+b.y)); else l.sort((a,b)=>sk(b)-sk(a));
  const cols=SBX?COLS.filter(c=>['price','liq','fee'].includes(c[0])):!LIVE?COLS.filter(c=>['fee'].includes(c[0])):COLS.filter(c=>S.cols.includes(c[0]));
  const thSort={age:'age',apr:'apr',fpt:'fpt',liq:'liq',vol:'vol',fee:'fee',bs:'bs'};
  const lbl=k=>(!LIVE&&k==='fee')?'Base fee':({apr:'APR '+ivn,fpt:'Fees / TVL '+ivn,vol:'Volume '+ivn,chart:'Price '+ivn}[k]||COLS.find(c=>c[0]===k)[1]);
  $('poolHead').innerHTML='<tr><th>Pool</th>'+cols.map(c=>'<th'+(thSort[c[0]]?' class="sortable" data-sort="'+thSort[c[0]]+'"'+(S.sort===thSort[c[0]]?' aria-sort="descending"':''):'')+' data-col="'+c[0]+'">'+lbl(c[0])+'</th>').join('')+'</tr>';
  const cell=(p,k)=>{ const st=p.st, ps=ST[p.id]; const load=LIVE&&!st&&!p.err; const skl='<span class="skel" style="width:56px;margin-left:auto"></span>'; const w=x=>st?x:load?skl:DASH;
    switch(k){
      case 'chart': return ps?spark(ps.spark)+'<span class="sub">'+chg(ps.change)+'</span>':w(DASH);
      case 'age': return ps?ageS(ps.ageSec):w(DASH);
      case 'apr': return ps?pctS(ps.aprPct):w(DASH);
      case 'fpt': return ps?pctS(ps.feeTvlPct):w(DASH);
      case 'liq': if(SBX&&st){ const r=refUsd(p.y); return r!=null?usd$(liqY(p)*r):tiny(liqY(p))+' <span class="dim">'+p.y+'</span>'; } return ps&&ps.tvlUsd!=null?usd$(ps.tvlUsd)+(ps.depth!=null?'<span class="sub">'+Math.round(ps.depth*100)+'% within ±10 bins</span>':''):w(st?tiny(liqY(p))+' <span class="dim">'+p.y+'</span>':'');
      case 'vol': return ps?usd$(ps.volumeUsd)+'<span class="sub">'+ps.swaps+' swaps</span>':w(DASH);
      case 'fee': if(!LIVE) return p.base.toFixed(2)+'%'; return w(st?pct(st.fee)+'<span class="sub">base '+p.base.toFixed(2)+'%</span>':'');
      case 'price': return w(st?tiny(hp(p,st.active))+' <span class="dim">'+p.y+'</span>':'');
      case 'bs': return (p.bs/100).toFixed(2)+'%';
    } return DASH; };
  $('poolRows').innerHTML=l.map(p=>'<tr data-pool="'+p.id+'" tabindex="0"><td><span class="pp">'+pairImg(p)+'<span><b>'+p.x+'–'+p.y+'</b><small><span class="pill priv catp">'+ic('lock')+'Private</span> <span class="dim" style="font-size:11.5px">Bin '+(p.bs/100).toFixed(2)+'%</span></small></span></span></td>'+cols.map(c=>'<td data-col="'+c[0]+'">'+cell(p,c[0])+'</td>').join('')+'</tr>').join('')
    ||'<tr><td colspan="'+(cols.length+1)+'" class="empty" style="text-align:center">No pools match.</td></tr>';
  $('poolCards').innerHTML=l.map(p=>{ const ps=ST[p.id]; return '<button class="pcard" type="button" data-pool="'+p.id+'"><span class="t">'+pairImg(p)+'<span class="mid"><b style="font-weight:500">'+p.x+'–'+p.y+'</b><br><small class="dim" style="font-size:12px">Bin '+(p.bs/100).toFixed(2)+'%'+(ps&&!SBX?' · '+chg(ps.change):'')+'</small></span>'+(ps&&!SBX?spark(ps.spark):'<span class="pill priv">'+ic('lock')+'Private</span>')+'</span><dl><div><dt>Price</dt><dd>'+(p.st?tiny(hp(p,p.st.active)):DASH)+'</dd></div><div><dt>Liquidity</dt><dd>'+cell(p,'liq')+'</dd></div>'+(SBX?'<div><dt>Fee</dt><dd>'+(p.st?pct(p.st.fee):DASH)+'</dd></div>':'<div><dt>Volume '+ivn+'</dt><dd>'+(ps?usd$(ps.volumeUsd):DASH)+'</dd></div><div><dt>APR '+ivn+'</dt><dd>'+(ps?pctS(ps.aprPct):DASH)+'</dd></div>')+'</dl></button>'; }).join('')||'<div class="empty">No pools match.</div>';
  $('poolCount').innerHTML='<i></i>'+l.length+' of '+POOLS.length+' pools · '+(SBX?(MKT&&MKT.at?'prices from the live market ('+esc(MKT.label('SOL'))+')':'prices as of '+esc(E.marketInfo().asOf)):LIVE?'read from '+esc(CHAIN)+': bins, vaults and each pool\'s Swapped events · dollar values at market prices'+(MKT&&MKT.at?' ('+esc(MKT.label('SOL'))+')':' (market price unavailable)'):'every pool is private');
}
function colPop(){ $('colPop').innerHTML='<span class="h">Columns</span>'+COLS.map(c=>'<label><input type="checkbox" data-col="'+c[0]+'"'+(S.cols.includes(c[0])?' checked':'')+'>'+c[1]+'</label>').join('')+'<div class="foot"><button type="button" data-colreset>Default columns</button></div>'; }
function fltPop(){ const F=poolFilters(); const grp=(k,vals,fmt)=>'<div class="chips">'+['all',...vals].map(v=>'<button class="chip" type="button" data-f="'+k+'" data-v="'+v+'" aria-pressed="'+(String(S.flt[k])===String(v))+'">'+(v==='all'?'Any':fmt(v))+'</button>').join('')+'</div>';
  $('fltPop').innerHTML='<span class="h">Base fee</span>'+grp('base',F.bases,v=>(+v).toFixed(2)+'%')+'<span class="h">Bin step</span>'+grp('bs',F.bss,v=>(v/100).toFixed(2)+'%')+'<div class="foot"><button type="button" data-fltreset>Clear filters</button><span class="dim" style="font-size:12px">Tokens and categories: the chips below</span></div>'; }
const popToggle=(btn,pop,fill)=>{ const open=pop.hidden; document.querySelectorAll('.pop2').forEach(x=>x.hidden=true); document.querySelectorAll('.tbtn').forEach(x=>x.setAttribute('aria-expanded','false')); if(open){ fill(); pop.hidden=false; btn.setAttribute('aria-expanded','true'); } };
$('colBtn').onclick=e=>{ e.stopPropagation(); popToggle($('colBtn'),$('colPop'),colPop); };
$('fltBtn').onclick=e=>{ e.stopPropagation(); popToggle($('fltBtn'),$('fltPop'),fltPop); };
$('colPop').addEventListener('click',e=>e.stopPropagation()); $('fltPop').addEventListener('click',e=>e.stopPropagation());
$('colPop').addEventListener('change',e=>{ const k=e.target.dataset.col; if(!k) return; S.cols=COLS.map(c=>c[0]).filter(c=>c===k?e.target.checked:S.cols.includes(c)); LS.set('veyl:cols',S.cols); renderPools(); });
$('colPop').addEventListener('click',e=>{ if(e.target.closest('[data-colreset]')){ S.cols=COLS_DEF.slice(); LS.set('veyl:cols',S.cols); colPop(); renderPools(); } });
$('fltPop').addEventListener('click',e=>{ const b=e.target.closest('[data-f]'); if(b){ S.flt[b.dataset.f]=b.dataset.v==='all'?'all':b.dataset.v; fltPop(); renderPools(); } if(e.target.closest('[data-fltreset]')){ S.flt={base:'all',bs:'all'}; S.tokF='all'; S.cat='all'; fltPop(); renderPools(); } });
document.addEventListener('click',()=>{ document.querySelectorAll('.pop2').forEach(x=>x.hidden=true); document.querySelectorAll('.tbtn').forEach(x=>x.setAttribute('aria-expanded','false')); });
$('ivSeg').onclick=e=>{ const b=e.target.closest('[data-iv]'); if(!b) return; S.iv=+b.dataset.iv; LS.set('veyl:iv',S.iv); renderPools(); if(LIVE&&!SBX) loadChainStats().then(renderPools); };
$('poolHead').onclick=e=>{ const t=e.target.closest('[data-sort]'); if(!t) return; S.sort=t.dataset.sort; renderPools(); };
$('tokChips').onclick=e=>{ const c=e.target.closest('[data-cat]'); if(c){ S.cat=c.dataset.cat; renderPools(); return; } const b=e.target.closest('[data-tok]'); if(!b) return; S.tokF=b.dataset.tok; renderPools(); };
$('poolQ').addEventListener('input',renderPools);
$('poolSort').onchange=e=>{ S.sort=e.target.value; renderPools(); };
$('poolRows').addEventListener('keydown',e=>{ const r=e.target.closest('[data-pool]'); if(r&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); openPool(r.dataset.pool); } });

/* ---------- pool page ---------- */
const cur=()=>byId(S.cur);
function range(){ const p=cur(); const a=p.st?p.st.active:0; return {lo:a+S.lo,hi:a+S.hi,a}; }
function shapeName(){ return S.shape==='bidask'?'bidAsk':S.shape; }
/// The distribution about to be added, per bin, from the SDK's own shapeWeights (amounts when entered, weights otherwise).
function preview(){ const p=cur(); if(!p.st||!SDK) return null; const {lo,hi,a}=range(); const ids=[]; for(let i=lo;i<=hi;i++) ids.push(i); if(!ids.length) return null;
  const w=SDK.shapeWeights(ids,a,shapeName()); const ax=S.tab==='add'?(parseFloat($('amtX').value)||0):0, ay=S.tab==='add'?(parseFloat($('amtY').value)||0):0; const px=hp(p,a);
  let vals; if(ax>0||ay>0){ const sx=w.weightsX.reduce((s,x)=>s+x,0)||1, sy=w.weightsY.reduce((s,x)=>s+x,0)||1; vals=ids.map((id,i)=>(S.side!=='y'?ax*w.weightsX[i]/sx*px:0)+(S.side!=='x'?ay*w.weightsY[i]/sy:0)); }
  else vals=ids.map((id,i)=>(S.side!=='y'?w.weightsX[i]:0)+(S.side!=='x'?w.weightsY[i]:0));
  return {ids,vals,real:ax>0||ay>0}; }
function renderPoolHead(){
  const p=cur(), st=p.st;
  $('pLogo').innerHTML=tokImg(p.x,'')+tokImg(p.y,''); $('pName').textContent=p.x+'–'+p.y;
  $('pTags').innerHTML='<span class="pill priv">'+ic('lock')+'Private</span>'+(S.faucet?' <button class="pill flat drip" type="button" data-drip="'+esc(p.x+','+p.y)+'">Get test '+esc(p.x)+' + '+esc(p.y)+'</button>':'');
  const sk='<span class="skel" style="width:70%"></span>';
  const v=(x)=>st?x:LIVE&&!p.err?sk:DASH; const ps=pstat(p), ivn=IVN[S.iv]||'24h';
  document.querySelectorAll('#pIv [data-iv]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.iv===S.iv)));
  $('pPx').innerHTML=st?'<b>'+tiny(hp(p,st.active))+'</b>'+(ps&&!SBX?chg(ps.change)+' <span class="dim" style="margin-left:4px;font-size:12.5px">'+ivn+'</span>':'')+'<small>'+p.y+' per '+p.x+mktRef(p)+'</small>':'<b>'+(LIVE&&!p.err?'…':'—')+'</b><small>'+p.y+' per '+p.x+'</small>';
  const stats=[['Liquidity',ps?usd$(ps.tvlUsd):v(st&&tiny(liqY(p))),st?amt(p.x,st.reserves.x)+' '+p.x+' + '+amt(p.y,st.reserves.y)+' '+p.y:''],['Volume '+ivn,ps?usd$(ps.volumeUsd):DASH,ps?ps.swaps+' swaps':'not recorded on chain'],['Fees '+ivn,ps?usd$(ps.feesUsd):DASH,ps?'APR '+pctS(ps.aprPct)+' to LPs':'not recorded on chain'],['Bin step',(p.bs/100).toFixed(2)+'%','per bin'],['Dynamic fee',v(st&&pct(st.fee)),'base '+p.base.toFixed(2)+'% + volatility'],['Fees, all time',v(st&&tiny(feesY(p))),st?'in '+p.y+' at today\'s price':'']];
  $('pIv').hidden=SBX||!LIVE; $('pParamsCard').hidden=SBX||!LIVE;
  if(!LIVE) $('pPx').innerHTML='<small style="margin-top:0">'+p.y+' per '+p.x+' · bin step '+(p.bs/100).toFixed(2)+'%</small>';
  const shown=!LIVE?[['Bin step',(p.bs/100).toFixed(2)+'%','per bin'],['Base fee',p.base.toFixed(2)+'%','rises with volatility'],['Fee cap','10%','never above']]:SBX?[['Liquidity',v(st&&(refUsd(p.y)!=null?usd$(liqY(p)*refUsd(p.y)):tiny(liqY(p))+' '+p.y)),st?amt(p.x,st.reserves.x)+' '+p.x+' + '+amt(p.y,st.reserves.y)+' '+p.y:''],['Fee now',v(st&&pct(st.fee)),'base '+p.base.toFixed(2)+'%'],['Bin step',(p.bs/100).toFixed(2)+'%','per bin']]:stats;
  $('pStats').classList.toggle('three',shown.length===3); $('pStats').innerHTML=shown.map(s=>'<div class="stat"><span>'+s[0]+'</span><b>'+s[1]+'</b><small>'+s[2]+'</small></div>').join('');
  drawPx(ps);
  $('pLegend').innerHTML='<span><i style="background:var(--y-side)"></i>'+p.y+' side</span><span><i style="background:var(--x-side)"></i>'+p.x+' side</span><span><i style="background:var(--act)"></i>Active bin</span><span><i class="ln" style="background:var(--wine-2)"></i>Your range</span>';
  const P=[['Bin step',(p.bs/100).toFixed(2)+'% per bin'],['Base fee',p.base.toFixed(2)+'%'],['Dynamic fee now',st?pct(st.fee):DASH],['Fee cap','10%'],['Protocol share of fees',st?(st.protocolShare/100).toFixed(0)+'%':DASH],['Active bin',st?String(st.active):DASH],
    ['Farm rewards',st?(st.rewards.length?st.rewards.map(r=>(r.sym||short(r.mint))+(r.live?' · emitting':' · ended')).join(', '):'None'):DASH],['Pool address',p.address?'<span class="mono">'+short(p.address)+'</span>':DASH]];
  $('pParams').innerHTML=P.map(r=>'<div><dt>'+r[0]+'</dt><dd>'+r[1]+'</dd></div>').join('');
}
/// Price over the interval (the active bin's price at the end of each 5-minute bucket, Sandbox history).
/// The market's price for the pair, its source and age: a reference beside the pool's own price, never in its place.
function mktRef(p){ const a=mktUsd(p.x), b=mktUsd(p.y); if(!MKT) return ''; if(!(a&&b)) return SBX?' · price as of '+esc(E.marketInfo().asOf):''; return ' · market '+tiny(a/b)+' ('+esc(MKT.label(p.x))+')'; }
function drawPx(ps){ const svg=$('pxChart'), card=$('pxCard'); if(SBX||!LIVE){ card.hidden=true; return; } if(!ps||ps.spark.length<2){ card.hidden=!SBX; svg.innerHTML=SBX?'<text x="12" y="70">Not enough history yet</text>':''; $('pxNote').textContent=''; return; } card.hidden=false;
  const W=svg.clientWidth||600, H=svg.clientHeight||150, padL=4, padR=74, vals=ps.spark, mn=Math.min(...vals), mx=Math.max(...vals), r=(mx-mn)||mx*1e-4||1; svg.setAttribute('viewBox','0 0 '+W+' '+H);
  const X=i=>padL+i/(vals.length-1)*(W-padL-padR), Y=v=>8+(1-(v-mn)/r)*(H-24); const up=vals[vals.length-1]>=vals[0], col=up?'var(--good)':'var(--bad)';
  const d='M'+vals.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join('L');
  const g=[mx,(mx+mn)/2,mn].map(v=>'<line class="gl" x1="'+padL+'" x2="'+(W-padR+6)+'" y1="'+Y(v).toFixed(1)+'" y2="'+Y(v).toFixed(1)+'"/><text x="'+(W-padR+10)+'" y="'+(Y(v)+4).toFixed(1)+'">'+tiny(v)+'</text>').join('');
  const t0=new Date(ps.sparkT[0]*1000), fm=t=>t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  svg.innerHTML=g+'<path d="'+d+'L'+X(vals.length-1).toFixed(1)+','+(H-16)+'L'+padL+','+(H-16)+'Z" fill="'+col+'" opacity=".08"/><path class="ln" d="'+d+'" stroke="'+col+'"/><circle cx="'+X(vals.length-1).toFixed(1)+'" cy="'+Y(vals[vals.length-1]).toFixed(1)+'" r="3.5" fill="'+col+'"/><text x="'+padL+'" y="'+(H-2)+'">'+fm(t0)+'</text><text x="'+(W-padR)+'" y="'+(H-2)+'" text-anchor="end">now</text>';
  $('pxNote').textContent='5-minute closes'; }
$('pIv').onclick=e=>{ const b=e.target.closest('[data-iv]'); if(!b) return; S.iv=+b.dataset.iv; LS.set('veyl:iv',S.iv); renderPoolHead(); if(LIVE&&!SBX) loadChainStats().then(()=>{ if(S.page==='pool') renderPoolHead(); }); };
function drawBins(){
  const p=cur(), st=p.st, svg=$('binChart'), W=svg.clientWidth||600, H=svg.clientHeight||220; svg.setAttribute('viewBox','0 0 '+W+' '+H);
  if(!st){ svg.dataset.pool=''; svg.innerHTML='<text x="'+(W/2)+'" y="'+(H/2)+'" text-anchor="middle" fill="var(--muted)" font-family="Manrope, system-ui, sans-serif" font-size="13">'+(LIVE?(p.err?'Could not read this pool: '+esc(p.err.slice(0,60)):'Reading bins from the chain…'):'Not connected to Solana.')+'</text>'; $('pAxis').innerHTML=''; $('pRead').textContent=''; return; }
  const a=st.active, span=35, ids=[]; for(let i=a-span;i<=a+span;i++) ids.push(i);
  const n=ids.length, gap=Math.max(1,W/n*0.16), bw=(W-gap*(n-1))/n, X=k=>k*(bw+gap);
  const val=id=>{ const b=st.bins[id]; if(!b) return 0; const px=hp(p,id); return E.fmt(p.x,b.x+b.askX)*px+E.fmt(p.y,b.y+b.bidY); };
  const mx=Math.max(...ids.map(val))||0; const top=H-26;
  let g='', bgG=''; const pv=(S.tab==='add'||S.tab==='zap')?preview():null; const {lo,hi}=range();
  if(pv){ const k0=ids.indexOf(Math.max(lo,ids[0])), k1=ids.indexOf(Math.min(hi,ids[n-1])); if(k0>=0&&k1>=0) bgG+='<rect x="'+(X(k0)-gap/2).toFixed(1)+'" y="0" width="'+(X(k1)+bw-X(k0)+gap).toFixed(1)+'" height="'+H+'" fill="var(--wine-tint)"/>'; }
  const bars=ids.map((id,k)=>{ const v=val(id), h=mx>0?Math.max(v>0?2:0,v/mx*top):0; return {id,x:X(k),y:H-h,h,col:id<a?'var(--y-side)':id>a?'var(--x-side)':'var(--act)',op:id===a?1:0.85}; });
  const old=svg.querySelectorAll('rect.bar'); const keep=old.length===n&&svg.dataset.w===String(W)&&svg.dataset.pool===p.id;
  g+='<rect x="'+X(ids.indexOf(a)).toFixed(1)+'" y="0" width="'+bw.toFixed(1)+'" height="'+H+'" fill="var(--act)" opacity=".10"/>';
  if(pv){ const pm=Math.max(...pv.vals)||1; let d=''; pv.ids.forEach((id,i)=>{ const k=ids.indexOf(id); if(k<0) return; const y=(H-4-pv.vals[i]/pm*H*0.42).toFixed(1); d+=(d?'V'+y:'M'+X(k).toFixed(1)+','+y)+'H'+(X(k)+bw).toFixed(1); });
    if(d) g+='<path d="'+d+'" fill="none" stroke="var(--wine-2)" stroke-width="2" stroke-linejoin="round"/>'; }
  if(S.tab==='limit'){ const ob=ordBin(); if(ob!=null){ const k=ids.indexOf(ob); if(k>=0) g+='<rect x="'+X(k).toFixed(1)+'" y="0" width="'+bw.toFixed(1)+'" height="'+H+'" fill="none" stroke="var(--wine-2)" stroke-width="1.5" stroke-dasharray="3 3"/>'; } }
  E.myOrders().filter(o=>o.pool===p.address&&!o.closed).forEach(o=>{ const k=ids.indexOf(o.binId); if(k>=0) g+='<circle cx="'+(X(k)+bw/2).toFixed(1)+'" cy="8" r="3.5" fill="var(--wine-2)"/>'; });
  if(!(mx>0)) g+='<text x="'+(W/2)+'" y="'+(H/2-10)+'" text-anchor="middle" fill="var(--muted)" font-family="Manrope, system-ui, sans-serif" font-size="13">No liquidity in these bins yet</text>';
  if(keep){ bars.forEach((b,k)=>{ const r=old[k]; r.setAttribute('data-bin',b.id); r.setAttribute('y',b.y.toFixed(1)); r.setAttribute('height',b.h.toFixed(1)); r.style.y=b.y.toFixed(1)+'px'; r.style.height=b.h.toFixed(1)+'px'; r.setAttribute('fill',b.col); r.setAttribute('opacity',b.op); }); svg.querySelector('g.ov').innerHTML=g; svg.querySelector('g.bg').innerHTML=bgG; }
  else { svg.innerHTML='<g class="bg">'+bgG+'</g><g class="bs">'+bars.map(b=>'<rect class="bar" data-bin="'+b.id+'" x="'+b.x.toFixed(1)+'" y="'+b.y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+b.h.toFixed(1)+'" fill="'+b.col+'" opacity="'+b.op+'"/>').join('')+'</g><g class="ov">'+g+'</g>'; svg.dataset.w=String(W); svg.dataset.pool=p.id; }
  $('pAxis').innerHTML='<span>'+tiny(hp(p,ids[0]))+'</span><span>'+tiny(hp(p,a))+' '+p.y+'</span><span>'+tiny(hp(p,ids[n-1]))+'</span>';
  svg.onpointermove=e=>{ const r=svg.getBoundingClientRect(); const k=Math.max(0,Math.min(n-1,Math.floor((e.clientX-r.left)/(r.width/n)))); const id=ids[k], b=st.bins[id];
    $('pRead').textContent='Bin '+id+(id===a?' (active)':'')+' · '+tiny(hp(p,id))+' '+p.y+' · '+(b?amt(p.x,b.x)+' '+p.x+' + '+amt(p.y,b.y)+' '+p.y:'empty')+(b&&(b.askX>0n||b.bidY>0n)?' · orders '+amt(p.x,b.askX)+' '+p.x+' / '+amt(p.y,b.bidY)+' '+p.y:''); };
  svg.onpointerleave=()=>{ $('pRead').textContent=''; };
}

/* ---------- positions (cards shared by the pool page and the portfolio) ---------- */
function posCard(q){ const p=byAddr(q.pool)||{x:q.x,y:q.y,st:null}; const i=PI[q.id]; const priv=q.kind!=='public';
  const head='<div class="t">'+pairImg(p)+'<div class="mid"><b>'+q.x+'–'+q.y+'</b><small>'+(p.st?tiny(hp(p,q.lo))+' – '+tiny(hp(p,q.hi))+' '+q.y:'bins '+q.lo+' … '+q.hi)+' · '+(q.hi-q.lo+1)+' bins · '+({spot:'Spot',curve:'Curve',bidask:'Bid-Ask',bidAsk:'Bid-Ask'})[q.shape]+'</small></div>'+(q.kind==='shielded'?'<span class="pill priv">'+ic('lock')+'Private</span>':priv?'<span class="pill priv">'+ic('lock')+'One-time key</span>':'<span class="pill pubk">Public</span>');
  if(!i) return '<div class="pos" data-posrow="'+q.id+'">'+head+'</div><span class="skel" style="width:60%"></span></div>';
  if(i.err) return '<div class="pos">'+head+'</div><p class="err">Could not read this position: '+esc(i.err)+'</p></div>';
  const st=i.open?(i.inRange?'<span class="pill good">In range</span>':'<span class="pill warn">Out of range</span>'):'<span class="pill flat">Closed</span>';
  const w=Math.max(q.hi-q.lo+20,40), mid=(q.lo+q.hi)/2, L=(q.lo-(mid-w/2))/w*100, R=(q.hi+1-(mid-w/2))/w*100, A=(i.active+.5-(mid-w/2))/w*100;
  const rw=i.rewards.map((v,k)=>({v,k})).filter(r=>r.v>0n); const rsym=k=>{ const s=p.st&&p.st.rewards.find(r=>r.index===k); return s&&s.sym||'reward'; };
  const fees=(i.fees.x>0n||i.fees.y>0n);
  return '<div class="pos" data-posrow="'+q.id+'">'+head+st+'</div>'+
    '<div class="rangebar" aria-hidden="true"><i style="left:'+Math.max(0,L).toFixed(1)+'%;right:'+Math.max(0,100-R).toFixed(1)+'%"></i><em style="left:calc('+Math.max(0,Math.min(100,A)).toFixed(1)+'% - 1px)"></em></div>'+
    '<div class="b"><div><span>Value</span><b class="sens">'+amt(q.x,i.value.x)+' '+q.x+'<br>'+amt(q.y,i.value.y)+' '+q.y+'</b></div><div><span>Unclaimed fees</span><b class="sens up">'+(fees?amt(q.x,i.fees.x)+' '+q.x+'<br>'+amt(q.y,i.fees.y)+' '+q.y:'None yet')+'</b></div><div><span>Rewards</span><b class="sens">'+(q.kind==='shielded'?'<span class="dim">Not earned while shielded</span>':rw.length?rw.map(r=>tiny(E.fmt(rsym(r.k),r.v))+' '+rsym(r.k)).join('<br>'):'None')+'</b></div></div>'+
    posPro(q,i)+'<div class="a"><button class="btn sm ghost" type="button" data-pa="claim" data-id="'+q.id+'"'+(fees?'':' disabled')+'>Claim fees</button>'+(rw.length?'<button class="btn sm ghost" type="button" data-pa="reward" data-id="'+q.id+'">Claim rewards</button>':'')+(i.open?'<button class="btn sm ghost" type="button" data-pa="rebalance" data-id="'+q.id+'">Rebalance</button><button class="btn sm" type="button" data-pa="withdraw" data-id="'+q.id+'">Withdraw</button>':'')+'</div></div>'; }
function ordRow(o){ const i=OI[o.id]; const side=o.isAsk?'Sell '+o.x:'Buy '+o.x; const p=byAddr(o.pool)||{st:null};
  let st=o.closed?'<span class="pill flat">Withdrawn</span>':!i?'<span class="skel" style="width:50px"></span>':i.err?'<span class="pill warn">Unreadable</span>':i.filled?'<span class="pill good">Filled</span>':(o.isAsk?i.filledY>0n:i.filledX>0n)?'<span class="pill warn">Part filled</span>':'<span class="pill flat">Open</span>';
  const left=i&&!i.err?(o.isAsk?amt(o.x,i.unfilledX)+' '+o.x+' left · '+amt(o.y,i.filledY)+' '+o.y+' received':amt(o.y,i.unfilledY)+' '+o.y+' left · '+amt(o.x,i.filledX)+' '+o.x+' received'):amt(o.sym,BigInt(o.amount))+' '+o.sym;
  return '<div class="row"><div class="mid"><b>'+side+' · '+o.x+'–'+o.y+' '+(o.kind==='shielded'?'<span class="pill priv">'+ic('lock')+'Private</span>':o.kind!=='public'?'<span class="pill priv">'+ic('lock')+'One-time key</span>':'<span class="pill pubk">Public</span>')+'</b><small>at '+(p.st?tiny(hp(p,o.binId))+' '+o.y:'bin '+o.binId)+' · <span class="sens">'+left+'</span></small></div><div class="rt">'+st+(o.closed?'':'<div style="margin-top:6px"><button class="btn sm ghost" type="button" data-ow="'+o.id+'">Withdraw</button></div>')+'</div></div>'; }
function renderPoolBody(){ const p=cur(); if(!LIVE){ $('pPos').innerHTML='<div class="card empty">No positions yet.</div>'; $('pOrd').innerHTML=''; $('pOrdH').hidden=true; $('pSealH').hidden=true; $('pSeal').innerHTML=''; return; }
  const ms=SEAL.mine.filter(x=>x.pool===p.address&&(x.state!=='claimed'&&x.state!=='refunded'||Date.now()-x.at<36e5)); $('pSealH').hidden=!ms.length; $('pSeal').innerHTML=ms.map(sealRow).join('');
  const mine=E.myPositions().filter(q=>q.pool===p.address&&(!PI[q.id]||PI[q.id].err||PI[q.id].open||PI[q.id].fees.x>0n||PI[q.id].fees.y>0n||PI[q.id].rewards.some(r=>r>0n)));
  $('pPos').innerHTML=mine.length?mine.map(posCard).join(''):'<div class="card empty">'+(E.account?'No positions in this pool yet.':'Connect a wallet to see your positions.')+'</div>';
  const os=E.myOrders().filter(o=>o.pool===p.address&&!o.closed); $('pOrdH').hidden=!os.length; $('pOrd').innerHTML=os.map(ordRow).join(''); }

/* ---------- the action panel ---------- */
const SRC=()=>S.src; const PMAX=16;
function setRangeFromBins(n){ n=Math.max(1,Math.min(69,n|0)); if(S.side==='x'){ S.lo=0; S.hi=n-1; } else if(S.side==='y'){ S.lo=-(n-1); S.hi=0; } else { const h=Math.floor((n-1)/2); S.lo=-h; S.hi=n-1-h; } }
function syncRangeInputs(force){ const p=cur(); const {lo,hi}=range(); const ae=document.activeElement;
  if(p.st){ if(force||ae!==$('rMin')) $('rMin').value=tiny(hp(p,lo)).replace(/,/g,''); if(force||ae!==$('rMax')) $('rMax').value=tiny(hp(p,hi)).replace(/,/g,''); } else { $('rMin').value=''; $('rMax').value=''; $('rMin').placeholder='—'; $('rMax').placeholder='—'; }
  if(force||ae!==$('rBins')) $('rBins').value=String(hi-lo+1); }
function ordBin(){ const p=cur(); if(!p.st) return null; const v=parseFloat($('ordPrice').value); if(!(v>0)) return null; return E.binForPrice(p.st,v); }
function drawMini(){ const svg=$('mini'), W=svg.clientWidth||360, H=46; svg.setAttribute('viewBox','0 0 '+W+' '+H); const pv=preview(); if(!pv){ svg.innerHTML=''; return; }
  const n=pv.ids.length, gap=n>40?1:2, bw=Math.max(1,(W-gap*(n-1))/n), m=Math.max(...pv.vals)||1, a=range().a; let g='';
  pv.ids.forEach((id,i)=>{ const h=Math.max(pv.vals[i]>0?2:0,pv.vals[i]/m*(H-4)); g+='<rect x="'+(i*(bw+gap)).toFixed(1)+'" y="'+(H-h).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" fill="'+(id<a?'var(--y-side)':id>a?'var(--x-side)':'var(--act)')+'"/>'; });
  svg.innerHTML=g; }
function seen(hidden,pub){ return '<div class="h"><b>Hidden</b><span>'+hidden+'</span></div><div class="p"><b>Public</b><span>'+pub+'</span></div>'; }
function renderPanel(){
  const p=cur(), st=p.st, src=SRC(), priv=src==='priv';
  document.querySelectorAll('#tabs [data-tab]').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===S.tab));
  document.querySelectorAll('#srcSeg [data-src]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.src===src));
  ['add','zap','limit','swap'].forEach(t=>$('tab-'+t).hidden=S.tab!==t); $('shapeRange').hidden=!(S.tab==='add'||S.tab==='zap');
  const sb=k=>bal(src,k), bl=k=>(LIVE&&(priv||E.account)?tiny(sb(k))+' '+k:'');
  let go='', ready=false, det=[], hint='', sn='';
  const block=blocker(src);
  if(S.tab==='add'||S.tab==='zap'){ syncRangeInputs(); const {lo,hi,a}=range();
    document.querySelectorAll('#shapeSeg [data-s]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.s===S.shape));
    $('rngNote').textContent=st?(lo>a?'above the price':hi<a?'below the price':'around the price'):'';
    det.push(['Bins',(hi-lo+1)+(hi-lo+1>PMAX&&priv?' <span class="down">(max '+PMAX+' private)</span>':'')]); }
  if(S.tab==='add'){
    document.querySelectorAll('#sideSeg [data-side]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.side===S.side)); $('sideX').textContent='Only '+p.x; $('sideY').textContent='Only '+p.y;
    $('boxX').hidden=S.side==='y'; $('boxY').hidden=S.side==='x';
    $('tkX').innerHTML=tokImg(p.x,'')+p.x; $('tkY').innerHTML=tokImg(p.y,'')+p.y; $('balX').textContent=bl(p.x); $('balY').textContent=bl(p.y);
    const ax=S.side==='y'?0:parseFloat($('amtX').value)||0, ay=S.side==='x'?0:parseFloat($('amtY').value)||0; const {lo,hi,a}=range();
    $('hintX').textContent=st&&hi<a?'Not used below the price':''; $('hintY').textContent=st&&lo>a?'Not used above the price':'';
    if(st) det.push(['Value',tiny(ax*hp(p,a)+ay)+' '+p.y]);
    if(!priv) det.push(['Rent','≈ 0.049 SOL per 60-bin share account']);
    det.push(['Network fee',priv?'Relayer, a flat fee per proof (quoted when you confirm)':'≈ 0.00001 SOL per transaction']);
    const over=ax>sb(p.x)+1e-12||ay>sb(p.y)+1e-12;
    go=block||(!st?'Reading the pool…':!(ax>0||ay>0)?'Enter an amount':over?'Not enough '+(ax>sb(p.x)?p.x:p.y)+(priv?' in your shielded balance':' in your wallet'):(priv&&hi-lo+1>PMAX)?'Narrow the range to '+PMAX+' bins':(lo>a&&ax===0)||(hi<a&&ay===0)?'This range takes only '+(lo>a?p.x:p.y):'');
    ready=!go; if(ready) go=(priv?ic('lock','sm')+'Add privately':'Add from wallet');
    sn=priv?seen('Your wallet, your balances, how large your position is (the shielded pool holds every shielded position together; your share is a note only you can read).','This add: its bins and the amounts and shares it puts in (the pool\'s reserves move), the relayer\'s flat fee.'):seen('Nothing.','Your wallet, the bins and amounts, and every later claim and withdrawal.');
  }
  if(S.tab==='zap'){ const xs=S.zx, sym=xs?p.x:p.y; document.querySelectorAll('#zapSeg [data-z]').forEach(b=>b.setAttribute('aria-pressed',(b.dataset.z==='x')===xs)); $('zapX').textContent=p.x+' in'; $('zapY').textContent=p.y+' in';
    $('zapTk').innerHTML=tokImg(sym,'')+sym; $('zapBal').textContent=bl(sym); const v=parseFloat($('zapAmt').value)||0;
    det.push(['Swap inside the pool',zapPrevTxt||'—']); det.push(['Network fee',priv?'Relayer, a flat fee':'≈ 0.00001 SOL']);
    go=block||(!st?'Reading the pool…':!(v>0)?'Enter an amount':v>sb(sym)+1e-12?'Not enough '+sym:(hi()-lo()+1>(priv?PMAX:16))?'Narrow the range to '+(priv?PMAX:16)+' bins':''); ready=!go; if(ready) go=priv?ic('lock','sm')+'Zap in privately':'Zap in from wallet';
    sn=priv?seen('Your wallet, your balance, your position\'s total size.','The amount zapped, the internal swap, the shares added per bin.'):seen('Nothing.','Your wallet, the amount, the swap and the bins.');
  }
  if(S.tab==='limit'){ const buy=S.ord==='buy', sym=buy?p.y:p.x; document.querySelectorAll('#ordSeg [data-o]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.o===S.ord)); $('ordBuy').textContent='Buy '+p.x; $('ordSell').textContent='Sell '+p.x;
    $('ordPriceL').textContent=(buy?'Buy':'Sell')+' '+p.x+' at ('+p.y+' per '+p.x+')'; $('ordTk').innerHTML=tokImg(sym,'')+sym; $('ordBal').textContent=bl(sym);
    if(st&&!$('ordPrice').value&&document.activeElement!==$('ordPrice')) $('ordPrice').value=tiny(hp(p,st.active+(buy?-3:3))).replace(/,/g,'');
    const b=ordBin(), v=parseFloat($('ordAmt').value)||0; $('ordBin').textContent=b==null?(st?'Enter a price':'—'):'Bin '+b+' · exact price '+tiny(hp(p,b))+' '+p.y+(st?' · '+(b-st.active>0?'+':'')+(b-st.active)+' bins from the price':'');
    $('ordGet').textContent=b!=null&&v>0?'Fills to ≈ '+tiny(buy?v/hp(p,b):v*hp(p,b))+' '+(buy?p.x:p.y):'';
    det.push(['Network fee',priv?'Relayer, a flat fee':'≈ 0.00001 SOL']);
    const wrong=st&&b!=null&&(buy?b>=st.active:b<=st.active);
    go=block||(!st?'Reading the pool…':b==null?'Enter a price':wrong?(buy?'A buy sits below the price':'A sell sits above the price'):!(v>0)?'Enter an amount':v>sb(sym)+1e-12?'Not enough '+sym:''); ready=!go; if(ready) go=(priv?ic('lock','sm'):'')+(buy?'Place buy order':'Place sell order')+(priv?' privately':'');
    sn=priv?seen('Your wallet and your balance. The order\'s shares come back as a note only you can spend.','The bin, the side and the amount (an order sits in the pool).'):seen('Nothing.','Your wallet, the bin, the side and the amount.');
  }
  if(S.tab==='swap'){ const a=S.pswX?p.x:p.y, b=S.pswX?p.y:p.x; $('pswTkIn').innerHTML=tokImg(a,'')+a; $('pswTkOut').innerHTML=tokImg(b,'')+b; $('pswBal').textContent=bl(a)?'Balance '+bl(a):'';
    const ss=SEAL.pool===p.id?SEAL.st:null, sealOk=!!(ss&&ss.enabled&&!ss.paused&&ss.committee&&ss.batch), sealed=sealOk&&(S.swMode||'sealed')==='sealed';
    $('swMode').hidden=!(ss&&ss.enabled); document.querySelectorAll('#swMode [data-m]').forEach(x=>x.setAttribute('aria-pressed',(x.dataset.m==='sealed')===sealed));
    $('sealBox').hidden=!sealed; if(sealed) $('sealBox').innerHTML=sealBox(p,ss);
    const v=parseFloat($('pswIn').value)||0; const q=pswQ&&pswQ.v===v&&pswQ.a===a?pswQ:null; $('pswOut').value=q&&q.out!=null?(sealed?'≈ ':'')+tiny(q.out):''; $('pswRoute').textContent=q&&q.route?(sealed?'at today\'s price':'via '+q.route):'';
    if(LIVE&&v>0&&!q) pswQuote(v,a,b);
    if(sealed){ const dir=S.pswX?0:1, min=fmtU(a,BigInt(ss.minIn[dir])), open=ss.batch.state==='open';
      det.push(['Batch',ss.batch.seq+' · '+(open?'closes in '+mmss(sealLeft()):'sealing')]); det.push(['Price','the batch\'s clearing price']); det.push(['Smallest swap',tiny(min)+' '+a]); det.push(['Network fee','Relayer, a flat fee in '+a+' now and in '+b+' when you claim']);
      go=block||(!priv?'Sealed swaps spend your shielded balance':!(v>0)?'Enter an amount':v>sb(a)+1e-12?'Not enough '+a+' in your shielded balance':v<min?'The smallest sealed swap here is '+tiny(min)+' '+a:!open?'Batch '+ss.batch.seq+' is sealing; the next one opens in a moment':''); ready=!go; if(ready) go=ic('lock','sm')+'Seal into batch '+ss.batch.seq;
      sn=seen('Your wallet, your balance and this swap\'s size: it is encrypted on this device to the batch committee, which only ever decrypts the batch\'s total.','That a '+a+' to '+b+' swap joined batch '+ss.batch.seq+'. When it settles: the batch\'s totals per side, its clearing price and how many sold on each side. The relayer\'s flat fee.'); }
    else { det.push(['Rate',q&&q.out?'1 '+a+' = '+tiny(q.out/v)+' '+b:'—']); det.push(['Slippage limit','1%']); det.push(['Network fee',priv?'Relayer, a flat fee':'≈ 0.00001 SOL']);
      go=block||(!(v>0)?'Enter an amount':v>sb(a)+1e-12?'Not enough '+a:!q?'Quoting…':q.out==null?'No route with liquidity':''); ready=!go; if(ready) go=(priv?ic('lock','sm')+(ss&&ss.enabled?'Swap now, amount public':'Swap privately'):'Swap from wallet');
      sn=priv?seen('Your wallet and your balance. The output lands in a note only you can spend.','The route and the amounts in and out (they meet the pool), the relayer\'s flat fee.'):seen('Nothing.','Your wallet and the whole swap.'); }
  }
  $('actDet').innerHTML=det.map(d=>'<div><dt>'+d[0]+'</dt><dd>'+d[1]+'</dd></div>').join('');
  $('actSeen').innerHTML=sn;
  const g=$('actGo'); g.disabled=!ready; g.className='btn'+(priv?'':' ghost'); g.innerHTML=go;
  const sealedNow=S.tab==='swap'&&SEAL.pool===p.id&&SEAL.st&&SEAL.st.enabled&&!SEAL.st.paused&&SEAL.st.batch&&(S.swMode||'sealed')==='sealed';
  const h=$('actHint'); if(LIVE&&sealedNow){ h.className='hint'; h.innerHTML=ic('lock')+'<span>The proof is made on this device (about '+(E.proveMs&&E.proveMs.swap&&E.proveMs.swap.length?Math.round(E.proveMs.swap.slice(-1)[0]/1000):20)+' s). After the batch settles, claim your output here: a second proof, a new hidden note.</span>'; } else if(!LIVE){ h.className='hint'; h.innerHTML=ic('wallet')+'<span>Connect a wallet to continue.</span>'; } else if(priv){ h.className='hint'; h.innerHTML=ic('lock')+'<span>Spends from your shielded balance: up to two notes per token, merged first when it takes more. Proofs are made on this device'+(SBX?' (several seconds, longer on a phone). For an instant try, pay from the wallet: no proof, all public.':'.')+'</span>'; } else { h.className='hint warn'; h.innerHTML=ic('alert')+'<span>Public: linked to your wallet for anyone to read.</span>'; }
  if(S.page==='pool'){ drawBins(); drawMini(); renderVolPre(); renderSim(); }
}
/// The current batch: countdown, sellers per side (never amounts), the k-floor rule, the last batch's public outcome.
function sealBox(p,ss){ const b=ss.batch, left=sealLeft(), ep=Number(ss.epochSlots)*(ss.slotMs||400), open=b.state==='open', pctDone=open?Math.min(100,Math.max(0,100-left/ep*100)):100;
  const st=ss.demo?'Sample batch':open?(b.rollovers>0?'Open · extended '+b.rollovers+'×':'Open'):b.state==='closed'?'Sealed · the committee decrypts its totals':b.state;
  const L=ss.last; let last='';
  if(L){ if(L.state==='settled'){ const r0=Number(L.den[0])>0?fmtU(p.y,BigInt(L.num[0]))/fmtU(p.x,BigInt(L.den[0])):null, r1=Number(L.den[1])>0?fmtU(p.y,BigInt(L.den[1]))/fmtU(p.x,BigInt(L.num[1])):null;
      last='Batch '+L.seq+' settled: '+tiny(fmtU(p.x,BigInt(L.totals[0])))+' '+p.x+' and '+tiny(fmtU(p.y,BigInt(L.totals[1])))+' '+p.y+' sold, '+L.count[0]+' + '+L.count[1]+' sellers'+(r0!=null?'; sellers of '+p.x+' got '+tiny(r0)+' '+p.y+' each':'')+(r1!=null?'; buyers paid '+tiny(r1)+' '+p.y+' per '+p.x:'')+'.'; }
    else if(L.state==='failed') last='Batch '+L.seq+' did not settle; its swaps are refunded.'; else if(L.state==='closed') last='Batch '+L.seq+' is sealed; the committee is decrypting its totals.'; }
  return '<div class="top"><b>Batch '+esc(String(b.seq))+'</b><span class="pill '+(open?'priv':'flat')+'">'+ic('lock')+esc(st)+'</span></div>'+
    (open?'<div class="top"><span class="clock" id="sealClock">'+mmss(left)+'</span><small>'+(left>0?'until it closes':'closing now')+'</small></div><div class="bar"><i id="sealBar" style="width:'+pctDone.toFixed(1)+'%"></i></div>':'')+
    '<div class="sides"><div><span>Selling '+p.x+'</span><b>'+b.count[0]+'</b></div><div><span>Selling '+p.y+'</span><b>'+b.count[1]+'</b></div></div>'+
    '<small>Sellers, never amounts. A side settles with at least '+ss.kMin+' sellers or none; short of that the batch runs another epoch'+(ss.maxRollovers?' (up to '+ss.maxRollovers+' times)':'')+', then refunds.'+(SBX?' In the demo the epoch is 20 s, and bots seal small swaps so batches fill; a batch waits for a proof you are still making.':'')+'</small>'+(last?'<small class="last">'+esc(last)+'</small>':''); }
/// Your sealed swaps in this pool, with what each can do now.
function sealRow(x){ const p=byAddr(x.pool)||{x:x.x,y:x.y}; const a=tiny(E.fmt(x.sym,x.amount));
  const S_={waiting:['Submitted','flat','In batch '+x.seq+', waiting for it to close'],sealed:['Waiting for the batch','warn','Batch '+x.seq+' is closed; the committee decrypts its totals, then it settles'],claim:['Settled','good','Batch '+x.seq+' cleared'+(x.expect!=null?': your output is '+tiny(E.fmt(x.other,x.expect))+' '+x.other+' before the claim fee':'')],refund:['Refund','warn','Batch '+x.seq+' did not settle; take your '+x.sym+' back'],claimed:['Claimed','flat','Batch '+x.seq+' · delivered as a hidden note'],refunded:['Refunded','flat','Batch '+x.seq+' · returned as a hidden note'],failed:['Refund','warn','Batch '+x.seq+' failed'],unknown:['Unknown','flat','Batch '+x.seq]}[x.state]||[x.state,'flat',''];
  const btn=x.state==='claim'?'<button class="btn sm" type="button" data-sc="'+esc(x.id)+'">Claim</button>':x.state==='refund'?'<button class="btn sm ghost" type="button" data-sc="'+esc(x.id)+'">Refund</button>':'';
  return '<div class="row srow" data-seal="'+esc(x.id)+'"><div class="mid"><b>Sell <span class="sens">'+a+'</span> '+x.sym+' for '+x.other+' <span class="pill priv">'+ic('lock')+'Sealed</span></b><small>'+esc(S_[2])+'</small></div><div class="rt"><span class="pill '+S_[1]+'">'+S_[0]+'</span>'+btn+'</div></div>'; }
const lo=()=>range().lo, hi=()=>range().hi;
let pswQ=null, pswSeq=0; async function pswQuote(v,a,b){ const my=++pswSeq; try{ const best=await E.quoteRoute(a,b,E.unit(a,v)); if(my!==pswSeq) return; pswQ={v,a,out:best?E.fmt(b,best.out):null,route:best?best.path.map(h=>h.name).join(' → '):''}; }catch(e){ if(my!==pswSeq) return; pswQ={v,a,out:null}; } if(S.page==='pool') renderPanel(); }
let zapPrevTxt='', zapSeq=0; async function zapPreview(){ const p=cur(); const v=parseFloat($('zapAmt').value)||0; if(!LIVE||!p.st||!(v>0)){ zapPrevTxt=''; renderPanel(); return; } const my=++zapSeq;
  try{ const z=await E.planZapPreview(p,{xIn:S.zx,amount:v,lo:lo(),hi:hi(),shape:S.shape}); if(my!==zapSeq) return; const a=S.zx?p.x:p.y,b=S.zx?p.y:p.x; zapPrevTxt=tiny(z.swapIn)+' '+a+' → '+tiny(z.swapOut)+' '+b; $('zapPrev').textContent='≈ '+zapPrevTxt; }catch(e){ zapPrevTxt='—'; } renderPanel(); }
function sheet(open,tab){ if(tab) S.tab=tab; S.sheet=!!open; $('panel').classList.toggle('shown',S.sheet); $('sheetBg').classList.toggle('shown',S.sheet); if(open) renderPanel(); }
document.querySelectorAll('[data-sheet]').forEach(b=>b.onclick=()=>sheet(true,b.dataset.sheet));
$('panelX').onclick=()=>sheet(false); $('sheetBg').onclick=()=>sheet(false);
$('tabs').onclick=e=>{ const b=e.target.closest('[data-tab]'); if(!b) return; S.tab=b.dataset.tab; renderPanel(); };
$('srcSeg').onclick=e=>{ const b=e.target.closest('[data-src]'); if(!b) return; S.src=b.dataset.src; renderPanel(); };
$('sideSeg').onclick=e=>{ const b=e.target.closest('[data-side]'); if(!b) return; S.side=b.dataset.side; setRangeFromBins(hi()-lo()+1); syncRangeInputs(true); renderPanel(); };
$('shapeSeg').onclick=e=>{ const b=e.target.closest('[data-s]'); if(!b) return; S.shape=b.dataset.s; renderPanel(); if(S.tab==='zap') zapPreview(); };
$('presets').onclick=e=>{ const b=e.target.closest('[data-w]'); if(!b) return; if(b.dataset.w==='c') setRangeFromBins(hi()-lo()+1); else setRangeFromBins(+b.dataset.w*2+1); syncRangeInputs(true); renderPanel(); if(S.tab==='zap') zapPreview(); };
const onPrice=()=>{ const p=cur(); if(!p.st) return; const a=p.st.active; const mn=parseFloat($('rMin').value), mx=parseFloat($('rMax').value); if(mn>0) S.lo=Math.min(E.binForPrice(p.st,mn)-a,S.hi); if(mx>0) S.hi=Math.max(E.binForPrice(p.st,mx)-a,S.lo); if(S.hi-S.lo>68) S.lo=S.hi-68; renderPanel(); };
$('rMin').addEventListener('change',()=>{ onPrice(); syncRangeInputs(true); }); $('rMax').addEventListener('change',()=>{ onPrice(); syncRangeInputs(true); });
$('rMin').addEventListener('input',()=>clean($('rMin'))); $('rMax').addEventListener('input',()=>clean($('rMax')));
$('rBins').addEventListener('change',()=>{ setRangeFromBins(parseInt($('rBins').value)||1); syncRangeInputs(true); renderPanel(); });
['amtX','amtY','ordAmt','pswIn'].forEach(id=>$(id).addEventListener('input',()=>{ clean($(id)); renderPanel(); }));
$('zapAmt').addEventListener('input',()=>{ clean($('zapAmt')); renderPanel(); clearTimeout(zapPreview.t); zapPreview.t=setTimeout(zapPreview,350); });
$('ordPrice').addEventListener('input',()=>{ clean($('ordPrice')); renderPanel(); });
$('zapSeg').onclick=e=>{ const b=e.target.closest('[data-z]'); if(!b) return; S.zx=b.dataset.z==='x'; $('zapAmt').value=''; zapPrevTxt=''; renderPanel(); };
$('ordSeg').onclick=e=>{ const b=e.target.closest('[data-o]'); if(!b) return; S.ord=b.dataset.o; $('ordPrice').value=''; $('ordAmt').value=''; renderPanel(); };
$('pswFlip').onclick=()=>{ S.pswX=!S.pswX; $('pswIn').value=''; renderPanel(); };
$('swMode').onclick=e=>{ const b=e.target.closest('[data-m]'); if(!b) return; S.swMode=b.dataset.m; if(S.swMode==='sealed') S.src='priv'; renderPanel(); };
const maxOf=(sym)=>{ const b=bal(SRC(),sym); return b>0?String(b>=100?Math.floor(b*100)/100:+b.toFixed(6)):''; };
$('maxX').onclick=()=>{ $('amtX').value=maxOf(cur().x); renderPanel(); }; $('maxY').onclick=()=>{ $('amtY').value=maxOf(cur().y); renderPanel(); };
$('zapMax').onclick=()=>{ const p=cur(); $('zapAmt').value=maxOf(S.zx?p.x:p.y); renderPanel(); zapPreview(); };
$('ordMax').onclick=()=>{ const p=cur(); $('ordAmt').value=maxOf(S.ord==='buy'?p.y:p.x); renderPanel(); };
$('actGo').onclick=()=>{ const p=cur(), priv=SRC()==='priv', k=priv?'proof':'wallet', where=priv?'Private':'Public';
  if(S.tab==='add'){ const ax=S.side==='y'?0:parseFloat($('amtX').value)||0, ay=S.side==='x'?0:parseFloat($('amtY').value)||0, L=lo(), Hh=hi(), shape=S.shape;
    runAct('Adding liquidity',k,()=>E.addLiquidity(p,{priv,amountX:ax,amountY:ay,lo:L,hi:Hh,shape}),pos=>{ $('amtX').value=''; $('amtY').value=''; sheet(false);
      logAct({t:'Added liquidity · '+p.x+'–'+p.y,s:where+' · '+pos.ids.length+' bins · '+({spot:'Spot',curve:'Curve',bidask:'Bid-Ask'})[shape],amt:[ax?tiny(ax)+' '+p.x:'',ay?tiny(ay)+' '+p.y:''].filter(Boolean).join(' + ')});
      refreshAll(); loadPool(p,35).then(render); doneBlock('Position added',priv?'Your '+p.x+'–'+p.y+' position is live inside the shielded aggregate. On-chain: this action\'s change per bin, not whose it is or how large your position is. Back up your keys.':'Your '+p.x+'–'+p.y+' position is live, owned by your wallet.',pos.tx); }); }
  if(S.tab==='zap'){ const v=parseFloat($('zapAmt').value)||0, sym=S.zx?p.x:p.y;
    runAct('Zapping in',k,()=>E.zap(p,{priv,xIn:S.zx,amount:v,lo:lo(),hi:hi(),shape:S.shape}),pos=>{ $('zapAmt').value=''; sheet(false); logAct({t:'Zapped into '+p.x+'–'+p.y,s:where+' · '+pos.ids.length+' bins',amt:tiny(v)+' '+sym}); refreshAll(); loadPool(p,35).then(render);
      doneBlock('Zapped in','One '+sym+' payment became a '+p.x+'–'+p.y+' position across '+pos.ids.length+' bins'+(priv?', held in the shielded aggregate (its size is hidden).':'.'),pos.tx); }); }
  if(S.tab==='limit'){ const b=ordBin(), v=parseFloat($('ordAmt').value)||0, isAsk=S.ord==='sell', sym=isAsk?p.x:p.y;
    runAct('Placing a limit order',k,()=>E.placeOrder(p,{priv,isAsk,binId:b,amount:v}),o=>{ $('ordAmt').value=''; sheet(false); logAct({t:(isAsk?'Sell ':'Buy ')+p.x+' order placed',s:where+' · at '+tiny(hp(p,b))+' '+p.y,amt:tiny(v)+' '+sym}); refreshAll(); loadPool(p,35).then(render);
      doneBlock('Order placed',(isAsk?'Sell ':'Buy ')+p.x+' at '+tiny(hp(p,b))+' '+p.y+'. It fills as swaps cross bin '+b+'.',o.tx); }); }
  if(S.tab==='swap'&&SEAL.pool===p.id&&SEAL.st&&SEAL.st.enabled&&!SEAL.st.paused&&SEAL.st.batch&&(S.swMode||'sealed')==='sealed'){ const v=parseFloat($('pswIn').value)||0, a=S.pswX?p.x:p.y, b=S.pswX?p.y:p.x;
    return runAct('Sealing your swap','proof',()=>E.sealedSwap(p,{xIn:S.pswX,amount:v}),r=>{ $('pswIn').value=''; pswQ=null; logAct({t:'Sealed swap '+a+' → '+b,s:'Batch '+r.seq+' · size hidden',amt:tiny(v)+' '+a}); refreshAll(); loadSealed(p).then(render);
      doneBlock('Sealed into batch '+r.seq,'Your '+a+' left your shielded balance as an encrypted amount. Nobody, the relayer included, can see it. When the batch settles, claim your '+b+' on this page.',r.tx); }); }
  if(S.tab==='swap'){ const v=parseFloat($('pswIn').value)||0, a=S.pswX?p.x:p.y, b=S.pswX?p.y:p.x;
    runAct('Swapping',k,()=>priv?E.swap(a,b,v):E.swapPublic(a,b,v),r=>{ $('pswIn').value=''; pswQ=null; logAct({t:'Swapped '+a+' → '+b,s:where+' · via '+r.route.join(' → '),amt:'+'+tiny(E.fmt(b,r.out))+' '+b}); refreshAll(); loadPool(p,35).then(render);
      doneBlock('Got '+tiny(E.fmt(b,r.out))+' '+b,priv?'Delivered as a new shielded note. The swap\'s amounts were public at the pool; who made it was not.':'Delivered to your wallet.',r.tx); }); }
};

/* ---------- sealed swaps: claim / refund ---------- */
document.addEventListener('click',e=>{ const b=e.target.closest('[data-sc]'); if(!b) return; const x=SEAL.mine.find(y=>y.id===b.dataset.sc); if(!x) return; const ref=x.state==='refund';
  runAct(ref?'Taking your swap back':'Claiming your swap','proof',()=>E.sealedClaim(x),r=>{ logAct({t:(ref?'Refunded sealed swap · ':'Claimed sealed swap · ')+x.pair,s:'Batch '+x.seq+' · into a hidden note',amt:'+'+tiny(E.fmt(r.sym,r.value))+' '+r.sym}); refreshAll(); loadSealed(cur()).then(render);
    doneBlock((ref?'Refunded ':'Claimed ')+tiny(E.fmt(r.sym,r.value))+' '+r.sym,ref?'Batch '+x.seq+' did not settle, so your '+x.sym+' came back as a new hidden note (minus the relayer\'s flat fee).':'Your share of batch '+x.seq+' at its clearing price, delivered as a new hidden note. The chain saw a nullifier and a commitment, not the amount.',r.tx); }); });
/* ---------- position actions ---------- */
document.addEventListener('click',e=>{ const b=e.target.closest('[data-pa]'); if(b){ const q=E.myPositions().find(x=>x.id===b.dataset.id); if(q) ({claim:claimDlg,reward:rewardDlg,rebalance:rebalDlg,withdraw:withdrawDlg})[b.dataset.pa](q); }
  const w=e.target.closest('[data-ow]'); if(w){ const o=E.myOrders().find(x=>x.id===w.dataset.ow); if(o) orderWdDlg(o); } });
const KIND=q=>q.kind==='public'?'wallet':q.kind==='shielded'?'proof':'sign';
const destSeg=(id)=>'<div class="lbl"><span>Send to</span></div><div class="seg full" id="'+id+'" role="group"><button type="button" data-d="notes" aria-pressed="true">Private balance</button><button type="button" data-d="addr" aria-pressed="false">An address</button></div><div class="fld" id="'+id+'A" hidden><input type="text" id="'+id+'To" placeholder="Fresh Solana address" autocomplete="off" spellcheck="false" aria-label="Recipient address"></div>';
function wireDest(id){ let d='notes'; $(id).onclick=e=>{ const b=e.target.closest('[data-d]'); if(!b) return; d=b.dataset.d; $(id).querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); $(id+'A').hidden=d!=='addr'; };
  return ()=>{ if(d!=='addr') return {to:null}; const t=($(id+'To').value||'').trim(); if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return {err:'Enter a full Solana address.'}; return {to:t}; }; }
function claimDlg(q){ const i=PI[q.id]; const priv=q.kind!=='public'; const sh=q.kind==='shielded';
  openModal('<h3 id="dlgTitle">Claim fees · '+q.x+'–'+q.y+'</h3><dl class="dl"><div><dt>'+q.x+'</dt><dd>'+amt(q.x,i.fees.x)+'</dd></div><div><dt>'+q.y+'</dt><dd>'+amt(q.y,i.fees.y)+'</dd></div></dl>'+(sh?'<p class="hint">'+ic('lock')+'<span>A proof made on this device claims what your shares earned into new notes; nobody sees how much. The fee growth includes what the pool has collected so far; the rest arrives with the next harvest. The relayer\'s flat fee comes out of the claim.</span></p>':priv?destSeg('cD')+'<p class="hint">'+ic('lock')+'<span>The position key signs here; a relayer submits and takes its fee from the claim. Claims too small to cover the relayer\'s cost are refused, not charged.</span></p>':'<p class="hint warn">'+ic('alert')+'<span>Paid to your wallet, in public.</span></p>')+'<p class="err" id="cErr"></p><button class="btn" type="button" id="cGo">Claim</button>');
  const dest=priv&&!sh?wireDest('cD'):()=>({to:null});
  $('cGo').onclick=()=>{ const d=dest(); if(d.err) return $('cErr').textContent=d.err;
    runAct('Claiming fees',sh?'proof':KIND(q),()=>E.claimFees(q,{to:d.to}),r=>{ logAct({t:'Claimed fees · '+q.x+'–'+q.y,s:(priv?(d.to?'To '+short(d.to):'To shielded balance'):'To wallet'),amt:amt(q.x,r.x)+' '+q.x+' + '+amt(q.y,r.y)+' '+q.y}); refreshAll();
      doneBlock('Fees claimed',amt(q.x,r.x)+' '+q.x+' and '+amt(q.y,r.y)+' '+q.y+(priv?(d.to?' sent to '+short(d.to)+'.':' are in your shielded balance as new notes.'):' are in your wallet.'),r.tx); }); }; }
function rewardDlg(q){ const i=PI[q.id]; const p=byAddr(q.pool); const list=i.rewards.map((v,k)=>({v,k})).filter(r=>r.v>0n); const rs=k=>{ const s=p.st&&p.st.rewards.find(r=>r.index===k); return s&&s.sym||'reward'; };
  openModal('<h3 id="dlgTitle">Claim rewards · '+q.x+'–'+q.y+'</h3><dl class="dl">'+list.map(r=>'<div><dt>Slot '+(r.k+1)+'</dt><dd>'+tiny(E.fmt(rs(r.k),r.v))+' '+rs(r.k)+'</dd></div>').join('')+'</dl><p class="hint">'+ic(q.kind!=='public'?'lock':'alert')+'<span>'+(q.kind!=='public'?'Into a new note in your shielded balance.':'Paid to your wallet, in public.')+'</span></p><button class="btn" type="button" id="rGo">Claim '+rs(list[0].k)+'</button>');
  $('rGo').onclick=()=>runAct('Claiming rewards',KIND(q),()=>E.claimReward(q,list[0].k),r=>{ logAct({t:'Claimed rewards · '+q.x+'–'+q.y,s:q.kind!=='public'?'To shielded balance':'To wallet',amt:tiny(E.fmt(r.sym||rs(list[0].k),r.amount))+' '+(r.sym||'')}); refreshAll(); doneBlock('Rewards claimed',tiny(E.fmt(r.sym,r.amount))+' '+r.sym+(q.kind!=='public'?' in your shielded balance.':' in your wallet.'),r.tx); }); }
function rebalDlg(q){ const p=byAddr(q.pool); const i=PI[q.id]; const priv=q.kind!=='public'; let lim=null, n=q.hi-q.lo+1, L=0, Hh=0, shape=q.shape==='bidAsk'?'bidask':q.shape;
  const place=()=>{ if(lim!==null) n=Math.max(1,Math.min(lim,n)); L=i.active-Math.floor((n-1)/2); Hh=L+n-1; };
  openModal('<h3 id="dlgTitle">Rebalance · '+q.x+'–'+q.y+'</h3><p>Burns the position and re-adds it around the current price in one instruction. Fees already earned stay claimable.</p><dl class="dl"><div><dt>Now</dt><dd>'+tiny(hp(p,q.lo))+' – '+tiny(hp(p,q.hi))+' · '+(q.hi-q.lo+1)+' bins</dd></div><div><dt>New</dt><dd id="rbNew"></dd></div><div><dt>Bins</dt><dd id="rbN"></dd></div></dl>'+
    '<div class="shape" id="rbShape" role="group" aria-label="Shape"><button type="button" data-s="spot">Spot</button><button type="button" data-s="curve">Curve</button><button type="button" data-s="bidask">Bid-Ask</button></div>'+
    '<div class="presets" id="rbW"><button type="button" data-w="-2">Narrower</button><button type="button" data-w="2">Wider</button></div><p class="quiet" id="rbLim"><i></i>Checking how many bins fit one transaction…</p>'+
    '<p class="hint">'+ic(priv?'lock':'alert')+'<span>'+(q.kind==='shielded'?'Inside the position\'s 16-bin window this is one proof: the old bins are burned and the new shape minted from the proceeds. Outside it, two: a removal into notes, then a new position from them.':priv?'Signed by the position key on this device. The relayer\'s fee is withheld from the burned amounts; anything the new shape cannot use returns as notes.':'Your wallet signs. Leftovers return to your wallet.')+'</span></p><p class="err" id="rbErr"></p><button class="btn" type="button" id="rbGo" disabled>Rebalance</button>');
  const upd=()=>{ place(); $('rbNew').textContent=tiny(hp(p,L))+' – '+tiny(hp(p,Hh)); $('rbN').textContent=String(n); $('rbShape').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.s===shape)); }; upd();
  E.rebalanceLimit(q).then(m=>{ lim=m; if($('rbLim')) { $('rbLim').innerHTML='<i></i>'+(q.kind==='shielded'?'A shielded position covers up to '+m+' bins.':'The old and new bins travel in one transaction: up to '+m+' new bin'+(m===1?'':'s')+' for this position.'); upd(); $('rbGo').disabled=!(m>0); } }).catch(e=>{ if($('rbErr')) $('rbErr').textContent=e.message; });
  $('rbShape').onclick=e=>{ const b=e.target.closest('[data-s]'); if(b){ shape=b.dataset.s; upd(); } };
  $('rbW').onclick=e=>{ const b=e.target.closest('[data-w]'); if(!b) return; n=Math.max(1,n+(+b.dataset.w)); upd(); };
  $('rbGo').onclick=()=>{ const lo_=L, hi_=Hh, sh=shape; runAct('Rebalancing',q.kind==='shielded'?'proof':KIND(q),()=>E.rebalance(q,{lo:lo_,hi:hi_,shape:sh}),r=>{ logAct({t:'Rebalanced · '+q.x+'–'+q.y,s:(priv?'Private':'Public')+' · '+(hi_-lo_+1)+' bins around '+tiny(hp(p,i.active)),amt:''}); refreshAll(); loadPool(p,35).then(render); doneBlock('Rebalanced','Your position now covers '+tiny(hp(p,lo_))+' – '+tiny(hp(p,hi_))+' '+q.y+'.',r.tx); }); }; }
function withdrawDlg(q){ const i=PI[q.id]; const priv=q.kind!=='public'; const sh=q.kind==='shielded'; let pc=100;
  openModal('<h3 id="dlgTitle">Withdraw · '+q.x+'–'+q.y+'</h3><dl class="dl"><div><dt>'+q.x+'</dt><dd>'+amt(q.x,i.value.x)+'</dd></div><div><dt>'+q.y+'</dt><dd>'+amt(q.y,i.value.y)+'</dd></div></dl><div class="seg full" id="wdPct" role="group" aria-label="Share to withdraw"><button type="button" data-p="25" aria-pressed="false">25%</button><button type="button" data-p="50" aria-pressed="false">50%</button><button type="button" data-p="100" aria-pressed="true">100%</button></div>'+
    (sh?'<p class="hint">'+ic('lock')+'<span>Back into your shielded balance as new notes. Public: the shares this removes per bin and what they pay out, not your position\'s size or who you are. Your fees so far are claimed into notes in the same proof.</span></p>':priv?destSeg('wD'):'<p class="hint warn">'+ic('alert')+'<span>Paid to your wallet, in public.</span></p>')+(sh?'':'<p class="hint">'+ic('clock')+'<span>Unclaimed fees and rewards stay with the position until you claim them.</span></p>')+'<p class="err" id="wdErr"></p><button class="btn" type="button" id="wdGo">Withdraw</button>');
  $('wdPct').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; pc=+b.dataset.p; $('wdPct').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b)); };
  const dest=priv&&!sh?wireDest('wD'):()=>({to:null});
  $('wdGo').onclick=()=>{ const d=dest(); if(d.err) return $('wdErr').textContent=d.err;
    runAct('Withdrawing',sh?'proof':KIND(q),()=>E.removeLiquidity(q,pc,{to:d.to}),r=>{ logAct({t:'Withdrew liquidity · '+q.x+'–'+q.y,s:pc+'% · '+(priv?(d.to?'to '+short(d.to):'to shielded balance'):'to wallet'),amt:''}); refreshAll(); const p=byAddr(q.pool); if(p) loadPool(p,35).then(render);
      doneBlock('Withdrew '+pc+'%',priv?(d.to?'Sent to '+short(d.to)+'. On-chain it came from the pool.':'Back in your shielded balance: '+amt(q.x,r.x)+' '+q.x+' and '+amt(q.y,r.y)+' '+q.y+'.'):'Back in your wallet.',r.tx); }); }; }
function orderWdDlg(o){ const i=OI[o.id]; const priv=o.kind!=='public'; const sh=o.kind==='shielded';
  openModal('<h3 id="dlgTitle">Withdraw order</h3><dl class="dl"><div><dt>Side</dt><dd>'+(o.isAsk?'Sell ':'Buy ')+o.x+'</dd></div><div><dt>Status</dt><dd>'+(i&&!i.err?(i.filled?'Filled':'Open'):'—')+'</dd></div>'+(i&&!i.err?(o.isAsk?'<div><dt>Unfilled</dt><dd>'+amt(o.x,i.unfilledX)+' '+o.x+'</dd></div><div><dt>Received</dt><dd>'+amt(o.y,i.filledY)+' '+o.y+'</dd></div>':'<div><dt>Unfilled</dt><dd>'+amt(o.y,i.unfilledY)+' '+o.y+'</dd></div><div><dt>Received</dt><dd>'+amt(o.x,i.filledX)+' '+o.x+'</dd></div>'):'')+'</dl>'+
    (sh?'<p class="hint">'+ic('lock')+'<span>A proof spends your order notes; the order\'s unfilled and filled parts come back as new notes.</span></p>':priv?destSeg('oD'):'<p class="hint warn">'+ic('alert')+'<span>Paid to your wallet, in public.</span></p>')+'<p class="err" id="oErr"></p><button class="btn" type="button" id="oGo">Withdraw order</button>');
  const dest=priv&&!sh?wireDest('oD'):()=>({to:null});
  $('oGo').onclick=()=>{ const d=dest(); if(d.err) return $('oErr').textContent=d.err;
    runAct('Withdrawing the order',sh?'proof':KIND(o),()=>E.withdrawOrder(o,{to:d.to}),r=>{ logAct({t:'Order withdrawn · '+o.x+'–'+o.y,s:(r.filled?'Filled · ':'')+(priv?(d.to?'to '+short(d.to):'to shielded balance'):'to wallet'),amt:amt(o.x,r.x)+' '+o.x+' + '+amt(o.y,r.y)+' '+o.y}); refreshAll(); const p=byAddr(o.pool); if(p) loadPool(p,35).then(render);
      doneBlock('Order withdrawn',amt(o.x,r.x)+' '+o.x+' and '+amt(o.y,r.y)+' '+o.y+(priv?(d.to?' sent to '+short(d.to)+'.':' back in your shielded balance.'):' back in your wallet.'),r.tx); }); }; }

/* ---------- portfolio ---------- */
function renderHome(){
  if(!LIVE){ $('posList').innerHTML='<div class="card empty"><b>No positions</b>Nothing here yet.</div>'; $('ordList').innerHTML='<div class="card empty">No orders.</div>'; $('veylAddr').hidden=true; $('balList').innerHTML='<p class="dim" style="margin:0;font-size:14px">Connect a wallet to see your private balance.</p><p hidden>No notes yet.</p>'; $('noteList').innerHTML=''; $('noteH').hidden=true; $('homeAct').innerHTML='<div class="card empty">No activity yet.</div>'; return; }
  if(S.loading){ const sk='<div class="card pad"><span class="skel" style="width:40%"></span><span class="skel" style="width:70%;margin-top:10px"></span></div>'; $('posList').innerHTML=sk; $('balList').innerHTML='<span class="skel" style="width:50%"></span>'; return; }
  const ps=E.myPositions().filter(q=>!PI[q.id]||PI[q.id].err||PI[q.id].open||PI[q.id].fees.x>0n||PI[q.id].fees.y>0n||PI[q.id].rewards.some(r=>r>0n));
  renderPfSum(ps); $('posList').innerHTML=ps.length?ps.map(posCard).join(''):'<div class="card empty"><b>No positions yet</b>'+(E.account?'Open a pool and add liquidity, privately or from your wallet.':'Connect a wallet. Private positions made on this device show here too.')+'</div>';
  if(SBX){ const ks=Object.keys(E.tokens); $('pubCard').hidden=false; $('pubCard').innerHTML='<div class="k" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><b style="font-weight:500">Wallet</b><span class="pill flat">'+ic('wallet')+'Public · '+esc(short(E.account))+'</span></div><div class="toks">'+ks.map(k=>'<div style="display:flex;align-items:center;gap:8px">'+tokImg(k)+'<b class="sens" style="font-weight:500">'+tiny(bal('pub',k))+'</b><span class="dim">'+k+'</span></div>').join('')+'</div><div class="quick" style="margin-top:12px"><button type="button" data-faucet>Top up</button><button type="button" data-sbxreset>Start over</button></div>'; }
  const os=E.myOrders().slice().reverse().slice(0,20); $('ordList').innerHTML=os.length?os.map(ordRow).join(''):'<div class="card empty">No limit orders.</div>';
  const ks=Object.keys(E.tokens).filter(k=>bal('priv',k)>1e-12);
  $('balList').innerHTML=ks.length?ks.map(k=>'<div>'+tokImg(k)+'<b class="sens">'+tiny(bal('priv',k))+'</b><span>'+k+'</span></div>').join(''):'<p class="dim" style="margin:0;font-size:14px">'+(E.shieldError?'Could not read the shielded pool: '+esc(E.shieldError):E.account?'Nothing shielded yet. '+(SBX?'Top up from your wallet card.':'Deposit to start, or share your Veyl address to be paid privately.')+'':'Nothing shielded yet. Share your Veyl address to be paid privately, or connect a wallet to deposit.')+'</p>';
  const va=E.veylAddress(); $('veylAddr').innerHTML='<div class="mid"><small>Your Veyl address · paid here, nobody sees the amount or that it was you</small><code class="sens">'+esc(va)+'</code></div><div class="vbtns"><button class="btn sm ghost" type="button" data-copy="'+esc(va)+'">Copy</button><button class="btn sm ghost" type="button" data-open="receive" title="QR code and payment link"><svg class="ic sm"><use href="#i-qr"/></svg>Receive</button></div>';
  const pend=(E.shieldPendingNow||[]); const notes=E.shieldNotes().slice().sort((a,b)=>b.index-a.index); const leg=E.legacyNotes();
  const symOfMint=m=>Object.keys(E.tokens).find(k=>E.tokens[k].mint===String(m))||'?';
  $('noteList').innerHTML=(pend.filter(d=>symOfMint(d.mint)!=='?').map(d=>'<div class="row"><div class="mid"><b class="sens">'+tiny(E.fmt(symOfMint(d.mint),BigInt(d.amount)))+' '+symOfMint(d.mint)+'</b><small>'+(SBX?'Deposit waiting for the approved-set publisher (a few seconds)':'Deposit waiting for the approved-set publisher · yours to take back until then')+'</small></div><div class="rt"><span class="pill warn">Pending</span>'+(SBX?'':'<div style="margin-top:6px"><button class="btn sm ghost" type="button" data-cancel="'+esc(d.pending)+'">Take back</button></div>')+'</div></div>').join('')+
    leg.map(n=>'<div class="row"><div class="mid"><b class="sens">'+tiny(E.fmt(n.sym,BigInt(n.value)))+' '+n.sym+'</b><small>Phase 1 note · leaf '+n.index+' · its amount was public</small></div><div class="rt"><span class="pill flat">Legacy</span><div style="margin-top:6px"><button class="btn sm ghost" type="button" data-migrate="'+esc(n.precommitment||n.commitment)+'">Move in</button></div></div></div>').join(''))
    ||''; $('noteH').hidden=!$('noteList').innerHTML;
  $('homeAct').innerHTML=S.activity.length?S.activity.slice(0,4).map(actRow).join(''):'<div class="card empty">No activity yet.</div>';
}

/* ---------- deposit / send privately ---------- */
function assetSeg(id){ const ks=Object.keys(E.tokens); return '<div class="seg full" id="'+id+'" role="group" aria-label="Asset" style="flex-wrap:wrap">'+ks.map((k,i)=>'<button type="button" data-a="'+k+'" aria-pressed="'+(i===0)+'">'+k+'</button>').join('')+'</div>'; }
function openDeposit(){ let a=Object.keys(E.tokens)[0];
  openModal('<h3 id="dlgTitle">Deposit</h3><p>Moves tokens from your '+(E.isLocal?'deposit address':'wallet')+' into your private balance. The deposit itself is public: your wallet, the token and the amount. Inside, the notes it creates hide their amounts and owner; what you do with them afterwards is not public.</p>'+assetSeg('dA')+'<div class="fld"><label for="dAmt">Amount</label><input id="dAmt" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"><small id="dBal"></small></div><p class="err" id="dErr"></p><button class="btn" type="button" id="dGo">Deposit</button>');
  const upd=()=>{ $('dBal').textContent=(E.isLocal?'In your deposit address: ':'In your wallet: ')+tiny(bal('pub',a))+' '+a; document.querySelectorAll('#dA button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.a===a)); }; upd();
  $('dA').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; a=b.dataset.a; upd(); };
  $('dGo').onclick=()=>{ const v=parseFloat($('dAmt').value); if(!(v>0)) return $('dErr').textContent='Enter an amount above zero.'; if(v>bal('pub',a)+1e-12) return $('dErr').textContent='Your wallet has '+tiny(bal('pub',a))+' '+a+'.';
    runAct('Depositing','wallet',()=>E.deposit(a,v),n=>{ logAct({t:'Deposited to shielded balance',s:'From '+short(ME),amt:'+'+tiny(v)+' '+a}); refreshAll(); doneBlock('Deposited '+tiny(v)+' '+a,SBX?'The approved-set publisher admits it into the shielded pool in a few seconds.':'The approved-set publisher admits it into the shielded pool, usually within seconds; until then you can take it back. Back up your keys: they are the only key to these funds.',n.tx); }); }; }
function openWithdraw(pre){ pre=pre||{}; let a=(pre.sym&&E.tokens[pre.sym])?pre.sym:Object.keys(E.tokens)[0];
  openModal('<h3 id="dlgTitle">Send privately</h3><p>From your shielded balance. To a <b>Veyl address</b> it stays inside the pool: nobody sees the amount, the sender or the receiver. To a <b>Solana address</b> it leaves the pool: the amount and the receiver are public, not where it came from.</p>'+assetSeg('wA')+'<div class="fld"><label for="wAmt">Amount</label><input id="wAmt" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off"><small id="wBal"></small></div><div class="fld"><label for="wTo">To</label><input id="wTo" type="text" placeholder="veyl:… or a fresh Solana address" autocomplete="off" spellcheck="false"><small id="wKind"></small>'+(SBX?'<div class="quick"><button type="button" id="wMara">Mara\'s Veyl address</button><button type="button" id="wFresh">A fresh Solana address</button></div>':'')+'</div><p class="err" id="wErr"></p><button class="btn" type="button" id="wGo">Send</button><p class="hint">'+ic('lock')+'<span>The relayer submits and takes a flat fee in the token sent, so the token is visible; the amount is not.</span></p>');
  const upd=()=>{ $('wBal').textContent='Private: '+tiny(bal('priv',a))+' '+a; document.querySelectorAll('#wA button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.a===a)); }; upd();
  $('wA').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; a=b.dataset.a; upd(); };
  $('wTo').addEventListener('input',()=>{ const t=$('wTo').value.trim(); $('wKind').textContent=t.startsWith('veyl:')?'Veyl address: stays shielded':/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)?'Solana address: leaves the shielded pool':''; });
  if(SBX){ const fill=v=>{ $('wTo').value=v; $('wTo').dispatchEvent(new Event('input')); }; $('wMara').onclick=()=>fill(E.friendAddress()); $('wFresh').onclick=()=>fill(E.freshAddress()); }
  if(pre.to){ $('wTo').value=pre.to; $('wTo').dispatchEvent(new Event('input')); if(pre.amt>0) $('wAmt').value=String(pre.amt); $('dlgTitle').textContent='Pay privately'; $('wKind').textContent='Payment request · Veyl address: stays shielded'; }
  $('wGo').onclick=()=>{ const v=parseFloat($('wAmt').value), to=($('wTo').value||'').trim(); $('wErr').textContent=''; const inside=to.startsWith('veyl:');
    if(!(v>0)) return $('wErr').textContent='Enter an amount above zero.'; if(v>bal('priv',a)+1e-12) return $('wErr').textContent='Your shielded balance has '+tiny(bal('priv',a))+' '+a+'.';
    if(!inside&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return $('wErr').textContent='Enter a Veyl address (veyl:…) or a full Solana address.';
    runAct('Sending privately','proof',()=>E.withdraw(a,v,to),r=>{ logAct({t:inside?'Sent inside the shielded pool':'Sent from shielded balance',s:'To '+(inside?'a Veyl address':short(to)),amt:'−'+tiny(v)+' '+a}); refreshAll(); doneBlock('Sent '+tiny(v)+' '+a,inside?'Delivered as a note only the receiver can read. On chain: two spent notes and two new ones, no amount.'+(SBX&&to===E.friendAddress()?' Mara\'s shielded '+a+' here: '+tiny(E.fmt(a,E.friendBalance(a)))+'.':''):'Delivered to '+short(to)+'. On-chain it came from the pool, not from you.',r.tx); }); }; }

/* ---------- receive: payment requests (link + QR) ---------- */
const PAYRE=/^veyl:[1-9A-HJ-NP-Za-km-z]{80,96}$/;
function payLink(addr,amt,sym){ let q='pay='+encodeURIComponent(addr); if(amt>0) q+='&a='+encodeURIComponent(String(amt))+'&t='+encodeURIComponent(sym); return location.origin+location.pathname+'#'+q; }
function qrSvg(text){ if(typeof window.qrcode!=='function') return ''; const q=window.qrcode(0,'M'); q.addData(text); q.make(); const n=q.getModuleCount(), m=4; let d='';
  for(let r=0;r<n;r++) for(let c=0;c<n;c++) if(q.isDark(r,c)) d+='M'+(c+m)+' '+(r+m)+'h1v1h-1z';
  return '<svg class="qrsvg" viewBox="0 0 '+(n+2*m)+' '+(n+2*m)+'" role="img" aria-label="QR code of the payment link" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="'+d+'" fill="#0A0B09"/></svg>'; }
function openReceive(){ const addr=E.veylAddress(); let a=Object.keys(E.tokens).includes('USDC')?'USDC':Object.keys(E.tokens)[0];
  openModal('<h3 id="dlgTitle">Receive privately</h3><p>Share your Veyl address, a link or the QR code. A payment to it lands in your private balance: nobody sees the amount, who sent it or that it was you.</p>'+
    '<div class="rcv"><div class="qrbox" id="rQr"></div><div class="rcvr"><div class="fld"><label for="rAmt">Amount (optional)</label><input id="rAmt" type="text" inputmode="decimal" placeholder="Any amount" autocomplete="off"></div>'+assetSeg('rA')+'</div></div>'+
    '<div class="vaddr"><div class="mid"><small>Your Veyl address</small><code class="sens">'+esc(addr)+'</code></div><button class="btn sm ghost" type="button" data-copy="'+esc(addr)+'">Copy</button></div>'+
    '<button class="btn" type="button" id="rLink">Copy payment link</button><p class="hint">'+ic('lock')+'<span>The link carries only your Veyl address and the amount you typed. It never holds keys. Anyone with it can pay you; nobody can spend from it.</span></p>');
  const upd=()=>{ const v=parseFloat($('rAmt').value); document.querySelectorAll('#rA button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.a===a)); const link=payLink(addr,v>0?v:0,a); $('rQr').innerHTML=qrSvg(link); $('rLink').dataset.link=link; };
  $('rA').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; a=b.dataset.a; upd(); };
  $('rAmt').addEventListener('input',upd); $('rLink').onclick=()=>copy($('rLink').dataset.link,'Payment link copied'); upd(); }
function takePayLink(h){ let p; try{ p=new URLSearchParams(h); }catch(e){ return false; } const to=(p.get('pay')||'').trim(); if(!PAYRE.test(to)) return false;
  const amt=parseFloat(p.get('a')), sym=(p.get('t')||'').toUpperCase(); try{ history.replaceState(null,'',location.pathname+location.search+'#portfolio'); }catch(e){}
  setTimeout(()=>{ if(!LIVE||!E){ toast('This page isn\'t connected to Solana, so nothing can be sent from it.','wallet'); return; } if(to===E.veylAddress()){ toast('That payment link is your own.','alert'); return; } openWithdraw({to,amt:amt>0&&amt<1e15?amt:0,sym}); },60); return true; }

/* ---------- encrypted backup and restore ---------- */
function backupDlg(){ openModal('<h3 id="dlgTitle">Back up keys and notes</h3><p>Your shielded account key (spending, viewing and one-time keys all derive from it), every legacy note secret and one-time position key on this device, encrypted here with your passphrase (PBKDF2, 310,000 rounds, AES-256-GCM) before the file is saved. Without the passphrase the file is useless, to you too.</p><div class="fld"><label for="bkP1">Passphrase</label><input id="bkP1" type="password" autocomplete="new-password"><small>At least 8 characters. Nobody can recover it for you.</small></div><div class="fld"><label for="bkP2">Repeat it</label><input id="bkP2" type="password" autocomplete="new-password"></div><p class="err" id="bkErr"></p><button class="btn" type="button" id="bkGo">Encrypt and save</button>');
  $('bkGo').onclick=async()=>{ const a=$('bkP1').value,b=$('bkP2').value; if(a.length<8) return $('bkErr').textContent='Use at least 8 characters.'; if(a!==b) return $('bkErr').textContent='The two passphrases differ.';
    $('bkGo').disabled=true; $('bkGo').textContent='Encrypting…'; try{ const txt=await E.exportEncrypted(a); const u=URL.createObjectURL(new Blob([txt],{type:'application/json'})); const l=document.createElement('a'); l.href=u; l.download='veyl-backup-'+new Date().toISOString().slice(0,10)+'.json'; document.body.appendChild(l); l.click(); l.remove(); setTimeout(()=>URL.revokeObjectURL(u),4000);
      E.store.data.backedUpAt=Date.now(); E.store.save(); doneBlock('Backup saved','An encrypted file with your shielded account key (every shielded note and position is rebuilt from it by scanning the chain), '+E.store.data.notes.length+' legacy notes, '+E.store.data.positions.length+' one-time-key positions and '+(E.store.data.orders.length+((E.store.data.shield||{}).orders||[]).length)+' orders. Keep it and the passphrase apart.'); render(); }
    catch(e){ $('bkErr').textContent=e.message; $('bkGo').disabled=false; $('bkGo').textContent='Encrypt and save'; } }; }
function restoreDlg(){ openModal('<h3 id="dlgTitle">Restore from a backup</h3><p>Merges the backup into this device. Nothing already here is removed.</p><div class="fld"><label for="rsFile">Backup file</label><input id="rsFile" type="file" accept="application/json,.json"></div><div class="fld"><label for="rsP">Passphrase</label><input id="rsP" type="password" autocomplete="current-password"></div><p class="err" id="rsErr"></p><button class="btn" type="button" id="rsGo">Restore</button>');
  $('rsGo').onclick=async()=>{ const f=$('rsFile').files&&$('rsFile').files[0]; if(!f) return $('rsErr').textContent='Choose the backup file.'; $('rsGo').disabled=true; $('rsGo').textContent='Decrypting…';
    try{ const n=await E.importEncrypted(await f.text(),$('rsP').value); S.activity=E.store.data.activity.slice(); await refreshAll(); doneBlock('Restored',n+' item'+(n===1?'':'s')+' added. Positions and notes are read from the chain again.'); }
    catch(e){ $('rsErr').textContent=e.message; $('rsGo').disabled=false; $('rsGo').textContent='Restore'; } }; }

/* ---------- swap page ---------- */
const SW={a:'USDC',b:'SOL',src:'priv',q:null}; let swSeq=0;
async function swQuote(v){ const my=++swSeq, a=SW.a, b=SW.b; try{ const best=await E.quoteRoute(a,b,E.unit(a,v)); if(my!==swSeq) return; SW.q={v,a,b,out:best?E.fmt(b,best.out):null,path:best?best.path:[]}; }catch(e){ if(my!==swSeq) return; SW.q={v,a,b,out:null,path:[]}; } renderSwap(); }
function renderSwap(){
  const priv=SW.src==='priv'; document.querySelectorAll('#swSrc [data-src]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.src===SW.src));
  $('swTokIn').innerHTML=tokImg(SW.a,'')+SW.a+ic('down','xs'); $('swTokOut').innerHTML=tokImg(SW.b,'')+SW.b+ic('down','xs');
  const src=priv?'priv':'pub'; $('swBalIn').textContent=LIVE&&(priv||E.account)?'Balance '+tiny(bal(src,SW.a)):''; $('swBalOut').textContent=LIVE&&(priv||E.account)?'Balance '+tiny(bal(src,SW.b)):'';
  const v=parseFloat($('swIn').value)||0; const q=SW.q&&SW.q.v===v&&SW.q.a===SW.a&&SW.q.b===SW.b?SW.q:null; if(LIVE&&v>0&&!q) swQuote(v);
  $('swOut').value=q&&q.out!=null?tiny(q.out):(v>0&&LIVE?'…':'');
  $('swRoute').innerHTML=!LIVE?'<div class="top"><b>Route</b></div><p class="dim" style="margin:0">Routes are computed on this device from the pools\' on-chain bins: direct, or through one hub.</p>'
    :q&&q.out!=null?'<div class="top"><b>Route</b><span class="pill flat">'+q.path.length+(q.path.length>1?' hops':' hop')+'</span></div><div class="path">'+'<span class="node">'+tokImg(SW.a,'')+SW.a+'</span>'+q.path.map(h=>'<span class="dim">'+ic('right','sm')+'</span><span class="node">'+tokImg(h.out,'')+h.out+'</span>').join('')+'</div><dl class="det"><div><dt>Rate</dt><dd>1 '+SW.a+' = '+tiny(q.out/v)+' '+SW.b+'</dd></div><div><dt>Pools</dt><dd>'+q.path.map(h=>h.name).join(' · ')+'</dd></div><div><dt>Slippage limit</dt><dd>1%</dd></div><div><dt>Network fee</dt><dd>'+(priv?'Relayer, a flat fee':'≈ 0.00001 SOL')+'</dd></div></dl>'
    :q&&q.out==null?'<div class="top"><b>Route</b></div><p class="dim" style="margin:0">No route with liquidity for this pair right now.</p>':'<div class="top"><b>Route</b></div><p class="dim" style="margin:0">Enter an amount to see the best route.</p>';
  $('swSeen').innerHTML=priv?seen('Your wallet. The output lands in a new note on this device.','The route, the amounts in and out, the relayer fee.'):seen('Nothing.','Your wallet and the whole swap.');
  const g=$('swGo'); g.className='btn'+(priv?'':' ghost'); const bk=blocker(SW.src);
  const why=bk||(!(v>0)?'Enter an amount':v>bal(src,SW.a)+1e-12?'Not enough '+SW.a:!q?'Quoting…':q.out==null?'No route':''); g.disabled=!!why; g.innerHTML=why||(priv?ic('lock','sm')+'Swap privately':'Swap from wallet');
  const h=$('swHint'); if(priv){ h.className='hint'; h.innerHTML=ic('lock')+'<span>The chain sees a swap through the pools, not who made it.</span>'; } else { h.className='hint warn'; h.innerHTML=ic('alert')+'<span>This swap is public and linked to your wallet.</span>'; }
}
$('swSrc').onclick=e=>{ const b=e.target.closest('[data-src]'); if(!b) return; SW.src=b.dataset.src; renderSwap(); };
$('swIn').addEventListener('input',()=>{ clean($('swIn')); renderSwap(); });
$('swMax').onclick=()=>{ const b=bal(SW.src==='priv'?'priv':'pub',SW.a); $('swIn').value=b>0?String(b>=100?Math.floor(b):+b.toFixed(4)):''; renderSwap(); };
$('swFlip').onclick=()=>{ [SW.a,SW.b]=[SW.b,SW.a]; $('swIn').value=''; SW.q=null; renderSwap(); };
function tokPicker(side){ const ks=LIVE?Object.keys(E.tokens):Object.keys(TK); const src=SW.src==='priv'?'priv':'pub';
  openModal('<h3 id="dlgTitle">Select a token</h3><div class="plist">'+ks.map(k=>'<button class="row" type="button" data-pick="'+k+'">'+tokImg(k)+'<div class="mid"><b>'+k+'</b><small>'+tkOf(k).name+'</small></div><div class="rt"><b class="sens">'+(LIVE?tiny(bal(src,k)):'')+'</b></div></button>').join('')+'</div>');
  $('dlgBody').querySelector('.plist').onclick=e=>{ const b=e.target.closest('[data-pick]'); if(!b) return; const k=b.dataset.pick;
    if(side==='a'){ if(k===SW.b) SW.b=SW.a; SW.a=k; } else { if(k===SW.a) SW.a=SW.b; SW.b=k; } SW.q=null; closeModal(); renderSwap(); }; }
$('swTokIn').onclick=()=>tokPicker('a'); $('swTokOut').onclick=()=>tokPicker('b');
$('swGo').onclick=()=>{ const v=parseFloat($('swIn').value)||0, a=SW.a, b=SW.b, priv=SW.src==='priv';
  runAct('Swapping',priv?'proof':'wallet',()=>priv?E.swap(a,b,v):E.swapPublic(a,b,v),res=>{ logAct({t:'Swapped '+a+' → '+b,s:(priv?'Private':'Public')+' · via '+res.route.join(' → '),amt:'+'+tiny(E.fmt(b,res.out))+' '+b}); $('swIn').value=''; SW.q=null; refreshAll();
    doneBlock('Got '+tiny(E.fmt(b,res.out))+' '+b,priv?'Routed through Veyl pools into a new shielded note. The amounts were public at the pool; nothing on-chain connects them to you.':'Settled to your wallet.',res.tx); }); };

/* ---------- activity ---------- */
function actRow(a){ return '<div class="row"><div class="mid"><b>'+esc(a.t)+'</b><small>'+esc(a.s)+' · '+age(Date.now()-a.ts)+' ago</small></div><div class="rt"><b class="sens">'+esc(a.amt||'')+'</b></div></div>'; }
function renderActivity(){ $('actList').innerHTML=S.activity.length?S.activity.map(actRow).join(''):'<div class="card empty">No activity yet. Deposits, swaps, positions and orders show up here, visible only on this device.</div>';
  if(LIVE&&!SBX){ $('ledgerWrap').hidden=false; $('ledgerWrap').querySelector('h2').textContent='On-chain swaps'; $('ledgerWrap').querySelector('p').textContent='The most recent swaps through the deployment\'s pools, read from '+CHAIN+'.';
    const L=E.recentChain(40); $('ledger').innerHTML=L.map(x=>'<div class="row"><div class="mid"><b>'+(x.xForY?x.x+' → '+x.y:x.y+' → '+x.x)+' · '+x.x+'–'+x.y+'</b><small><code>'+esc(x.sig.slice(0,10))+'…</code> · '+age(Date.now()-x.t*1000)+' ago'+(CFG.explorer?' · <a href="'+esc(CFG.explorer)+'/tx/'+esc(x.sig)+esc(CFG.explorerSuffix||'')+'" target="_blank" rel="noopener">view</a>':'')+'</small></div><div class="rt"><b>'+amt(x.xForY?x.x:x.y,x.amountIn)+' '+(x.xForY?x.x:x.y)+'</b></div></div>').join('')||'<div class="card empty">No swaps read yet.</div>'; return; }
  $('ledgerWrap').hidden=true; if(false){ const L=E.activityLog().slice(0,40); $('ledger').innerHTML=L.map(x=>{ const f=x.seen&&x.seen.pub&&x.seen.pub[0]; return '<details class="row" style="display:block"><summary style="display:flex;gap:12px;justify-content:space-between;cursor:pointer;list-style:none"><span class="mid"><b>'+esc(x.kind.replace(/_/g,' '))+'</b><small><code>'+esc(x.id)+'</code> · '+age(Date.now()-x.at)+' ago'+(f?' · '+esc(f[1]).slice(0,80):'')+'</small></span><span class="rt">'+((x.proofs||[]).length?'<span class="pill good">'+x.proofs.length+' proof'+(x.proofs.length>1?'s':'')+' verified</span>':'<span class="pill flat">no proof</span>')+'</span></summary>'+(x.seen?receiptHtml(x.id):'')+'</details>'; }).join('')||'<div class="card empty">Nothing yet.</div>'; } }

/* ---------- header: wallet, backup, hide ---------- */
function copy(text,msg){ const fail=()=>toast('Copy is blocked here. Select the text to copy it.','alert'); try{ navigator.clipboard.writeText(text).then(()=>toast(msg||'Copied'),fail); }catch(e){ fail(); } }
document.addEventListener('click',e=>{
  const o=e.target.closest('[data-open]'); if(o){ if(!LIVE){ toast('This page isn\'t connected to Solana, so nothing can be sent from it.','wallet'); return; } if(o.dataset.open==='deposit'&&!E.account){ openStart(); return; } ({deposit:openDeposit,withdraw:openWithdraw,receive:openReceive})[o.dataset.open](); }
  const bk=e.target.closest('[data-backup]'); if(bk){ $('acctPop').hidden=true; if(!LIVE){ toast('Nothing to back up yet.','key'); return; } (bk.dataset.backup==='export'?backupDlg:restoreDlg)(); }
  const c=e.target.closest('[data-copy]'); if(c) copy(c.dataset.copy,'Address copied');
  const mg=e.target.closest('[data-migrate]'); if(mg){ const n=E.legacyNotes().find(x=>(x.precommitment||x.commitment)===mg.dataset.migrate); if(n) runAct('Moving a note into the shielded pool','proof',()=>E.migrate(n),r=>{ logAct({t:'Moved into the shielded pool',s:'Legacy note · one proof',amt:tiny(E.fmt(n.sym,BigInt(n.value)))+' '+n.sym}); refreshAll(); doneBlock('Moved in','The note is now a shielded note. Its amount was already public; from here on what you do with it is not.',r.tx); }); }
  const cd=e.target.closest('[data-cancel]'); if(cd){ const d=(E.shieldPendingNow||[]).find(x=>x.pending===cd.dataset.cancel); if(d) runAct('Taking a deposit back','wallet',()=>E.cancelDeposit(d),tx=>{ logAct({t:'Deposit taken back',s:'Before approval',amt:''}); refreshAll(); doneBlock('Taken back','The deposit went back to your wallet. Nothing entered the shielded pool.',tx); }); }
});
$('acctBtn').onclick=async e=>{ e.stopPropagation(); if(!LIVE){ openStart(); return; }
  if(SBX){ const pop=$('acctPop'); pop.innerHTML='<span class="k">Demo wallet (public, in this browser)</span><button class="btn ghost" type="button" data-copy="'+ME+'">'+short(ME)+' · copy</button><span class="k">Veyl address (to be paid privately)</span><button class="btn ghost" type="button" data-copy="'+esc(E.veylAddress())+'">'+esc(E.veylAddress().slice(0,11))+'…'+esc(E.veylAddress().slice(-6))+' · copy</button><span class="k">Demo</span><button class="btn" type="button" data-faucet>Top up</button><button class="btn ghost" type="button" data-sbxreset>Start over</button>'; pop.hidden=!pop.hidden; return; }
  if(!E.account){ openStart(); return; }
  const pop=$('acctPop'); pop.innerHTML=(E.isLocal?'<span class="k">Deposit address (public, kept in this browser)</span><button class="btn ghost" type="button" data-copy="'+ME+'">'+short(ME)+' · copy</button><button class="btn ghost" type="button" data-fund>Fund it</button><button class="btn ghost" type="button" data-sweep>Send what\'s left out</button>':'<span class="k">Wallet</span><button class="btn ghost" type="button" data-copy="'+ME+'">'+short(ME)+' · copy</button>')+'<span class="k">Veyl address (to be paid privately)</span><button class="btn ghost" type="button" data-copy="'+esc(E.veylAddress())+'">'+esc(E.veylAddress().slice(0,11))+'…'+esc(E.veylAddress().slice(-6))+' · copy</button>'+(S.faucet?'<button class="btn ghost" type="button" data-drip>Get test tokens</button>':'')+'<span class="k">Keys and notes on this device</span><button class="btn ghost" type="button" data-backup="export">Back up (encrypted)</button><button class="btn ghost" type="button" data-backup="import">Restore from backup</button>'+(E.store.ok?'':'<p class="err">This browser blocks local storage. Notes will be lost when you close the page: back them up after every action.</p>'); pop.hidden=!pop.hidden; };
document.addEventListener('click',e=>{ if(!e.target.closest('#acctPop')) $('acctPop').hidden=true; if(!e.target.closest('#modePop')&&!e.target.closest('#modeBtn')){ $('modePop').hidden=true; $('modeBtn').setAttribute('aria-expanded','false'); } });
/* ---------- mode: Sandbox / Devnet ---------- */
function setMode(m){ try{ localStorage.setItem('veyl:mode',m==='sandbox'?'sandbox-dev':m); }catch(e){} if(SBE) SBE.save(); location.reload(); }
function renderMode(){ const b=$('modeBtn'); b.hidden=!LIVE; if(!LIVE) return; b.className='mchip'+(SBX?'':' dev');
  const mi=SBX?E.marketInfo():null, real=mi&&mi.live;
  b.innerHTML=SBX?'<i></i><span class="lg">Demo</span><span class="sh">Demo</span>':LIVE?'<i></i><span class="lg">On-chain <em>· '+esc(CHAIN)+'</em></span><span class="sh">On-chain</span>':'';
  b.setAttribute('aria-label',SBX?'Demo'+(real?', live market prices':'')+'. Change mode':LIVE?'On-chain: '+CHAIN+'. Change mode':'Solana');
  b.title=MKT&&MKT.why&&MKT.tries&&MKT.tries.length?(real?'Market prices: '+MKT.source+' · ':'No market price. Each source, in order: ')+MKT.why():''; }
$('modeBtn').onclick=e=>{ e.stopPropagation(); if(!SBX) return; const pop=$('modePop'); const dev=!!(window.VEYL_CONFIG&&window.VEYL_CONFIG.programs);
  pop.innerHTML='<button class="opt" type="button" role="menuitemradio" aria-checked="'+SBX+'" data-mode="sandbox"><span class="rd"></span><b>Demo</b><small>Runs in this browser with demo funds. Real proofs, nothing sent anywhere.</small></button><button class="opt" type="button" role="menuitemradio" aria-checked="'+(!SBX)+'" data-mode="devnet"><span class="rd"></span><b>On-chain</b><small>'+(dev?'Solana with your wallet.':'Not connected from this host yet.')+'</small></button>'+(SBX?'<hr><div class="mini"><button class="btn ghost" type="button" data-faucet>Top up</button><button class="btn ghost" type="button" data-sbxreset>Start over</button></div>':'');
  pop.hidden=!pop.hidden; $('modeBtn').setAttribute('aria-expanded',String(!pop.hidden)); };
$('modePop').addEventListener('click',e=>{ const o=e.target.closest('[data-mode]'); if(!o) return; if((o.dataset.mode==='sandbox')===SBX){ $('modePop').hidden=true; return; } setMode(o.dataset.mode); });
document.addEventListener('click',e=>{ if(!SBX) return;
  if(e.target.closest('[data-faucet]')){ $('acctPop').hidden=true; $('modePop').hidden=true; runAct('Topping up','wallet',()=>E.faucet(),r=>{ const sb=E.store.data.sandbox||{}; sb.seen=sb.seen||Date.now(); E.store.data.sandbox=sb; E.store.save(); const F=E.chain.constructor.FAUCET||{}, FS=E.chain.constructor.FAUCET_SHIELDED||[]; const list=a=>a.length>1?a.slice(0,-1).join(', ')+' and '+a[a.length-1]:a.join(''); const pub=Object.entries(F).filter(([k])=>E.tokens[k]).map(([k,v])=>v.toLocaleString('en-US')+' '+k), sh=FS.filter(([k])=>E.tokens[k]).map(([k,v])=>v.toLocaleString('en-US')+' '+k); logAct({t:'Top up',s:'Demo funds',amt:pub.join(', ')}); refreshAll(); doneBlock('Topped up','Your wallet and private balance have been topped up.',null); }); }
  if(e.target.closest('[data-sbxreset]')){ $('acctPop').hidden=true; $('modePop').hidden=true; openModal('<h3 id="dlgTitle">Start over?</h3><p>Pools, prices, your wallet, your shielded account and its history go back to the start. Only this browser is affected.</p><button class="btn" type="button" id="rsYes">Reset</button>'); $('rsYes').onclick=()=>{ E.reset(); location.href=location.pathname; }; } });
const hb=$('hideBtn'); const setHide=v=>{ S.hide=v; document.body.classList.toggle('hide',v); hb.setAttribute('aria-pressed',v); hb.setAttribute('aria-label',v?'Show balances':'Hide balances'); hb.innerHTML=ic(v?'eyeoff':'eye'); };
hb.onclick=()=>{ setHide(!S.hide); LS.set('veyl:hide',S.hide); if(S.page==='privacy') renderPrivacy(); renderPvChip(); }; setHide(!!LS.get('veyl:hide',false));
window.addEventListener('resize',()=>{ if(S.page==='pool'){ drawBins(); drawMini(); } });

/// The top strip: your positions, fees earned, total liquidity, SOL price. Sandbox figures from its state; Devnet: a dash.
function renderKpis(){ const k=(l,v,sub,id)=>'<div class="kpi"'+(id?' id="'+id+'"':'')+'><span>'+l+'</span><b>'+v+(sub||'')+'</b></div>';
  const sol=mktUsd('SOL'), mk=MKT&&sol?'<em class="dim" title="Live market price">'+esc(MKT.label('SOL'))+'</em>':MKT&&MKT.error?'<em class="dim" title="'+esc(MKT.why?MKT.why():'')+'">market price unavailable</em>':'';
  const solK=sol?k('SOL','$'+tiny(sol),mk,'kpiSol'):'';
  if(SBX||!LIVE){ $('kpis').innerHTML=solK; return; }
  const mine=E.myPositions().filter(q=>!PI[q.id]||PI[q.id].err||PI[q.id].open); let fees=0, feesOk=true; for(const q of E.myPositions()){ const i=PI[q.id]; if(i&&!i.err&&i.fees){ const ux=usdOf(q.x), uy=usdOf(q.y); if(ux==null||uy==null){ feesOk=false; continue; } fees+=E.fmt(q.x,i.fees.x)*ux+E.fmt(q.y,i.fees.y)*uy; } }
  let tvl=0, any=false; for(const p of POOLS){ const ps=pstat(p); if(ps&&ps.tvlUsd!=null){ tvl+=ps.tvlUsd; any=true; } }
  $('kpis').innerHTML=k('Your positions',String(mine.length))+k('Fees earned',feesOk?usd$(fees):DASH)+k('TVL'+(SBX?'':' · on-chain'),any?usd$(tvl):DASH)+solK; }
if(MKT){ MKT.on(()=>renderKpis()); if(!E||!SBX){ const tick=()=>MKT.refresh().then(()=>{ if(LIVE&&!SBX) loadChainStats().then(()=>{ if(S.page==='pools') renderPools(); }); },()=>{}).finally(renderKpis); tick(); setInterval(tick,30000); } setInterval(()=>{ const el=$('kpiSol'); if(el&&MKT.at) renderKpis(); },5000); }
/* sidebar: collapse (persisted) on desktop, a drawer on phones */
const setSide=c=>{ document.body.classList.toggle('side-c',c); $('sideCol').setAttribute('aria-expanded',String(!c)); $('sideCol').setAttribute('aria-label',c?'Expand the sidebar':'Collapse the sidebar'); };
setSide(LS.get('veyl:side',matchMedia('(max-width:1199px)').matches)===true);
$('sideCol').onclick=()=>{ const c=!document.body.classList.contains('side-c'); setSide(c); LS.set('veyl:side',c); setTimeout(()=>{ if(S.page==='pool'){ drawBins(); drawPx(pstat(cur())); } },220); };
const drawer=o=>{ $('side').classList.toggle('open',o); $('sideBg').classList.toggle('open',o); $('menuBtn').setAttribute('aria-expanded',String(o)); };
$('menuBtn').onclick=()=>drawer(true); $('sideClose').onclick=()=>drawer(false); $('sideBg').onclick=()=>drawer(false);
$('side').addEventListener('click',e=>{ const a=e.target.closest('[data-go],a'); if(!a) return; drawer(false); const an=a.dataset.anchor; if(an) setTimeout(()=>{ const el=$(an); if(el) el.scrollIntoView({behavior:'smooth',block:'start'}); },60); });
/// Sealed swaps page: each sealed pool's current batch, and this account's sealed swaps in every pool.
let SP={};
async function loadSealedAll(){ if(!LIVE) return; for(const p of POOLS){ if(!p.address) continue; try{ const st=await E.sealedState(p); if(st&&st.enabled) SP[p.id]={st,at:Date.now()}; }catch(e){} } try{ SEAL.mine=await E.mySealedSwaps(); }catch(e){} }
function renderSealedPage(){ if(!LIVE){ $('sealPools').innerHTML='<div class="card empty">No sealed batches right now.</div>'; $('sealMine').innerHTML=''; return; }
  const ids=Object.keys(SP); $('sealPools').innerHTML=ids.length?ids.map(id=>{ const p=byId(id), x=SP[id], b=x.st.batch, left=b?Math.max(0,(Number(b.endSlot)-Number(x.st.slot))*(x.st.slotMs||400)-(Date.now()-x.at)):0;
    return '<div class="card sealcard"><div class="top"><span class="pp">'+pairImg(p)+'<b style="font-weight:500">'+p.x+'–'+p.y+'</b></span><span class="pill '+(b&&b.state==='open'?'priv':'flat')+'">'+ic('lock')+'Batch '+(b?esc(b.seq)+' · '+esc(b.state):'—')+'</span></div><dl class="det"><div><dt>Closes in</dt><dd>'+(b&&b.state==='open'?mmss(left):'sealing')+'</dd></div><div><dt>Sellers, '+p.x+' / '+p.y+'</dt><dd>'+(b?b.count[0]+' / '+b.count[1]:DASH)+'</dd></div><div><dt>Last batch</dt><dd>'+(x.st.last?esc(x.st.last.seq)+' · '+esc(x.st.last.state):'none yet')+'</dd></div></dl><button class="btn sm ghost" type="button" data-pool="'+p.id+'" data-sealtab>Seal a swap in '+p.x+'–'+p.y+'</button></div>'; }).join(''):'<div class="card empty">Reading batches…</div>';
  $('sealMine').innerHTML=SEAL.mine.length?SEAL.mine.map(sealRow).join(''):'<div class="card empty">No sealed swaps yet. Open a pool with batches, choose Swap, then Sealed.</div>'; }
document.addEventListener('click',e=>{ if(e.target.closest('[data-sealtab]')){ setTimeout(()=>{ S.tab='swap'; S.swMode='sealed'; S.src='priv'; renderPanel(); },50); } });
function render(){
  renderKpis();
  renderBanner();
  if(LIVE) $('bkBanner').className='banner'+(E.store.data.backedUpAt?'':' warn');
  if(S.page==='pools') renderPools();
  if(S.page==='swap') renderSwap();
  if(S.page==='pool'){ renderPoolHead(); renderPoolBody(); renderPanel(); }
  if(S.page==='home') renderHome();
  if(S.page==='activity') renderActivity();
  if(S.page==='sealed') renderSealedPage();
  if(S.page==='markets') renderMarkets();
  if(S.page==='privacy') renderPrivacy();
  renderPvChip();
}

/* ---------- Solana markets: external pools, live from keyless public APIs (never Veyl's own figures) ---------- */
const MK=window.Veyl&&window.Veyl.Markets?new Veyl.Markets({keys:(window.VEYL_KEYS||{})}):null;
const MS={rows:[],errors:{},at:0,loading:false,q:'',iv:'h24',sort:'vol',dex:'all',flt:{minLiq:'0',fee:'all',kind:'all'},open:null,timer:null,search:null};
const dexCls=d=>/meteora/i.test(d)?'meteora':/raydium/i.test(d)?'raydium':/orca/i.test(d)?'orca':/pump/i.test(d)?'pump':'';
const mkAge=(r)=>{ const s=Math.max(0,Math.round((Date.now()-(r.at||0))/1000)); return (r.sources||[r.source]).join(' + ')+' · '+(s<60?s+' s':Math.round(s/60)+' min'); };
const mkFmtAge=sec=>sec==null?DASH:ageS(sec);
async function loadMarkets(force){ if(!MK||MS.loading) return; if(!force&&MS.at&&Date.now()-MS.at<45000){ renderMarkets(); return; } MS.loading=true; renderMarkets();
  try{ const q=MS.q.trim(); const r=q.length>=2?await MK.search(q):await MK.list({limit:100}); MS.rows=r.rows; MS.errors=r.errors; MS.at=r.at; }catch(e){ MS.errors={all:{message:e.message}}; } finally{ MS.loading=false; renderMarkets(); } }
function mkSrcs(){ return Object.entries(Veyl.MARKET_SOURCES).map(([id,src])=>{ const st=MK.state[id]; const err=MS.errors[id]; const wait=err&&err.retryIn?Math.ceil(err.retryIn/1000):0; const cls=st.ok===null?'':wait?'wait':st.ok?'ok':'bad';
  return '<span class="'+cls+'" title="'+esc(src.base)+'"><i></i>'+src.name+(wait?' · retry in '+wait+' s':st.ok===false?' · '+esc(st.error||'down'):st.ok?'':' · …')+'</span>'; }).join(''); }
function mkRows(){ let l=MS.rows.slice(); const iv=MS.iv;
  if(MS.dex!=='all') l=l.filter(r=>dexCls(r.dex)===MS.dex||(MS.dex==='other'&&!dexCls(r.dex)));
  const minLiq=+MS.flt.minLiq||0; if(minLiq) l=l.filter(r=>(r.liquidityUsd||0)>=minLiq);
  if(MS.flt.kind==='dlmm') l=l.filter(r=>r.binStep!=null); if(MS.flt.kind==='clmm') l=l.filter(r=>r.tickSpacing!=null||/CLMM/.test(r.dex));
  if(MS.flt.fee!=='all'){ const [a,b]=MS.flt.fee.split('-').map(Number); l=l.filter(r=>r.feePct!=null&&r.feePct>=a&&r.feePct<b); }
  const q=MS.q.trim().toLowerCase(); if(q&&q.length<2) l=l.filter(r=>(r.pair+' '+r.dex).toLowerCase().includes(q));
  const k={vol:r=>r.volume[iv]??r.volume.h24??-1,liq:r=>r.liquidityUsd??-1,fees:r=>r.feesUsd24h??-1,apr:r=>r.aprPct??-1,chg:r=>r.change[iv]??r.change.h24??-999,age:r=>r.ageSec??-1}[MS.sort];
  if(MS.sort==='name') l.sort((a,b)=>a.pair.localeCompare(b.pair)); else l.sort((a,b)=>k(b)-k(a)); return l; }
function renderMarkets(){ if(!MK){ $('mkRows').innerHTML='<tr><td class="empty">Markets need the app bundle.</td></tr>'; return; }
  document.querySelectorAll('#mkIv [data-iv]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.iv===MS.iv))); $('mkSort').value=MS.sort; $('mkSrcs').innerHTML=mkSrcs();
  const dexes=[...new Set(MS.rows.map(r=>dexCls(r.dex)||'other'))]; $('mkDex').innerHTML=['all','meteora','raydium','orca','pump','other'].filter(d=>d==='all'||dexes.includes(d)).map(d=>'<button class="chip" type="button" data-dex="'+d+'" aria-pressed="'+(MS.dex===d)+'">'+({all:'All DEXes',meteora:'Meteora DLMM',raydium:'Raydium',orca:'Orca',pump:'Pump',other:'Other'})[d]+'</button>').join('');
  const nf=(+MS.flt.minLiq>0)+(MS.flt.fee!=='all')+(MS.flt.kind!=='all'); $('mkFltN').textContent=nf?String(nf):'';
  const ivn={m5:'5m',h1:'1h',h6:'6h',h24:'24h'}[MS.iv]; const l=mkRows();
  $('mkHead').innerHTML='<tr><th>Pool</th><th>Price</th><th>'+ivn+' %</th><th>Liquidity</th><th>Volume '+ivn+'</th><th>Fees 24h</th><th>APR</th><th>Fee / step</th><th>Age</th><th>Source</th></tr>';
  const chgIv=r=>r.change[MS.iv]!=null?chg(r.change[MS.iv]):(MS.iv==='h24'?DASH:'<span class="dim" title="This source gives 24h only">—</span>');
  const volIv=r=>r.volume[MS.iv]!=null?usd$(r.volume[MS.iv]):(MS.iv!=='h24'&&r.volume.h24!=null?'<span class="dim" title="This source gives 24h only">—</span>':usd$(r.volume.h24));
  const stale=r=>Date.now()-(r.at||0)>5*60000;
  const tier=r=>r.binStep!=null?(r.feePct!=null?r.feePct.toFixed(2)+'% · ':'')+'bin '+(r.binStep/100).toFixed(2)+'%':r.feePct!=null?r.feePct.toFixed(2)+'%'+(r.tickSpacing!=null?' · tick '+r.tickSpacing:''):DASH;
  if(MS.loading&&!MS.rows.length){ $('mkRows').innerHTML='<tr><td colspan="10" class="empty" style="text-align:center">Reading Solana markets…</td></tr>'; $('mkCards').innerHTML='<div class="empty">Reading Solana markets…</div>'; }
  else { $('mkRows').innerHTML=l.map(r=>'<tr data-mk="'+esc(r.address)+'" tabindex="0"><td><span class="pp"><span style="display:grid;gap:3px"><b>'+esc(r.pair)+' <span class="dexb '+dexCls(r.dex)+'">'+esc(r.dex)+'</span></b><small class="dim" style="font-size:11.5px">'+short(r.address)+(stale(r)?' · <span class="warn">stale</span>':'')+'</small></span></span></td><td>'+(r.priceUsd!=null?'$'+tiny(r.priceUsd):r.priceNative!=null?tiny(r.priceNative)+' <span class="dim">'+esc(r.quote.symbol||'')+'</span>':DASH)+'</td><td>'+chgIv(r)+'</td><td>'+usd$(r.liquidityUsd)+'</td><td>'+volIv(r)+(r.txns24h?'<span class="sub">'+r.txns24h.toLocaleString('en-US')+' txns 24h</span>':'')+'</td><td>'+usd$(r.feesUsd24h)+'</td><td>'+(r.aprPct!=null?pctS(r.aprPct):DASH)+'</td><td>'+tier(r)+'</td><td>'+mkFmtAge(r.ageSec)+'</td><td><span class="src-age">'+esc(mkAge(r))+'</span></td></tr>').join('')
      ||'<tr><td colspan="10" class="empty" style="text-align:center">'+(Object.keys(MS.errors).length&&!MS.rows.length?'Live market data can\'t load on this page right now. Try again in a minute, or open Veyl on its own site.':'No pools match.')+'</td></tr>';
    $('mkCards').innerHTML=l.slice(0,60).map(r=>'<button class="pcard" type="button" data-mk="'+esc(r.address)+'"><span class="t"><span class="mid"><b style="font-weight:500">'+esc(r.pair)+'</b><br><small class="dim" style="font-size:12px">'+chgIv(r)+' · '+esc(mkAge(r))+'</small></span><span class="dexb '+dexCls(r.dex)+'">'+esc(r.dex)+'</span></span><dl><div><dt>Liquidity</dt><dd>'+usd$(r.liquidityUsd)+'</dd></div><div><dt>Volume '+ivn+'</dt><dd>'+volIv(r)+'</dd></div><div><dt>APR</dt><dd>'+(r.aprPct!=null?pctS(r.aprPct):DASH)+'</dd></div></dl></button>').join('')||'<div class="empty">'+(MS.rows.length?'No pools match.':'No market data right now.')+'</div>'; }
  const none=!MS.rows.length&&Object.keys(MS.errors).length; $('mkCount').innerHTML=none?'':'<i></i>'+l.length+' pools · external DEXes, read live in your browser'+(MS.at?' · refreshed '+age(Date.now()-MS.at)+' ago':''); $('mkSrcs').hidden=!!none;
  renderMirrors(); }
function mkFltPop(){ const g=(k,vals,fmt)=>'<div class="chips">'+vals.map(v=>'<button class="chip" type="button" data-mf="'+k+'" data-v="'+v+'" aria-pressed="'+(String(MS.flt[k])===String(v))+'">'+fmt(v)+'</button>').join('')+'</div>';
  $('mkFltPop').innerHTML='<span class="h">Minimum liquidity</span>'+g('minLiq',['0','10000','100000','1000000'],v=>v==='0'?'Any':'$'+tiny(+v))+'<span class="h">Fee tier</span>'+g('fee',['all','0-0.05','0.05-0.3','0.3-1','1-100'],v=>v==='all'?'Any':v.replace('-',' – ').replace('100','∞')+'%')+'<span class="h">Pool kind</span>'+g('kind',['all','dlmm','clmm'],v=>({all:'Any',dlmm:'Bin (DLMM)',clmm:'Concentrated'})[v])+'<div class="foot"><button type="button" data-mfreset>Clear</button></div>'; }
$('mkFltBtn').onclick=e=>{ e.stopPropagation(); popToggle($('mkFltBtn'),$('mkFltPop'),mkFltPop); }; $('mkFltPop').addEventListener('click',e=>e.stopPropagation());
$('mkFltPop').addEventListener('click',e=>{ const b=e.target.closest('[data-mf]'); if(b){ MS.flt[b.dataset.mf]=b.dataset.v; mkFltPop(); renderMarkets(); } if(e.target.closest('[data-mfreset]')){ MS.flt={minLiq:'0',fee:'all',kind:'all'}; mkFltPop(); renderMarkets(); } });
$('mkIv').onclick=e=>{ const b=e.target.closest('[data-iv]'); if(b){ MS.iv=b.dataset.iv; renderMarkets(); } };
$('mkSort').onchange=e=>{ MS.sort=e.target.value; renderMarkets(); };
$('mkDex').onclick=e=>{ const b=e.target.closest('[data-dex]'); if(b){ MS.dex=b.dataset.dex; renderMarkets(); } };
$('mkRefresh').onclick=()=>loadMarkets(true);
$('mkQ').addEventListener('input',()=>{ MS.q=$('mkQ').value; clearTimeout(MS.search); if(MS.q.trim().length>=2) MS.search=setTimeout(()=>loadMarkets(true),500); else { MS.search=setTimeout(()=>loadMarkets(MS.rows.length===0),300); renderMarkets(); } });
setInterval(()=>{ if(S.page==='markets'&&!document.hidden){ if(MS.at&&Date.now()-MS.at>60000) loadMarkets(true); else renderMarkets(); } },15000);
/* pool detail drawer: DexScreener pair + GeckoTerminal candles; copyable addresses; links; mirror on Veyl */
document.addEventListener('click',e=>{ const t=e.target.closest('[data-mk]'); if(t&&S.page==='markets'){ openMk(t.dataset.mk); } });
$('mkRows').addEventListener('keydown',e=>{ const r=e.target.closest('[data-mk]'); if(r&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); openMk(r.dataset.mk); } });
$('mkBg').onclick=()=>closeMk(); function closeMk(){ MS.open=null; $('mkDrawer').classList.remove('open'); $('mkBg').classList.remove('open'); setTimeout(()=>{ if(!MS.open) $('mkDrawer').hidden=true; },260); }
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&MS.open) closeMk(); });
async function openMk(addr){ const r=MS.rows.find(x=>x.address===addr); if(!r) return; MS.open=addr; const D=$('mkDrawer'); D.hidden=false; requestAnimationFrame(()=>{ D.classList.add('open'); $('mkBg').classList.add('open'); });
  const row=(k,v)=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>'; const addrRow=(l,a)=>a?'<div class="addr"><span><span class="dim" style="font-size:12px">'+l+'</span><br><code>'+esc(a)+'</code></span><button type="button" data-copy="'+esc(a)+'">Copy</button></div>':'';
  D.innerHTML='<div class="top"><div><h2>'+esc(r.pair)+' <span class="dexb '+dexCls(r.dex)+'">'+esc(r.dex)+'</span></h2><p class="dim" style="margin:4px 0 0;font-size:13px">External pool · '+esc(mkAge(r))+' · not a Veyl pool</p></div><button class="ib" type="button" id="mkX" aria-label="Close"><svg class="ic sm"><use href="#i-x"/></svg></button></div>'+
    '<div class="card chartcard" id="mkChartCard"><div class="h"><b>Price</b><span class="dim" id="mkChartNote" style="font-size:12.5px">Loading candles (GeckoTerminal)…</span></div><svg id="mkChart" role="img" aria-label="Price candles"></svg></div>'+
    '<dl class="det">'+row('Price',r.priceUsd!=null?'$'+tiny(r.priceUsd):r.priceNative!=null?tiny(r.priceNative)+' '+esc(r.quote.symbol||''):DASH)+row('24h change',r.change.h24!=null?chg(r.change.h24):DASH)+row('Liquidity',usd$(r.liquidityUsd))+row('Volume 24h',usd$(r.volume.h24))+row('Fees 24h',usd$(r.feesUsd24h))+row('APR',r.aprPct!=null?pctS(r.aprPct):DASH)+(r.binStep!=null?row('Bin step',(r.binStep/100).toFixed(2)+'%'):'')+(r.feePct!=null?row('Fee',r.feePct.toFixed(3)+'%'):'')+(r.tickSpacing!=null?row('Tick spacing',String(r.tickSpacing)):'')+row('Age',mkFmtAge(r.ageSec))+(r.txns24h?row('Transactions 24h',r.txns24h.toLocaleString('en-US')):'')+'</dl>'+
    addrRow('Pool',r.address)+addrRow((r.base.symbol||'Base')+' mint',r.base.address)+addrRow((r.quote.symbol||'Quote')+' mint',r.quote.address)+
    '<div class="links"><a href="'+esc(r.url)+'" target="_blank" rel="noopener">Open on '+esc(r.dex.split(' ')[0])+'</a><a href="'+esc(r.explorer)+'" target="_blank" rel="noopener">Solscan</a><a href="https://dexscreener.com/solana/'+esc(r.address)+'" target="_blank" rel="noopener">DexScreener</a><a href="https://www.geckoterminal.com/solana/pools/'+esc(r.address)+'" target="_blank" rel="noopener">GeckoTerminal</a></div>'+
    '<div class="mirror"><b>Mirror on Veyl</b><span>Queue a request for a Veyl pool of '+esc(r.pair)+(r.binStep!=null?' with bin step '+(r.binStep/100).toFixed(2)+'%':'')+'. Pool creation is gated to the factory authority; this only records the request for the owner, nothing is created.</span><button class="btn" type="button" id="mkMirror">Request a mirror pool</button></div>';
  $('mkX').onclick=closeMk; $('mkMirror').onclick=()=>{ const m=LS.get('veyl:mirrors',[]); if(m.some(x=>x.address===r.address)){ toast('Already requested.','clock'); return; } m.unshift({address:r.address,pair:r.pair,dex:r.dex,base:r.base,quote:r.quote,binStep:r.binStep??(r.tickSpacing!=null?Math.max(1,r.tickSpacing)*1:10),feePct:r.feePct,at:Date.now(),liquidityUsd:r.liquidityUsd,volume24h:r.volume.h24}); LS.set('veyl:mirrors',m); toast('Mirror request queued for the owner.'); $('mkMirror').disabled=true; $('mkMirror').textContent='Requested'; renderMirrors(); };
  try{ const d=await MK.detail(addr,'hour',1); if(MS.open!==addr) return; drawMk(d.candles||[],d.candlesError); }catch(e){ if($('mkChartNote')) $('mkChartNote').textContent='Candles unavailable: '+e.message; } }
function drawMk(c,err){ const svg=$('mkChart'), note=$('mkChartNote'); if(!svg) return; if(!c.length){ svg.innerHTML=''; note.textContent=err?'Candles unavailable ('+esc(err)+')':'No candles for this pool.'; return; }
  const W=svg.clientWidth||480,H=svg.clientHeight||160; svg.setAttribute('viewBox','0 0 '+W+' '+H); const lo=Math.min(...c.map(x=>x.l??x.c)), hi=Math.max(...c.map(x=>x.h??x.c)), r=(hi-lo)||hi*1e-4||1; const n=c.length, bw=Math.max(1.5,(W-70)/n*0.7), X=i=>4+i/(n-1)*(W-80), Y=v=>6+(1-(v-lo)/r)*(H-26);
  svg.innerHTML=c.map((x,i)=>{ const up=x.c>=(x.o??x.c), col=up?'var(--good)':'var(--bad)'; return '<line x1="'+X(i).toFixed(1)+'" x2="'+X(i).toFixed(1)+'" y1="'+Y(x.h??x.c).toFixed(1)+'" y2="'+Y(x.l??x.c).toFixed(1)+'" stroke="'+col+'" stroke-width="1"/><rect x="'+(X(i)-bw/2).toFixed(1)+'" y="'+Math.min(Y(x.o??x.c),Y(x.c)).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(1,Math.abs(Y(x.o??x.c)-Y(x.c))).toFixed(1)+'" fill="'+col+'"/>'; }).join('')+[hi,(hi+lo)/2,lo].map(v=>'<text x="'+(W-70)+'" y="'+(Y(v)+4).toFixed(1)+'" fill="var(--muted)" font-size="11" font-family="var(--mono)">'+tiny(v)+'</text>').join('')+'<text x="4" y="'+(H-4)+'" fill="var(--muted)" font-size="11" font-family="var(--mono)">'+new Date(c[0].t*1000).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</text><text x="'+(W-72)+'" y="'+(H-4)+'" text-anchor="end" fill="var(--muted)" font-size="11" font-family="var(--mono)">'+new Date(c[n-1].t*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</text>';
  note.textContent=n+' hourly candles · GeckoTerminal'; }
function renderMirrors(){ const m=LS.get('veyl:mirrors',[]); $('mirrorH').hidden=!m.length; $('mirrorList').innerHTML=m.map(x=>'<div class="row"><div class="mid"><b>'+esc(x.pair)+' <span class="pill flat">bin step '+(x.binStep/100).toFixed(2)+'%</span></b><small>Mirrors '+esc(x.dex)+' '+short(x.address)+' · requested '+age(Date.now()-x.at)+' ago · waiting for the factory authority (nothing is created from here)</small></div><div class="rt"><button class="btn sm ghost" type="button" data-unmirror="'+esc(x.address)+'">Remove</button></div></div>').join(''); }
document.addEventListener('click',e=>{ const b=e.target.closest('[data-unmirror]'); if(b){ LS.set('veyl:mirrors',LS.get('veyl:mirrors',[]).filter(x=>x.address!==b.dataset.unmirror)); renderMirrors(); } });

/* ---------- privacy: checks and the crowd you blend into ---------- */
const PV={relayer:null,at:0};
async function loadPrivacy(){ if(!LIVE||SBX) { renderPrivacy(); return; } if(Date.now()-PV.at<30000){ renderPrivacy(); return; } PV.at=Date.now();
  try{ const i=await E.relayerInfo(); PV.relayer=!!(i&&i.address); }catch(e){ PV.relayer=false; } try{ await E.refreshNotes(); }catch(e){} if(S.page==='privacy') renderPrivacy(); }
function renderPrivacy(){ const ok=(t,s,good,act)=>'<div class="row"><span class="ck '+(good===true?'g':good===false?'b':'n')+'">'+ic(good===true?'check':good===false?'alert':'clock','sm')+'</span><div class="mid"><b>'+t+'</b><small>'+s+'</small></div>'+(act?'<div class="rt">'+act+'</div>':'')+'</div>';
  if(!LIVE){ $('pvScore').innerHTML='<span class="k">Your privacy</span><b class="big">Not checked</b><p class="dim">Connect a wallet to run the checks.</p>'; $('pvChecks').innerHTML=ok('Private balance','Deposit once to start using Veyl privately.',null)+ok('Backup','Back up after your first deposit.',null)+ok('Balances on screen',S.hide?'Hidden on this screen.':'Visible on this screen.',S.hide?true:null,'<button class="btn sm ghost" type="button" id="pvHide">'+(S.hide?'Show':'Hide')+'</button>')+ok('Relayer','Sends your private actions so your wallet never signs them.',null); if($('pvHide')) $('pvHide').onclick=()=>hb.click(); return; }
  let notes=0; try{ notes=(E.shieldNotes&&E.shieldNotes().length)||0; }catch(e){}
  let crowd=null; try{ const st=E.shieldState; crowd=st&&st.leaves?st.leaves.length:null; }catch(e){}
  const bk=!!E.store.data.backedUpAt, rel=SBX?true:PV.relayer;
  const c=[notes>0, bk, S.hide, rel===true, crowd!=null&&crowd>=50]; const n=c.filter(Boolean).length;
  const word=n>=5?'Strong':n>=3?'Good':'Getting started';
  $('pvScore').innerHTML='<span class="k">Your privacy</span><b class="big">'+word+'</b><div class="pvbar"><i style="width:'+(n/5*100)+'%"></i></div><p class="dim">'+n+' of 5 checks pass.'+(crowd!=null?' You blend in with <b>'+crowd.toLocaleString('en-US')+'</b> private deposits.':'')+'</p>';
  $('pvChecks').innerHTML=
    ok('Private balance',notes>0?notes+' private note'+(notes===1?'':'s')+' ready to use.':'Deposit once to start using Veyl privately.',notes>0,notes>0?'':'<button class="btn sm" type="button" data-go="home">Deposit</button>')+
    ok('Backup',bk?'Backed up '+age(Date.now()-E.store.data.backedUpAt)+' ago.':'Not backed up. Clear this browser and the balance is gone.',bk,bk?'':'<button class="btn sm" type="button" data-backup="export">Back up</button>')+
    ok('Balances on screen',S.hide?'Hidden on this screen.':'Visible to anyone looking at your screen.',S.hide,'<button class="btn sm ghost" type="button" id="pvHide">'+(S.hide?'Show':'Hide')+'</button>')+
    ok('Relayer',rel===true?'Online. Your wallet never signs private actions.':rel===false?'Not answering. Private actions wait until it is back.':'Checking…',rel)+
    ok('Crowd size',crowd==null?'Reading the private pool…':crowd>=50?crowd.toLocaleString('en-US')+' private deposits to blend in with.':'Only '+crowd+' private deposits so far. Privacy gets stronger as more people join.',crowd==null?null:crowd>=50);
  if($('pvHide')) $('pvHide').onclick=()=>hb.click(); }
function pvCount(){ if(!LIVE) return null; let notes=0, crowd=null; try{ notes=(E.shieldNotes&&E.shieldNotes().length)||0; }catch(e){} try{ const st=E.shieldState; crowd=st&&st.leaves?st.leaves.length:null; }catch(e){}
  const rel=SBX?true:PV.relayer; return [notes>0, !!E.store.data.backedUpAt, S.hide, rel===true, crowd!=null&&crowd>=50].filter(Boolean).length; }
function renderPvChip(){ const el=$('pvChipN'); if(!el) return; const n=pvCount(); el.textContent=n==null?'':n+'/5'; $('pvChip').classList.toggle('ok',n!=null&&n>=4); $('pvChip').setAttribute('aria-label','Privacy'+(n==null?'':': '+n+' of 5 checks pass')); }
/* ---------- getting in: no wallet needed (a deposit address in this browser), or connect one ---------- */
const NC='This page isn\'t connected to Solana, so connecting is turned off here.';
function afterConnect(local){ $('acctBtn').textContent=local?'Deposit address':short(ME); $('acctBtn').classList.remove('conn'); $('acctBtn').title=ME; renderBanner(); refreshAll(); }
function openStart(){ const ws=(window.Veyl&&Veyl.Engine&&Veyl.Engine.wallets)?Veyl.Engine.wallets():[];
  openModal('<h3 id="dlgTitle">Get started</h3><p>No account, no sign-up. Choose how to put money in.</p>'+
    '<button class="opt2 rec" type="button" id="stLocal"><span class="oi">'+ic('key')+'</span><span class="ot"><b>No wallet needed</b><small>Veyl makes a deposit address in this browser. Send SOL, USDC or USDT to it from any wallet or exchange.</small></span><span class="pill priv">Recommended</span></button>'+
    '<div class="orsep"><span>or connect a wallet</span></div>'+
    (ws.length?ws.map((w,i)=>'<button class="opt2" type="button" data-wal="'+i+'"><span class="oi">'+ic('wallet')+'</span><span class="ot"><b>'+esc(w[0])+'</b><small>Your wallet signs deposits. Everything after that is private.</small></span></button>').join(''):'<p class="dim" style="font-size:13.5px;margin:0">No wallet extension in this browser. Phantom, Solflare and Backpack work, or use the option above.</p>')+
    (!LIVE?'<p class="hint">'+ic('alert')+'<span>'+NC+'</span></p>':''));
  $('stLocal').onclick=async()=>{ if(!LIVE){ toast(NC,'wallet',5000); return; } closeModal(); try{ ME=await E.connectLocal(); afterConnect(true); openFund(); }catch(err){ toast(esc((err&&err.message)||'Could not set up the deposit address.'),'alert',6000); } };
  document.querySelectorAll('#dlgBody [data-wal]').forEach(b=>b.onclick=async()=>{ if(!LIVE){ toast(NC,'wallet',5000); return; } closeModal(); try{ ME=await E.connect(ws[+b.dataset.wal][1]); afterConnect(false); toast('Wallet connected'); }catch(err){ toast(esc((err&&err.message)||'Could not connect.'),'alert',6000); } }); }
function openFund(){ openModal('<h3 id="dlgTitle">Fund your deposit address</h3><p>Send tokens here from any wallet or exchange, on Solana. Keep about <b>0.01 SOL</b> in it for network fees. Then move it into your private balance.</p>'+
    '<div class="faddr"><code>'+esc(ME)+'</code><button class="btn ghost" type="button" data-copy="'+esc(ME)+'">Copy</button></div><div class="list" id="fBal"></div>'+
    (S.faucet?'<button class="btn ghost" type="button" data-drip style="margin-bottom:10px">Get test tokens</button>':'')+'<p class="hint">'+ic('alert')+'<span>This address is public, and its key lives only in this browser. Back up from the account menu so you never lose it.</span></p><button class="btn" type="button" id="fGo">Move into private balance</button>');
  const tick=async()=>{ if(!$('fBal')) return; try{ await loadBalances(); }catch(e){} if(!$('fBal')) return; $('fBal').innerHTML=Object.keys(E.tokens).map(k=>'<div class="row"><span class="mid"><b>'+esc(k)+'</b></span><span class="rt"><b class="sens">'+tiny(bal('pub',k))+'</b></span></div>').join(''); setTimeout(tick,5000); };
  tick(); $('fGo').onclick=()=>{ closeModal(); openDeposit(); }; }
function openSweep(){ openModal('<h3 id="dlgTitle">Send what\'s left out</h3><p>Empties the deposit address to a Solana address: every token, then the SOL after fees. This is public, and links the deposit address to where it goes. For privacy, withdraw from your private balance instead.</p><div class="fld"><label for="swpTo">To</label><input id="swpTo" type="text" placeholder="Solana address" autocomplete="off"></div><p class="err" id="swpErr"></p><button class="btn" type="button" id="swpGo">Send out</button>');
  $('swpGo').onclick=()=>{ const to=($('swpTo').value||'').trim(); if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return $('swpErr').textContent='Enter a Solana address.';
    runAct('Sending out','wallet',()=>E.localSweep(to),r=>{ logAct({t:'Deposit address emptied',s:'To '+short(to),amt:(r.moved||[]).join(', ')}); refreshAll(); doneBlock('Sent',r.moved&&r.moved.length?'Moved '+r.moved.join(', ')+' to '+short(to)+'.':'There was nothing to move.',r.tx); }); }; }
document.addEventListener('click',e=>{ if(e.target.closest('[data-fund]')){ $('acctPop').hidden=true; openFund(); } if(e.target.closest('[data-sweep]')){ $('acctPop').hidden=true; openSweep(); } });
/* ---------- devnet / local: test tokens from the relayer's faucet (the mock mints), never on mainnet ---------- */
async function checkFaucet(){ if(!LIVE||SBX) return; try{ const i=await E.relayerInfo(); S.faucet=!!(i&&i.faucet); }catch(e){ S.faucet=false; } }
async function getTestTokens(btn,syms){ if(!E.account){ openStart(); return; } const label=btn&&btn.textContent; if(btn){ btn.disabled=true; btn.textContent='Sending…'; }
  try{ const r=await fetch(CFG.relayer+'/drip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(syms?{to:E.account,tokens:syms}:{to:E.account})}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'The faucet did not answer.');
    toast('Sent: '+esc((j.sent||[]).join(', ')),'check',7000); logAct({t:'Test tokens received',s:'Devnet faucet',amt:''}); await loadBalances(); render(); }
  catch(err){ toast(esc((err&&err.message)||'The faucet did not answer.'),'alert',6000); } finally{ if(btn){ btn.disabled=false; btn.textContent=label; } } }
document.addEventListener('click',e=>{ const b=e.target.closest('[data-drip]'); if(b){ $('acctPop').hidden=true; getTestTokens(b.closest('#dlgBody')||b.classList.contains('drip')?b:null,b.dataset.drip?b.dataset.drip.split(','):null); } });
/* ---------- pro LP tools: volatility from the pool's own swaps, ranges sized from it, a position simulator, P&L ---------- */
const usd2=v=>v==null||!isFinite(v)?DASH:'$'+(Math.abs(v)>=1000?Math.round(v).toLocaleString('en-US'):Math.abs(v)>=1?v.toFixed(2):tiny(v));
/// Daily volatility (a fraction): realized from the pool's recent swaps when there are enough, else a typical figure for its bin step.
function volOf(p){ const ps=pstat(p);
  if(ps&&ps.spark&&ps.sparkT&&ps.spark.length>=8){ let ss=0,n=0; for(let i=1;i<ps.spark.length;i++){ const a=ps.spark[i-1],b=ps.spark[i]; if(a>0&&b>0){ const r=Math.log(b/a); ss+=r*r; n++; } }
    const span=(ps.sparkT[ps.sparkT.length-1]-ps.sparkT[0])||0; if(n>=6&&span>=3600){ const d=Math.sqrt(ss*86400/span); if(isFinite(d)&&d>0) return {v:Math.min(d,1.5),real:true,n}; } }
  const bs=p.bs||10; return {v:bs<=1?0.002:bs<=10?0.035:bs<=20?0.06:bs<=50?0.1:0.15,real:false}; }
const sideBins=(p,pct)=>Math.max(1,Math.ceil(Math.log(1+pct)/Math.log(1+(p.bs||10)/1e4)));
const VOLPRE=[['Tight',1,1,'1σ, one day'],['Balanced',2,1,'2σ, one day'],['Wide',2,7,'2σ, one week']];
function renderVolPre(){ const p=cur(), el=$('volPre'); if(!el) return; if(S.tab!=='add'&&S.tab!=='zap'){ el.innerHTML=''; return; } const vo=volOf(p);
  el.innerHTML='<div class="vk"><span>Volatility ≈ <b>'+(vo.v*100).toFixed(vo.v<0.01?2:1)+'%</b> a day</span><small>'+(vo.real?'from '+vo.n+' recent swaps':'typical for this pool type')+'</small></div><div class="presets">'+
    VOLPRE.map(([n,k,d,t],i)=>{ const pct=k*vo.v*Math.sqrt(d); return '<button type="button" data-vp="'+i+'" title="'+t+'">'+n+' <small>±'+(pct*100).toFixed(pct<0.01?2:1)+'%</small></button>'; }).join('')+'</div>'; }
document.addEventListener('click',e=>{ const b=e.target.closest('[data-vp]'); if(!b) return; const p=cur(), [,k,d]=VOLPRE[+b.dataset.vp], vo=volOf(p); const cap=SRC()==='priv'?PMAX:69;
  let n=sideBins(p,k*vo.v*Math.sqrt(d)); const full=S.side==='both'?2*n+1:n+1; if(full>cap){ n=S.side==='both'?Math.floor((cap-1)/2):cap-1; toast('Capped at '+cap+' bins'+(cap===PMAX?' (the most a private position holds)':''),'alert',4000); }
  setRangeFromBins(S.side==='both'?2*n+1:n+1); syncRangeInputs(true); renderPanel(); if(S.tab==='zap') zapPreview(); });

/// The planned position, bin by bin: value at each bin's own price (in the pool's second token), from the shape and amounts.
function simPlan(){ const p=cur(); if(!p.st||!SDK) return null; const {lo,hi,a}=range(); const ids=[]; for(let i=lo;i<=hi;i++) ids.push(i);
  const w=SDK.shapeWeights(ids,a,shapeName()); const sx=w.weightsX.reduce((s,x)=>s+x,0), sy=w.weightsY.reduce((s,x)=>s+x,0); const pa=hp(p,a);
  let ax=S.side==='y'?0:parseFloat($('amtX').value)||0, ay=S.side==='x'?0:parseFloat($('amtY').value)||0, hypo=false;
  if(!(ax>0||ay>0)){ hypo=true; const uy=usdOf(p.y)||1, tot=1000/uy; const fx=sx>0&&S.side!=='y'?(sy>0&&S.side!=='x'?0.5:1):0; ax=fx*tot/pa; ay=(1-fx)*tot; }
  const bins=ids.map((id,i)=>{ const P=hp(p,id), X=sx>0?ax*w.weightsX[i]/sx:0, Y=sy>0?ay*w.weightsY[i]/sy:0; return {id,P,X,Y,V:X*P+Y}; });
  return {p,ids,bins,ax,ay,a,pa,lo,hi,hypo}; }
/// What the position is worth if the price moves to P1 (bins crossed on the way convert at their own price), next to simply holding.
function simAt(m,P1){ let v=0; for(const b of m.bins){ if(b.P<P1) v+=b.V; else if(b.P>P1) v+=b.V/b.P*P1; else v+=b.X*P1+b.Y; } return {pos:v,hold:m.ax*P1+m.ay}; }
function renderSim(){ const el=$('simBox'); if(!el) return; if(S.tab!=='add'){ el.innerHTML=''; return; } const m=simPlan(); if(!m){ el.innerHTML=''; return; }
  const p=m.p, uy=usdOf(p.y), fmtV=v=>uy!=null?usd2(v*uy):tiny(v)+' '+p.y, now=simAt(m,m.pa).pos, Plo=m.bins[0].P, Phi=m.bins[m.bins.length-1].P;
  const rows=[-30,-15,-5,5,15,30].map(d=>{ const P1=m.pa*(1+d/100), r=simAt(m,P1), il=(r.pos/r.hold-1)*100; const out=P1<Plo||P1>Phi;
    return '<tr><td>'+(d>0?'+':'')+d+'%</td><td>'+tiny(P1)+'</td><td>'+fmtV(r.pos)+(out?' <span class="dim">out</span>':'')+'</td><td class="'+(il<-0.05?'down':'dim')+'">'+(il>=0?'+':'')+il.toFixed(2)+'%</td></tr>'; }).join('');
  // fees: this pool's LP fees over the window, shared by the liquidity in the bins the price actually traded through
  const ps=pstat(p); let fee='<span class="dim">Needs trading history</span>', apr=null;
  if(ps&&ps.lpFeesUsd!=null&&ps.spark&&ps.spark.length>=2&&uy!=null&&p.st){ const ids=ps.spark.map(x=>E.binForPrice(p.st,x)); const t0=Math.min(...ids), t1=Math.max(...ids); let sh=0,n=0;
    for(let id=t0;id<=t1;id++){ const b=p.st.bins[id]; const pool=b?E.fmt(p.x,b.x+b.askX)*hp(p,id)+E.fmt(p.y,b.y+b.bidY):0; const me=(m.bins.find(x=>x.id===id)||{V:0}).V; sh+=me>0?me/(pool+me):0; n++; }
    const day=ps.lpFeesUsd*(86400/S.iv)*(n?sh/n:0); apr=now*uy>0?day*365/(now*uy)*100:null; fee=usd2(day)+' a day'+(apr!=null?' · <b>'+apr.toFixed(apr<10?1:0)+'% APR</b>':''); }
  const widthPct=(Phi/Plo-1)*100;
  el.innerHTML='<div class="sim-h"><b>Simulate</b><small>'+(m.hypo?'for a '+(uy!=null?'$1,000':'1,000 '+p.y)+' position':'for the amounts above')+'</small></div>'+
    '<div class="sim-k"><div><span>Range</span><b>'+tiny(Plo)+' – '+tiny(Phi)+'</b><small>'+widthPct.toFixed(widthPct<1?2:1)+'% wide · '+m.bins.length+' bins</small></div><div><span>Est. fees</span><b>'+fee+'</b><small>at this pool\'s recent volume, if the price stays in range</small></div></div>'+
    '<table class="sim-t"><thead><tr><th>Price move</th><th>Price</th><th>Position</th><th>vs holding</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<small class="dim">Fees not included in the moves. Past volume is no promise of future fees.</small>'; }

/// Portfolio: totals across positions in dollars, how many are in range, fees, and each position's fee APR since it opened.
function posUsd(q,i){ const ux=usdOf(q.x), uy=usdOf(q.y); if(ux==null||uy==null||!i||i.err) return null; return {v:E.fmt(q.x,i.value.x)*ux+E.fmt(q.y,i.value.y)*uy, f:E.fmt(q.x,i.fees.x)*ux+E.fmt(q.y,i.fees.y)*uy}; }
function renderPfSum(ps){ const el=$('pfSum'); if(!el) return; let v=0,f=0,inR=0,open=0,ok=true; for(const q of ps){ const i=PI[q.id]; if(!i||i.err) continue; if(i.open){ open++; if(i.inRange) inR++; } const u=posUsd(q,i); if(u){ v+=u.v; f+=u.f; } else ok=false; }
  el.hidden=!ps.length; if(!ps.length) return;
  el.innerHTML='<div><span>Liquidity</span><b class="sens">'+(ok||v>0?usd2(v):'—')+'</b></div><div><span>Unclaimed fees</span><b class="sens up">'+(ok||f>0?usd2(f):'—')+'</b></div><div><span>In range</span><b>'+inR+' / '+open+'</b></div>'; }
function posPro(q,i){ const u=posUsd(q,i); const p=byAddr(q.pool); let h=''; if(!u||!i||i.err) return '';
  const age=q.createdAt?Date.now()-q.createdAt:null; const apr=age&&age>3600e3&&u.v>0?u.f/u.v*(365*864e5/age)*100:null;
  if(p&&p.st&&i.open){ const P=hp(p,i.active), L=hp(p,q.lo), H=hp(p,q.hi); const dl=(P/L-1)*100, dh=(H/P-1)*100; h+='<div><span>To range edges</span><b>'+(i.inRange?'−'+Math.max(0,dl).toFixed(1)+'% · +'+Math.max(0,dh).toFixed(1)+'%':'out of range')+'</b></div>'; }
  h+='<div><span>Worth</span><b class="sens">'+usd2(u.v)+'</b></div><div><span>Fee APR since open</span><b class="sens">'+(apr!=null?apr.toFixed(apr<10?1:0)+'%':age?'after the first hour':'—')+'</b></div>';
  return '<div class="ppro">'+h+'</div>'; }
/* ---------- start ---------- */
renderMode();
if(SBX){ document.querySelector('.testnet-bar').hidden=true; $('netLbl').hidden=true; ME=E.account; $('acctBtn').textContent=short(ME); $('acctBtn').classList.remove('conn'); S.rpc='ok'; E.init().then(async()=>{ E.start(); renderMode(); renderKpis(); const sb=E.store.data.sandbox||(E.store.data.sandbox={}); if(!sb.funded){ try{ await E.faucet(); sb.funded=Date.now(); sb.seen=sb.seen||Date.now(); E.store.save(); logAct({t:'Wallet funded',s:'Demo funds',amt:''}); refreshAll(); }catch(e){} } }); E.on(ev=>{ if(ev.type==='market'){ renderMode(); renderKpis(); } });
  // live: bots trade, batches close and settle. Pool views follow the chain; the bins move.
  let pend=null; const follow=()=>{ pend=null; if(document.hidden) return; if(S.page==='pool'){ const p=cur(); loadPool(p,35).then(()=>{ if(S.page!=='pool'||cur()!==p) return; renderPoolHead(); drawBins(); if(S.tab==='swap'&&!S.busy){ pswQ=null; renderPanel(); } }); } else if(S.page==='pools') loadPools().then(()=>{ if(S.page==='pools') renderPools(); }); };
  E.on(ev=>{ if(ev.type==='swap'||ev.type==='tx'){ if(!pend) pend=setTimeout(follow,500); } if(ev.type==='sealed'&&S.page==='pool'&&!S.busy){ loadSealed(cur()).then(()=>{ if(S.page==='pool'&&!S.busy){ renderPoolBody(); if(S.tab==='swap') renderPanel(); } }); } });
  setInterval(()=>{ if(S.busy||document.hidden) return; if(S.page==='home'||S.page==='pool'){ loadPositions().then(()=>{ if(S.busy) return; if(S.page==='home') renderHome(); else renderPoolBody(); }); } if(S.page==='activity') renderActivity(); renderKpis(); if(S.page==='sealed') loadSealedAll().then(()=>{ if(S.page==='sealed'&&!S.busy) renderSealedPage(); }); },5000); }
else document.querySelector('.testnet-bar').hidden=true;
if(LIVE){ if(!SBX){ $('netLbl').lastChild.textContent=CHAIN; $('netLbl').hidden=true; } S.activity=(E.store.data.activity||[]).slice();
  (async()=>{ checkFaucet(); if(!SBX&&E.store.data.useLocal&&Array.isArray(E.store.data.depositKey)){ try{ ME=await E.connectLocal(); afterConnect(true); }catch(e){} } await checkRpc(false); render(); await loadPools(); S.loading=false; render(); if(!SBX){ await loadChainStats(); render(); } await refreshAll(); if(!E.store.ok) toast('This browser blocks local storage. Back up after every action.','alert',8000); })();
  setInterval(async()=>{ if(S.busy||document.hidden) return; if(S.page==='pool') await loadPool(cur(),35); else if(S.page==='pools') await loadPools(); if(!SBX&&(S.page==='pools'||S.page==='pool'||S.page==='activity')&&Date.now()-(loadChainStats.at||0)>60000) await loadChainStats(); await refreshAll(); },15000);
  // sealed batches: the batch state every 4 s on a pool page (counts, close, settlement), the countdown every second
  setInterval(async()=>{ if(S.busy||document.hidden||S.page!=='pool') return; const p=cur(); await loadSealed(p); if(S.page==='pool'&&cur()===p&&!S.busy){ renderPoolBody(); if(S.tab==='swap') renderPanel(); } },4000);
  setInterval(()=>{ const c=$('sealClock'); if(!c) return; const l=sealLeft(); c.textContent=mmss(l); const st=SEAL.st; if(st&&st.batch){ const ep=Number(st.epochSlots)*(st.slotMs||400); const b=$('sealBar'); if(b) b.style.width=Math.min(100,Math.max(0,100-l/ep*100)).toFixed(1)+'%'; } },1000); }
else { $('netLbl').hidden=true;
  // the demonstration's sample batch: its countdown runs and starts over
  setInterval(()=>{ const c=$('sealClock'); if(!c) return; let l=sealLeft(); if(l<=0){ SEAL.at=Date.now(); l=sealLeft(); } c.textContent=mmss(l); const st=SEAL.st; if(st&&st.batch){ const ep=Number(st.epochSlots)*(st.slotMs||400); const b=$('sealBar'); if(b) b.style.width=Math.min(100,Math.max(0,100-l/ep*100)).toFixed(1)+'%'; } },1000); }
function route(){ const h=(location.hash||'').replace('#','');
  if(h.startsWith('pay=')&&takePayLink(h)){ go('home'); return; }
  if(h.startsWith('pool-')&&byId(h.slice(5))){ S.cur=h.slice(5); go('pool'); }
  else go({portfolio:'home',home:'home',swap:'swap',pools:'pools',activity:'activity',sealed:'sealed',markets:'markets',privacy:'privacy'}[h]||'pools'); }
window.addEventListener('hashchange',route); route();
})();
