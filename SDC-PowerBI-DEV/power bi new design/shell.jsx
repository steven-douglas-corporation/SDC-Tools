/* ============================================================
   SDC shell — nav rail, header, KPI card, hero primitives
   ============================================================ */
const SC = window.SDC.C;

/* simple line icons (stroke = currentColor) */
const Icon = ({ d, size=18 }) => (
  <svg className="nav-ico" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const ICONS = {
  exec:  <Icon d={<><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></>} />,
  hours: <Icon d={<><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></>} />,
  util:  <Icon d={<><path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/></>} />,
  profit:<Icon d={<><path d="M12 2v20"/><path d="M17 6.5c0-2-2.2-3-5-3s-5 1-5 3 2.2 2.6 5 3 5 1.2 5 3.2-2.2 3-5 3-5-1-5-3"/></>} />,
  parts: <Icon d={<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7l8.7 5 8.7-5"/><path d="M12 22V12"/></>} />,
  detail:<Icon d={<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>} />,
};

const NAV = [
  { id:'exec',   label:'Executive Summary', icon:'exec'  },
  { id:'hours',  label:'Job Hours',          icon:'hours' },
  { id:'util',   label:'Employee Utilization',icon:'util' },
  { id:'profit', label:'Profitability',      icon:'profit'},
  { id:'parts',  label:'Parts & Costs',      icon:'parts' },
];

function Rail({ page, go }){
  return (
    <div className="rail">
      <div className="rail-brand"><img src="assets/sdc-logo-white.png" alt="SDC"/></div>
      <div className="rail-label">Reports</div>
      <div className="nav">
        {NAV.map(n=>(
          <div key={n.id} className={'nav-item'+(page===n.id?' active':'')} onClick={()=>go(n.id)}>
            {ICONS[n.icon]}<span>{n.label}</span>
          </div>
        ))}
      </div>
      <div className="rail-label" style={{marginTop:6}}>Drill-through</div>
      <div className="nav">
        <div className={'nav-item'+(page==='detail'?' active':'')} onClick={()=>go('detail')}>
          {ICONS.detail}<span>Job Detail</span>
        </div>
      </div>
      <div className="nav-foot">
        <b>Job Hours Report</b><br/>Management Level<br/>Refreshed thru {window.SDC.meta.refreshedThru}
      </div>
    </div>
  );
}

function Header({ title, sub }){
  return (
    <div className="hdr">
      <div className="hdr-titlewrap">
        <div className="hdr-title mont">{title}</div>
        {sub && <div className="hdr-sub">{sub}</div>}
      </div>
      <img className="hdr-logo" src="assets/sdc-logo-white.png" alt="Steven Douglas Corp."/>
    </div>
  );
}

function QStrip({ q }){
  return (
    <div className="qstrip">
      <span className="q-eyebrow">This page answers</span>
      <span className="q-text">“{q}”</span>
    </div>
  );
}

/* KPI card. accent = brand color bar; tone optional 'warn'|'good' */
function Kpi({ label, value, foot, accent, tone }){
  return (
    <div className={'kpi'+(tone?' '+tone:'')}>
      {accent && <div className="kpi-accent" style={{background:accent}}></div>}
      <div className="kpi-label">{label}</div>
      <div className="kpi-val">{value}</div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

/* Hero — big number + optional delta pill + optional aside visual */
function Hero({ label, value, sub, delta, aside }){
  return (
    <div className="hero">
      <div className="hero-main">
        <div className="hero-label">{label}</div>
        <div style={{display:'flex',alignItems:'flex-end',gap:18}}>
          <div className="hero-num">{value}</div>
          {delta}
        </div>
        {sub && <div className="hero-sub">{sub}</div>}
      </div>
      {aside && <div className="hero-aside">{aside}</div>}
    </div>
  );
}

function Delta({ pct, dir, kind }){
  // kind: 'over' (yellow caution) | 'good' (green) | 'bad'
  const arrow = dir==='up' ? '▲' : '▼';
  return <span className={'delta '+kind}><span className="delta-arrow">{arrow}</span>{pct}</span>;
}

function Panel({ title, legend, children, style }){
  return (
    <div className="panel" style={style}>
      <div className="panel-head">
        <div className="panel-title">{title}</div>
        {legend && <div className="panel-legend">{legend}</div>}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}
const Lg = ({c,t}) => <span className="lg"><span className="lg-sw" style={{background:c}}></span>{t}</span>;

/* status pill */
function StatusPill({ status }){
  const map={ 'On Track':SC.green, 'At Risk':SC.yellow, 'Overrun':SC.yellow, 'Complete':SC.gray };
  const col=map[status]||SC.gray;
  return <span className="pill" style={{background:col+ (status==='At Risk'||status==='Overrun'?'44':'33'), color: status==='On Track'?'#3f6b07':(status==='Complete'?'#5a6470':'#8a6d00')}}>
    <span className="dot" style={{background:col}}></span>{status}</span>;
}

/* Slicer (visual only) */
function Slicer({ label, value, active, onClick }){
  return (
    <div className="slicer">
      <div className="slicer-lbl">{label}</div>
      <div className={'slicer-box'+(active?' active':'')} onClick={onClick}>
        <span>{value}</span><span className="chev">▼</span>
      </div>
    </div>
  );
}

Object.assign(window, { Rail, Header, QStrip, Kpi, Hero, Delta, Panel, Lg, StatusPill, Slicer, NAV });
