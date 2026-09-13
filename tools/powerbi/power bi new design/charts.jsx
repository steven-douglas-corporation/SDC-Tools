/* ============================================================
   SDC charts — flat SVG, no gradients/shadows (per brand rules)
   ============================================================ */
const { useState, useRef } = React;
const C = window.SDC.C;

const fmt  = (n) => n.toLocaleString('en-US');
const fmtK = (n) => Math.abs(n) >= 1000 ? (n/1000).toFixed(n%1000===0?0:1)+'K' : ''+n;
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

/* ---- Horizontal bar chart (ranked, sorted descending) ----------
   data: [{label, value, tone, id?}]  toneColor maps tone->color
   onPick(id) for drill-through. valueFmt for labels. */
function HBar({ data, colorFor, valueFmt=fmt, onPick, max }){
  const [tip,setTip] = useTip();
  const W=640, rowH=Math.min(34, 300/data.length), gap=8;
  const labelW=190, valW=64, plotW=W-labelW-valW;
  const top=6;
  const mx = max || Math.max(...data.map(d=>Math.abs(d.value)));
  const H = top + data.length*(rowH+gap);
  const hasNeg = data.some(d=>d.value<0);
  const zero = hasNeg ? labelW + plotW*0.5 : labelW;
  const scale = hasNeg ? (plotW*0.5)/mx : plotW/mx;
  return (
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        {data.map((d,i)=>{
          const y=top+i*(rowH+gap);
          const w=Math.abs(d.value)*scale;
          const x=d.value<0 ? zero-w : zero;
          const col=colorFor(d);
          return (
            <g key={i}
               style={{cursor:onPick?'pointer':'default'}}
               onClick={()=>onPick&&onPick(d.id)}
               onMouseMove={(e)=>{const r=e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
                 setTip({x:e.clientX-r.left,y:e.clientY-r.top,html:`<b>${d.label}</b><br/>${valueFmt(d.value)}`});}}
               onMouseLeave={()=>setTip(null)}>
              <text className="bar-name" x={labelW-10} y={y+rowH/2+4} textAnchor="end">
                {d.label.length>26?d.label.slice(0,25)+'…':d.label}</text>
              <rect x={labelW} y={y} width={plotW} height={rowH} fill="#F2F5F8" rx="3"/>
              <rect x={x} y={y} width={Math.max(w,2)} height={rowH} fill={col} rx="3"/>
              <text className="bar-val" x={d.value<0?x-6:x+w+6} y={y+rowH/2+4}
                    textAnchor={d.value<0?'end':'start'}>{valueFmt(d.value)}</text>
            </g>
          );
        })}
        {hasNeg && <line x1={zero} y1={0} x2={zero} y2={H} stroke="#C9D2DB" strokeWidth="1"/>}
      </svg>
      {tip}
    </div>
  );
}

/* ---- Clustered/overlaid: actual vs quoted per row (used in detail) */

/* ---- Line chart: actual (blue) vs quoted (navy), no area fill --- */
function LineTrend({ data, keys }){
  // keys: [{k,color,label,dash}]
  const [tip,setTip] = useTip();
  const W=900,H=300, padL=46,padR=16,padT=14,padB=28;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  const all=data.flatMap(d=>keys.map(k=>d[k.k]));
  const max=Math.ceil(Math.max(...all)/5000)*5000, min=0;
  const x=(i)=>padL+ (data.length===1?plotW/2: i*(plotW/(data.length-1)));
  const y=(v)=>padT+plotH-(v-min)/(max-min)*plotH;
  const ticks=5;
  return (
    <div style={{position:'relative',width:'100%',height:'100%'}}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        {Array.from({length:ticks+1}).map((_,i)=>{
          const v=max/ticks*i, yy=y(v);
          return <g key={i}>
            <line className="grid-line" x1={padL} y1={yy} x2={W-padR} y2={yy}/>
            <text className="axis-lbl" x={padL-8} y={yy+3} textAnchor="end">{fmtK(v)}</text>
          </g>;
        })}
        {data.map((d,i)=><text key={i} className="axis-lbl" x={x(i)} y={H-9} textAnchor="middle">{d.m}</text>)}
        {keys.map((k,ki)=>{
          const path=data.map((d,i)=>`${i?'L':'M'}${x(i)},${y(d[k.k])}`).join(' ');
          return <path key={ki} d={path} fill="none" stroke={k.color} strokeWidth="3"
                   strokeDasharray={k.dash||'0'} strokeLinejoin="round" strokeLinecap="round"/>;
        })}
        {keys.map((k,ki)=>data.map((d,i)=>(
          <circle key={ki+'-'+i} cx={x(i)} cy={y(d[k.k])} r="4" fill="#fff" stroke={k.color} strokeWidth="2.5"
            onMouseMove={(e)=>{const r=e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
              setTip({x:e.clientX-r.left,y:e.clientY-r.top,html:`${d.m} · <b>${k.label}</b><br/>${fmt(d[k.k])} hrs`});}}
            onMouseLeave={()=>setTip(null)} style={{cursor:'pointer'}}/>
        )))}
      </svg>
      {tip}
    </div>
  );
}

/* ---- Donut (max 5 segments) — used sparingly ------------------- */
function Donut({ segments, center }){
  const [tip,setTip]=useTip();
  const R=78, r=50, cx=90, cy=90;
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
    <div style={{position:'relative',display:'flex',alignItems:'center',gap:18,height:'100%'}}>
      <svg viewBox="0 0 180 180" width="160" height="160" style={{flex:'none'}}>
        {segments.map((s,i)=>{
          const ang=s.value/total*Math.PI*2; const st=a; a+=ang;
          return <path key={i} d={arc(st,a)} fill={s.color}
            onMouseMove={(e)=>{const rr=e.currentTarget.ownerSVGElement.parentNode.getBoundingClientRect();
              setTip({x:e.clientX-rr.left,y:e.clientY-rr.top,html:`<b>${s.label}</b><br/>${s.value} jobs · ${Math.round(s.value/total*100)}%`});}}
            onMouseLeave={()=>setTip(null)} style={{cursor:'pointer'}}/>;
        })}
        <text x="90" y="84" textAnchor="middle" className="mont" fontSize="30" fontWeight="800" fill={C.navy}>{center.top}</text>
        <text x="90" y="104" textAnchor="middle" fontSize="11" fill="#6B7682" fontWeight="600">{center.bot}</text>
      </svg>
      <div style={{display:'flex',flexDirection:'column',gap:9}}>
        {segments.map((s,i)=>(
          <div key={i} className="lg" style={{fontSize:12}}>
            <span className="lg-sw" style={{background:s.color}}></span>
            <span style={{color:C.ink,fontWeight:700,minWidth:78}}>{s.label}</span>
            <span style={{color:'#6B7682'}}>{s.value} · {Math.round(s.value/total*100)}%</span>
          </div>
        ))}
      </div>
      {tip}
    </div>
  );
}

Object.assign(window, { HBar, LineTrend, Donut, fmt, fmtK, usd, usdK });
