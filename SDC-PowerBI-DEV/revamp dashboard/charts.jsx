/* ============================================================
   SDC charts — REVAMP
   Flat SVG, no gradients/shadows. Improved grid, labels, tooltips.
   ============================================================ */
const { useState, useRef } = React;
const C = window.SDC.C;

const fmt  = (n) => n.toLocaleString('en-US');
const fmtK = (n) => Math.abs(n) >= 1000 ? (n < 0 ? '-' : '') + (Math.abs(n)/1000).toFixed(1)+'K' : ''+n;
const usd  = (n) => (n<0?'-':'')+'$'+Math.abs(n).toLocaleString('en-US');
const usdK = (n) => {
  const a=Math.abs(n), sign=n<0?'-':'';
  if(a>=1e6) return sign+'$'+(a/1e6).toFixed(2)+'M';
  if(a>=1e3) return sign+'$'+Math.round(a/1e3)+'K';
  return sign+'$'+a;
};

/* ---- Tooltip hook ---- */
function useTip(){
  const [tip,setTip] = useState(null);
  const node = tip ? <div className="tt show" style={{left:tip.x, top:tip.y}}
      dangerouslySetInnerHTML={{__html:tip.html}} /> : null;
  return [node, setTip];
}

/* ---- Horizontal Bar Chart -----------------------------------------
   Improvements: target line, better label truncation, hover state,
   value labels always outside bar, cleaner track bg               */
function HBar({ data, colorFor, valueFmt=fmt, onPick, max, showTarget }){
  const [tip,setTip] = useTip();
  const [hov,setHov] = useState(null);
  const W=640, rowH=Math.min(32, 270/data.length), gap=7;
  const labelW=192, valW=68, plotW=W-labelW-valW;
  const top=4;
  const mx = max || Math.max(...data.map(d=>Math.abs(d.value)));
  const H = top + data.length*(rowH+gap);
  const hasNeg = data.some(d=>d.value<0);
  const zero = hasNeg ? labelW + plotW*0.45 : labelW;
  const scale = hasNeg ? (plotW*0.45)/mx : plotW/mx;

  return (
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        {/* subtle grid lines */}
        {[0.25,0.5,0.75,1].map((f,i)=>{
          const gx = hasNeg ? zero + (plotW*0.45)*f : labelW + plotW*f;
          return <line key={i} className="grid-line" x1={gx} y1={0} x2={gx} y2={H} strokeDasharray="3 3"/>;
        })}
        {data.map((d,i)=>{
          const y=top+i*(rowH+gap);
          const w=Math.abs(d.value)*scale;
          const x=d.value<0 ? zero-w : zero;
          const col=colorFor(d);
          const isHov = hov===i;
          const label = d.label.length>28 ? d.label.slice(0,27)+'…' : d.label;
          return (
            <g key={i}
               style={{cursor:onPick?'pointer':'default'}}
               onClick={()=>onPick&&onPick(d.id)}
               onMouseEnter={()=>setHov(i)}
               onMouseLeave={()=>{ setHov(null); setTip(null); }}
               onMouseMove={(e)=>{
                 const r=e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
                 setTip({x:e.clientX-r.left, y:e.clientY-r.top,
                   html:`<b>${d.label}</b><br/>${valueFmt(d.value)}`});
               }}>
              {/* hover bg */}
              {isHov && <rect x={0} y={y-2} width={W} height={rowH+4} fill="rgba(21,116,196,.05)" rx="3"/>}
              {/* label */}
              <text className="bar-name" x={labelW-10} y={y+rowH/2+4} textAnchor="end"
                style={{fontSize:11, fontWeight: isHov?700:500}}>{label}</text>
              {/* track */}
              <rect x={labelW} y={y+2} width={plotW} height={rowH-4} fill="#EEF2F6" rx="3"/>
              {/* bar */}
              <rect x={x} y={y+2} width={Math.max(w,3)} height={rowH-4} fill={col} rx="3"
                opacity={isHov ? 1 : 0.9}/>
              {/* value label */}
              <text className="bar-val" x={d.value<0 ? x-5 : x+Math.max(w,3)+5}
                    y={y+rowH/2+4}
                    textAnchor={d.value<0?'end':'start'}
                    style={{fontSize:10.5}}>{valueFmt(d.value)}</text>
            </g>
          );
        })}
        {hasNeg && <line x1={zero} y1={0} x2={zero} y2={H} stroke="#B0BEC8" strokeWidth="1.5"/>}
      </svg>
      {tip}
    </div>
  );
}

/* ---- Line Trend Chart ---------------------------------------------
   Improvements: area fill under actual line, better axis labels,
   dot hover with larger hit area, cleaner grid               */
function LineTrend({ data, keys }){
  const [tip,setTip] = useTip();
  const W=880,H=290, padL=48,padR=18,padT=16,padB=28;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  const all=data.flatMap(d=>keys.map(k=>d[k.k]));
  const rawMax=Math.max(...all);
  const max=Math.ceil(rawMax/5000)*5000; const min=0;
  const x=(i)=>padL+(data.length===1?plotW/2:i*(plotW/(data.length-1)));
  const y=(v)=>padT+plotH-(v-min)/(max-min)*plotH;
  const ticks=5;

  return (
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        {/* grid */}
        {Array.from({length:ticks+1}).map((_,i)=>{
          const v=max/ticks*i; const yy=y(v);
          return <g key={i}>
            <line className="grid-line" x1={padL} y1={yy} x2={W-padR} y2={yy}/>
            <text className="axis-lbl" x={padL-8} y={yy+3.5} textAnchor="end">{fmtK(v)}</text>
          </g>;
        })}
        {/* month labels */}
        {data.map((d,i)=>(
          <text key={i} className="axis-lbl" x={x(i)} y={H-8} textAnchor="middle">{d.m}</text>
        ))}
        {/* area fill for first key (actual) */}
        {keys.slice(0,1).map((k,ki)=>{
          const areaPath = data.map((d,i)=>`${i===0?'M':'L'}${x(i)},${y(d[k.k])}`).join(' ')
            + ` L${x(data.length-1)},${padT+plotH} L${padL},${padT+plotH} Z`;
          return <path key={'area-'+ki} d={areaPath} fill={k.color} opacity=".06"/>;
        })}
        {/* lines */}
        {keys.map((k,ki)=>{
          const path=data.map((d,i)=>`${i?'L':'M'}${x(i)},${y(d[k.k])}`).join(' ');
          return <path key={ki} d={path} fill="none" stroke={k.color}
            strokeWidth={ki===0?2.5:2} strokeDasharray={k.dash||'0'}
            strokeLinejoin="round" strokeLinecap="round"/>;
        })}
        {/* dots with hover */}
        {keys.map((k,ki)=>data.map((d,i)=>(
          <g key={ki+'-'+i}>
            <circle cx={x(i)} cy={y(d[k.k])} r="8" fill="transparent"
              onMouseMove={(e)=>{const r=e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
                setTip({x:e.clientX-r.left,y:e.clientY-r.top,
                  html:`${d.m} · <b>${k.label}</b><br/>${fmt(d[k.k])} hrs`});}}
              onMouseLeave={()=>setTip(null)} style={{cursor:'pointer'}}/>
            <circle cx={x(i)} cy={y(d[k.k])} r="3.5" fill="#fff"
              stroke={k.color} strokeWidth="2" style={{pointerEvents:'none'}}/>
          </g>
        )))}
      </svg>
      {tip}
    </div>
  );
}

/* ---- Donut Chart -------------------------------------------------- */
function Donut({ segments, center }){
  const [tip,setTip]=useTip();
  const R=76, r=48, cx=88, cy=88;
  const total=segments.reduce((s,x)=>s+x.value,0);
  let a=-Math.PI/2;
  const arc=(start,end)=>{
    const x1=cx+R*Math.cos(start),y1=cy+R*Math.sin(start);
    const x2=cx+R*Math.cos(end),y2=cy+R*Math.sin(end);
    const xi2=cx+r*Math.cos(end),yi2=cy+r*Math.sin(end);
    const xi1=cx+r*Math.cos(start),yi1=cy+r*Math.sin(start);
    const big=end-start>Math.PI?1:0;
    return `M${x1},${y1} A${R},${R} 0 ${big} 1 ${x2},${y2} L${xi2},${yi2} A${r},${r} 0 ${big} 0 ${xi1},${yi1} Z`;
  };
  return (
    <div style={{position:'relative',display:'flex',alignItems:'center',gap:16,height:'100%'}}>
      <svg viewBox="0 0 176 176" width="152" height="152" style={{flex:'none'}}>
        {segments.map((s,i)=>{
          const ang=s.value/total*Math.PI*2; const st=a; a+=ang;
          return <path key={i} d={arc(st,a)} fill={s.color}
            onMouseMove={(e)=>{const rr=e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
              setTip({x:e.clientX-rr.left,y:e.clientY-rr.top,
                html:`<b>${s.label}</b><br/>${s.value} jobs · ${Math.round(s.value/total*100)}%`});}}
            onMouseLeave={()=>setTip(null)} style={{cursor:'pointer'}}/>;
        })}
        <text x="88" y="82" textAnchor="middle" fontFamily="Montserrat,sans-serif"
          fontSize="28" fontWeight="800" fill={C.navy}>{center.top}</text>
        <text x="88" y="100" textAnchor="middle" fontSize="10.5" fill="#6B7682" fontWeight="600">
          {center.bot}</text>
      </svg>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {segments.map((s,i)=>(
          <div key={i} className="lg" style={{fontSize:11.5}}>
            <span className="lg-sw" style={{background:s.color}}></span>
            <span style={{color:C.ink,fontWeight:700,minWidth:72}}>{s.label}</span>
            <span style={{color:'#6B7682'}}>{s.value} · {Math.round(s.value/total*100)}%</span>
          </div>
        ))}
      </div>
      {tip}
    </div>
  );
}

/* ---- Billing Group Mini Bars (hero aside on exec) ----------------- */
function BillingGroupAside({ groups }){
  const max = Math.max(...groups.map(g=>Math.max(g.actual,g.quoted)));
  return (
    <div className="bgroup-list">
      <div style={{fontSize:9,fontWeight:700,letterSpacing:'.12em',textTransform:'uppercase',
        color:'#9AAFC4',marginBottom:2}}>By Billing Group</div>
      {groups.map(g=>{
        const aW = (g.actual/max*100).toFixed(1)+'%';
        const qW = (g.quoted/max*100).toFixed(1)+'%';
        const over = g.actual > g.quoted;
        return (
          <div key={g.name} className="bgroup-row">
            <div className="bgroup-labels">
              <span className="bgroup-name">{g.name}</span>
              <span className="bgroup-nums">
                <span style={{color: over ? '#9a7300' : '#3d6906', fontWeight:700}}>
                  {fmt(g.actual)}</span>
                <span style={{color:'#9AAFC4'}}> / {fmt(g.quoted)}</span>
              </span>
            </div>
            <div className="bgroup-track">
              <span className="bgroup-quoted" style={{width:qW,background:'#061D39'}}></span>
              <span className="bgroup-actual" style={{width:aW,
                background: over ? '#FFDE51' : '#1574C4'}}></span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { HBar, LineTrend, Donut, BillingGroupAside, fmt, fmtK, usd, usdK });
