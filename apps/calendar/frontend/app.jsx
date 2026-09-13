// SDC Centralized Calendar — app.jsx v3
// Legacy in-browser build: React, ReactDOM and XLSX are vendored UMD globals, and
// utils.js / data.js are plain <script> tags sharing this page's global scope,
// which ESLint cannot follow. Those names are declared below; anything still
// undefined is reported as a warning rather than an error so this legacy code
// does not block the lint gate. The Vite build under src/ is the one that must be clean.
/* global React, ReactDOM, XLSX */
/* global MONTHS, MONTHS_SHORT, DOW_LONG, DOW_SHORT, DOW_MINI, HOUR_H, CATEGORIES, CATMAP, TIMEZONES */
/* global isSameDay, ymd, parseYMD, startOfMonth, endOfMonth, addMonths, addDays, daysBetween, startOfWeek, fmtDateLong, fmtDateShort, fmtTime, timeToMin, rotateDow, getWeekNum */
/* global expandAll, generateICS, parseICS, downloadFile, detectConflicts, layoutTimeEvents, loadUserEvents, saveUserEvents, loadPrefs, savePrefs, loadEmployees, saveEmployees */
/* eslint no-undef: "warn", react/jsx-no-undef: ["error", { "allowGlobals": true }] */
const APP_VERSION = '1.2.3';

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// Feature 1: Hide skeleton pre-loader once React starts
const el = document.getElementById('pre-loader'); if(el) el.style.display='none';

// ─── Backend URL — auto-detects server from current host ─────────────────────
const API_URL = (() => {
  const h = window.location.hostname;
  const p = window.location.port;
  if (h === 'localhost' || h === '127.0.0.1') return `http://localhost:${p || 4005}`;
  return `${window.location.protocol}//${h}${p ? `:${p}` : ''}`;
})();

// ─── LOCAL MODE — set to true when the on-prem server is not yet running ────
// Switch to false once your Windows Server backend is deployed.
const LOCAL_MODE = true;
const LOCAL_USER = { name: 'Local Admin', email: 'admin@sdc.local', role: 'admin', allowedCategories: ['holiday','payday','birthday','meeting','company','deadline','personal','vacation'] };

// ─── Constants ───────────────────────────────────────────────
// ─── Constants & Helpers moved to utils.js ───────────────────

// ─── Icons ────────────────────────────────────────────────────
const Icon = {
  chev:(dir='left')=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{dir==='left'?<polyline points="15 18 9 12 15 6"/>:<polyline points="9 18 15 12 9 6"/>}</svg>,
  plus:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  search:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  x:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  trash:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  clock:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>,
  pin:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  users:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  download:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  upload:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  undo:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg>,
  redo:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.95"/></svg>,
  share:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
  bell:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  link:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  settings:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  edit:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  warn:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
};

// ─── Feature 2: Hover Card ────────────────────────────────────
function HoverCard({ event, anchorRect }) {
  const cat = CATMAP[event.category] || CATMAP['personal'];
  const style = {
    position: 'fixed',
    left: Math.min(anchorRect.left, window.innerWidth - 280),
    top: anchorRect.bottom + 6,
    zIndex: 200,
    width: 260,
    background: 'var(--bg-elev)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    boxShadow: 'var(--shadow-lg)',
    padding: '12px 14px',
    pointerEvents: 'none',
    animation: 'rise .15s ease',
  };
  return (
    <div style={style}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
        <div style={{width:10,height:10,borderRadius:'50%',background:event.color||cat.sw,flexShrink:0}}/>
        <div style={{fontWeight:700,fontSize:13,color:'var(--ink)',lineHeight:1.2,flex:1}}>{event.title}</div>
      </div>
      <div style={{fontSize:12,color:'var(--ink-3)',marginBottom:4}}>{fmtDateLong(event.date instanceof Date ? event.date : new Date(event.date))}</div>
      {event.time && <div style={{fontSize:12,color:'var(--ink-2)'}}>{fmtTime(event.time)}{event.endTime ? ` – ${fmtTime(event.endTime)}` : ''}</div>}
      <div style={{fontSize:11,color:cat.sw,marginTop:4,fontWeight:500}}>{cat.label}</div>
      {event.location && <div style={{fontSize:12,color:'var(--ink-3)',marginTop:4,display:'flex',alignItems:'center',gap:4}}>📍 {event.location}</div>}
      {event.description && <div style={{fontSize:12,color:'var(--ink-3)',marginTop:4,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{event.description}</div>}
    </div>
  );
}

// ─── Feature 5: Keyboard Shortcuts Overlay ───────────────────
function KeyboardShortcuts({ onClose }) {
  const shortcuts = [
    ['T', 'Go to today'],['N', 'New event'],['M', 'Month view'],['W', 'Week view'],['D', 'Day view'],
    ['←/→', 'Prev/Next period'],['Ctrl+Z', 'Undo'],['Ctrl+Y', 'Redo'],['Esc', 'Close modal'],['?', 'This help'],
  ];
  return (
    <div className="scrim" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal" style={{width:'min(420px,calc(100vw - 32px))'}}>
        <div className="modal-head"><h2>Keyboard Shortcuts</h2><button className="iconbtn" onClick={onClose}>{Icon.x}</button></div>
        <div className="modal-body">
          {shortcuts.map(([k,d])=>(
            <div key={k} style={{display:'flex',alignItems:'center',gap:16,padding:'8px 0',borderBottom:'1px solid var(--line)'}}>
              <kbd style={{background:'var(--bg-tint)',border:'1px solid var(--line-strong)',borderRadius:6,padding:'3px 10px',fontSize:12,fontFamily:'var(--font-mono)',fontWeight:600,minWidth:60,textAlign:'center',flexShrink:0}}>{k}</kbd>
              <span style={{fontSize:14,color:'var(--ink-2)'}}>{d}</span>
            </div>
          ))}
        </div>
        <div className="modal-foot"><div className="spacer"/><button className="btn primary" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  );
}

// ─── Feature 10: Month Summary Bar ───────────────────────────
function MonthSummaryBar({ viewDate, allEvents, activeCats, setActiveCats }) {
  const som = startOfMonth(viewDate), eom = endOfMonth(viewDate);
  const monthEvents = allEvents.filter(e => e.date >= som && e.date <= eom);
  const holidays = monthEvents.filter(e => e.category === 'holiday').length;
  const paydays = monthEvents.filter(e => e.category === 'payday').length;
  const birthdays = monthEvents.filter(e => e.category === 'birthday').length;
  const meetings = monthEvents.filter(e => e.category === 'meeting').length;
  const vacations = monthEvents.filter(e => e.category === 'vacation').length;
  
  const stats = [
    holidays > 0 && { id: 'holiday', icon:'🏛️', label: `${holidays} holiday${holidays>1?'s':''}`, color: 'var(--cat-holiday)' },
    paydays > 0 && { id: 'payday', icon:'💰', label: `${paydays} payday${paydays>1?'s':''}`, color: 'var(--cat-payday)' },
    birthdays > 0 && { id: 'birthday', icon:'🎂', label: `${birthdays} birthday${birthdays>1?'s':''}`, color: 'var(--cat-birthday)' },
    vacations > 0 && { id: 'vacation', icon:'🌴', label: `${vacations} vacation${vacations>1?'s':''}`, color: 'var(--cat-vacation)' },
    meetings > 0 && { id: 'meeting', icon:'📅', label: `${meetings} meeting${meetings>1?'s':''}`, color: 'var(--cat-meeting)' },
  ].filter(Boolean);

  if (stats.length === 0) return null;

  const handlePillClick = (catId) => {
    if (!setActiveCats) return;
    setActiveCats(prev => {
      if (prev.size === 1 && prev.has(catId)) {
        // Toggle back to ALL active
        return new Set(CATEGORIES.map(c => c.id));
      }
      return new Set([catId]);
    });
  };

  return (
    <div className="month-summary-bar">
      {stats.map((s,i) => {
        const isIsolated = activeCats.size === 1 && activeCats.has(s.id);
        return (
          <div 
            key={i} 
            className={`summary-pill ${isIsolated ? 'isolated' : ''}`} 
            style={{
              '--pill-color': s.color, 
              cursor: 'pointer',
              border: isIsolated ? `2px solid ${s.color}` : '1px solid transparent',
              transform: isIsolated ? 'scale(1.05)' : 'scale(1)',
              boxShadow: isIsolated ? 'var(--shadow-md)' : 'none',
              transition: 'all .2s ease'
            }}
            onClick={() => handlePillClick(s.id)}
            title={isIsolated ? 'Click to show all' : `Show only ${s.id}s`}
          >
            <span>{s.icon}</span><span>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Feature 16: Context Menu ─────────────────────────────────
function ContextMenu({ x, y, event, onEdit, onDelete, onPin, onClose }) {
  useEffect(()=>{
    const h = () => onClose();
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [onClose]);
  return (
    <div style={{position:'fixed',left:x,top:y,zIndex:300,background:'var(--bg-elev)',border:'1px solid var(--line)',borderRadius:8,boxShadow:'var(--shadow-lg)',minWidth:160,overflow:'hidden',animation:'rise .1s ease'}}>
      {[
        {label:`✏️ Edit "${event.title.substring(0,20)}"`, action:onEdit, disabled: event.seeded||event.readOnly},
        {label: event.pinned ? '📌 Unpin' : '📌 Pin', action:onPin, disabled: event.readOnly},
        {label:'🗑️ Delete', action:onDelete, danger:true, disabled: event.seeded||event.readOnly},
      ].map((item,i) => (
        <button key={i} disabled={item.disabled}
          style={{display:'block',width:'100%',padding:'9px 14px',border:0,background:'transparent',textAlign:'left',fontSize:13,cursor:item.disabled?'not-allowed':'pointer',color:item.danger?'#C0392B':item.disabled?'var(--ink-4)':'var(--ink-2)'}}
          onMouseEnter={e=>{if(!item.disabled)e.target.style.background='var(--bg-tint)'}}
          onMouseLeave={e=>{e.target.style.background='transparent'}}
          onClick={e=>{e.stopPropagation();if(!item.disabled){item.action();onClose();}}}
        >{item.label}</button>
      ))}
    </div>
  );
}

// ─── Mini calendar ────────────────────────────────────────────
function MiniCal({ viewDate, onJump, eventsByDay, selectedDate, weekStart }) {
  const [anchor, setAnchor] = useState(()=>new Date(viewDate.getFullYear(), viewDate.getMonth(), 1));
  useEffect(()=>{ setAnchor(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)); },[viewDate.getFullYear(), viewDate.getMonth()]);

  const today=new Date(), som=startOfMonth(anchor), eom=endOfMonth(anchor);
  const lead=(som.getDay()-weekStart+7)%7;
  const cells=[];
  for(let i=0;i<lead;i++){ const d=new Date(som); d.setDate(d.getDate()-(lead-i)); cells.push({d,out:true}); }
  for(let i=1;i<=eom.getDate();i++) cells.push({d:new Date(anchor.getFullYear(),anchor.getMonth(),i),out:false});
  while(cells.length%7!==0){ const last=cells[cells.length-1].d; const d=new Date(last); d.setDate(d.getDate()+1); cells.push({d,out:true}); }
  const dowLabels=rotateDow(weekStart,DOW_MINI);

  return (
    <div className="mini">
      <div className="mini-head">
        <div className="mini-title">{MONTHS[anchor.getMonth()]} {anchor.getFullYear()}</div>
        <div className="mini-nav">
          <button onClick={()=>setAnchor(addMonths(anchor,-1))} aria-label="Prev">{Icon.chev('left')}</button>
          <button onClick={()=>setAnchor(addMonths(anchor,1))}  aria-label="Next">{Icon.chev('right')}</button>
        </div>
      </div>
      <div className="mini-grid">
        {dowLabels.map((l,i)=><div key={i} className="mini-dow">{l}</div>)}
        {cells.map((c,i)=>{
          const key=ymd(c.d), has=eventsByDay.get(key)?.length>0;
          const cls=['mini-day'];
          if(c.out) cls.push('out');
          if(isSameDay(c.d,today)) cls.push('today');
          if(selectedDate&&isSameDay(c.d,selectedDate)) cls.push('selected');
          if(has) cls.push('has-event');
          return <div key={i} className={cls.join(' ')} onClick={()=>onJump(c.d)}>{c.d.getDate()}</div>;
        })}
      </div>
    </div>
  );
}

// ─── Time grid (shared by Week + Day views) ───────────────────
function TimeGrid({ days, events, activeCats, search, showWeekends, onOpenEvent, onNewEventOnDate, timezone, viewDate, onHover, onHoverEnd, onDropWithTime }) {
  const today=new Date();
  const nowRef=useRef(null);
  const [nowTop, setNowTop]=useState(()=>{ const n=new Date(); return (n.getHours()*60+n.getMinutes())/60*HOUR_H; });
  const draggedEventId=useRef(null);
  const [expandedGroups, setExpandedGroups]=useState(new Set());
  const MAX_CAL=2;
  const MAX_GROUPS=3;

  useEffect(()=>{
    const tick=()=>{ const n=new Date(); setNowTop((n.getHours()*60+n.getMinutes())/60*HOUR_H); };
    const id=setInterval(tick,60000);
    return ()=>clearInterval(id);
  },[]);

  useEffect(()=>{ if(nowRef.current) nowRef.current.scrollIntoView({block:'center',behavior:'smooth'}); },[]);

  const filtered=events.filter(e=>activeCats.has(e.category)).filter(e=>!search||e.title.toLowerCase().includes(search.toLowerCase()));

  const byDay=useMemo(()=>{
    const m=new Map();
    days.forEach(d=>{ m.set(ymd(d),{allDay:[],timed:[]}); });
    filtered.forEach(ev=>{
      const k=ymd(ev.date);
      if(!m.has(k)) return;
      if(ev.allDay||!ev.time) m.get(k).allDay.push(ev);
      else m.get(k).timed.push(ev);
    });
    return m;
  },[filtered, days]);

  const hasTimedEvents=useMemo(()=>[...byDay.values()].some(s=>s.timed.length>0),[byDay]);
  const hasAnySSEvents=useMemo(()=>[...byDay.values()].some(s=>s.allDay.some(e=>e.source==='scheduler')),[byDay]);
  const hours=Array.from({length:24},(_,i)=>i);

  const toggleGroup=(key)=>setExpandedGroups(prev=>{ const n=new Set(prev); n.has(key)?n.delete(key):n.add(key); return n; });

  return (
    <div className="time-grid-wrap">
      {/* ── Zone 1: Calendar events (birthdays, holidays, personal) ── */}
      <div className="tg-allday-row tg-zone-row">
        <div className="tg-time-col tg-zone-label-col">
          <span>Events</span>
        </div>
        {days.map((d,di)=>{
          const slot=byDay.get(ymd(d))||{allDay:[],timed:[]};
          const isToday=isSameDay(d,today);
          const calEvs=slot.allDay.filter(e=>e.source!=='scheduler');
          const visible=calEvs.slice(0,MAX_CAL);
          const hidden=calEvs.length-MAX_CAL;
          return (
            <div key={di} className={`tg-allday-cell tg-events-cell ${isToday?'today':''}`}>
              {visible.map(ev=>{
                const cat=CATMAP[ev.category];
                const fg=ev.color||cat.sw, bg=ev.color?(ev.color+'22'):cat.swBg;
                return (
                  <div key={ev.id} className="chip" style={{'--chip-fg':fg,'--chip-bg':bg}} onClick={()=>onOpenEvent(ev)} onMouseEnter={(e)=>onHover&&onHover(ev,e)} onMouseLeave={()=>onHoverEnd&&onHoverEnd()} title={ev.title}>
                    <span className="ttl">{ev.title}</span>
                  </div>
                );
              })}
              {hidden>0&&<div className="tg-allday-more">+{hidden} more</div>}
            </div>
          );
        })}
      </div>

      {/* ── Zone 2: SDC Scheduler tasks grouped by project ── */}
      {hasAnySSEvents&&(
        <div className="tg-allday-row tg-zone-row tg-tasks-row">
          <div className="tg-time-col tg-zone-label-col tg-tasks-label-col">
            <span>Tasks</span>
          </div>
          {days.map((d,di)=>{
            const slot=byDay.get(ymd(d))||{allDay:[],timed:[]};
            const isToday=isSameDay(d,today);
            const schedTasks=slot.allDay.filter(e=>e.source==='scheduler');
            const groupMap=new Map();
            schedTasks.forEach(ev=>{ const proj=ev.project||'Other'; if(!groupMap.has(proj))groupMap.set(proj,[]); groupMap.get(proj).push(ev); });
            const groups=[...groupMap.entries()];
            const visibleGroups=groups.slice(0,MAX_GROUPS);
            const hiddenGroups=groups.length-MAX_GROUPS;
            return (
              <div key={di} className={`tg-allday-cell tg-tasks-cell ${isToday?'today':''}`}>
                {visibleGroups.map(([proj,evs])=>{
                  const gk=`${ymd(d)}|${proj}`;
                  const expanded=expandedGroups.has(gk);
                  const avgPct=Math.round(evs.reduce((s,e)=>s+(parseInt(e.progress)||0),0)/evs.length);
                  const pColor=avgPct>0?ssPctColor(avgPct+'%'):null;
                  return (
                    <div key={proj} className="tg-task-group">
                      <div className="tg-task-group-hd" onClick={()=>toggleGroup(gk)} title={`${proj} · ${evs.length} task${evs.length!==1?'s':''}`}>
                        <span className="ss-job-num">{proj}</span>
                        <span className="tg-task-count">{evs.length} task{evs.length!==1?'s':''}</span>
                        {avgPct>0&&<span className="ss-pct tg-group-pct" style={pColor?{color:pColor}:{}}>{avgPct}%</span>}
                        <span className="tg-group-chevron">{expanded?'▲':'▼'}</span>
                      </div>
                      {expanded&&evs.map(ev=>{
                        const pColor2=ev.progress>0?ssPctColor(ev.progress+'%'):null;
                        return (
                          <div key={ev.id} className="chip tg-task-chip" style={{'--chip-fg':ev.color||'#1574c4','--chip-bg':(ev.color||'#1574c4')+'22'}} onClick={()=>onOpenEvent(ev)} title={ev.title}>
                            <span className="ttl">{ev.title}</span>
                            {ev.progress>0&&<span className="ss-pct" style={pColor2?{color:pColor2}:{}}>{ev.progress}%</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {hiddenGroups>0&&<div className="tg-allday-more">+{hiddenGroups} more projects</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Time grid ── */}
      <div className="tg-body">
        <div className="tg-inner" style={{height:`${HOUR_H*24}px`}}>
          <div className="tg-time-col">
            {hours.map(h=>(
              <div key={h} className="tg-hour-label" style={{top:`${h*HOUR_H}px`}}>
                {h===0?'':(h<12?`${h} AM`:h===12?'12 PM':`${h-12} PM`)}
              </div>
            ))}
          </div>

          {days.map((d,di)=>{
            const slot=byDay.get(ymd(d))||{allDay:[],timed:[]};
            const isToday=isSameDay(d,today);
            const laid=layoutTimeEvents(slot.timed);
            return (
              <div
                key={di}
                className={`tg-day-col ${isToday?'today':''}`}
                onClick={(e)=>{ if(!e.target.closest('.tg-event')) { const h=Math.floor(e.nativeEvent.offsetY/HOUR_H); const nd=new Date(d); nd.setHours(h,0,0,0); onNewEventOnDate(nd); } }}
                onDragOver={(e)=>e.preventDefault()}
                onDrop={(e)=>{
                  e.preventDefault();
                  if(!draggedEventId.current||!onDropWithTime) return;
                  const colEl=e.currentTarget;
                  const rect=colEl.getBoundingClientRect();
                  const y=e.clientY - rect.top;
                  const totalMin=Math.round(y/HOUR_H*60/15)*15;
                  const hh=Math.floor(totalMin/60), mm=totalMin%60;
                  const newTime=`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
                  onDropWithTime(draggedEventId.current, d, newTime);
                  draggedEventId.current=null;
                }}
              >
                {hours.map(h=><div key={h} className="tg-hour-line" style={{top:`${h*HOUR_H}px`}}/>)}

                {laid.map(ev=>{
                  const cat=CATMAP[ev.category];
                  const fg=ev.color||cat.sw, bg=ev.color?(ev.color+'22'):cat.swBg;
                  const top=timeToMin(ev.time)/60*HOUR_H;
                  const dur=ev.endTime?timeToMin(ev.endTime)-timeToMin(ev.time):60;
                  const h=Math.max(dur/60*HOUR_H,22);
                  const w=`${100/ev._totalCols}%`;
                  const l=`${ev._col/ev._totalCols*100}%`;
                  const isMatch=search&&ev.title.toLowerCase().includes(search.toLowerCase());
                  const tgCls=['tg-event'];
                  if(isMatch) tgCls.push('chip-match');
                  else if(search) tgCls.push('chip-dim');
                  return (
                    <div key={ev.id} className={tgCls.join(' ')} style={{top:`${top}px`,height:`${h}px`,left:l,width:w,'--chip-fg':fg,'--chip-bg':bg}} draggable={!ev.seeded} onDragStart={()=>{ draggedEventId.current=ev.id; }} onClick={(e)=>{ e.stopPropagation(); onOpenEvent(ev); }} onMouseEnter={(e)=>onHover&&onHover(ev,e)} onMouseLeave={()=>onHoverEnd&&onHoverEnd()} title={ev.title}>
                      <div className="tg-event-title">{ev.title}{ev.notify&&<span title={`Reminder: ${ev.notify} min before`} style={{fontSize:9,opacity:0.7,marginLeft:3}}>🔔</span>}</div>
                      {h>30&&<div className="tg-event-time">{fmtTime(ev.time,timezone)}{ev.endTime?` – ${fmtTime(ev.endTime,timezone)}`:''}</div>}
                    </div>
                  );
                })}

                {isToday&&<div ref={nowRef} className="tg-now-line" style={{top:`${nowTop}px`}}><div className="tg-now-dot"/></div>}
              </div>
            );
          })}

          {/* Empty time grid hint — shown once, centred at 9 AM */}
          {!hasTimedEvents&&(
            <div style={{position:'absolute',top:`${9*HOUR_H}px`,left:'56px',right:0,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none',zIndex:0}}>
              <span style={{fontSize:12,color:'var(--ink-3)',opacity:0.45,background:'var(--bg-elev)',padding:'4px 12px',borderRadius:20,border:'1px dashed var(--line)'}}>
                No timed events — click any slot to schedule one
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Week view ────────────────────────────────────────────────
function WeekView({ viewDate, events, activeCats, search, weekStart, showWeekends, onOpenEvent, onNewEventOnDate, timezone, onHover, onHoverEnd, onDropWithTime }) {
  const today=new Date();
  const ws=startOfWeek(viewDate, weekStart);
  const allDays=Array.from({length:7},(_,i)=>addDays(ws,i));
  const days=showWeekends ? allDays : allDays.filter(d=>d.getDay()!==0&&d.getDay()!==6);

  return (
    <div className="view-wrap">
      <div className="tg-header-row">
        <div className="tg-time-col"/>
        {days.map((d,i)=>{
          const isToday=isSameDay(d,today);
          return (
            <div key={i} className={`tg-day-head ${isToday?'today':''}`}>
              <span className="tg-dow">{DOW_SHORT[d.getDay()]}</span>
              <span className={`tg-dnum ${isToday?'today':''}`}>{d.getDate()}</span>
            </div>
          );
        })}
      </div>
      <TimeGrid days={days} events={events} activeCats={activeCats} search={search} showWeekends={showWeekends}
        onOpenEvent={onOpenEvent} onNewEventOnDate={onNewEventOnDate} timezone={timezone} viewDate={viewDate}
        onHover={onHover} onHoverEnd={onHoverEnd} onDropWithTime={onDropWithTime}/>
    </div>
  );
}

// ─── Day view ─────────────────────────────────────────────────
function DayView({ viewDate, events, activeCats, search, onOpenEvent, onNewEventOnDate, timezone, onHover, onHoverEnd, onDropWithTime }) {
  const today=new Date();
  const days=[viewDate];
  return (
    <div className="view-wrap">
      <div className="tg-header-row">
        <div className="tg-time-col"/>
        <div className={`tg-day-head ${isSameDay(viewDate,today)?'today':''}`} style={{flex:1}}>
          <span className="tg-dow">{DOW_LONG[viewDate.getDay()]}</span>
          <span className={`tg-dnum ${isSameDay(viewDate,today)?'today':''}`}>{viewDate.getDate()}</span>
          <span className="tg-month">{MONTHS[viewDate.getMonth()]} {viewDate.getFullYear()}</span>
        </div>
      </div>
      <TimeGrid days={days} events={events} activeCats={activeCats} search={search} showWeekends={true}
        onOpenEvent={onOpenEvent} onNewEventOnDate={onNewEventOnDate} timezone={timezone} viewDate={viewDate}
        onHover={onHover} onHoverEnd={onHoverEnd} onDropWithTime={onDropWithTime}/>
    </div>
  );
}

// ─── Month grid ───────────────────────────────────────────────
function MonthGrid({ viewDate, events, activeCats, search, weekStart, showWeekends, density, onOpenEvent, onNewEventOnDate, onSeeMore, onDropOnDate, timezone, onHover, onHoverEnd, onContextMenu, showWeekNumbers }) {
  const today=new Date();
  const som=startOfMonth(viewDate), eom=endOfMonth(viewDate);
  const lead=(som.getDay()-weekStart+7)%7;
  const cells=[];
  for(let i=0;i<lead;i++){ const d=new Date(som); d.setDate(d.getDate()-(lead-i)); cells.push({d,out:true}); }
  for(let i=1;i<=eom.getDate();i++) cells.push({d:new Date(viewDate.getFullYear(),viewDate.getMonth(),i),out:false});
  while(cells.length%7!==0){ const last=cells[cells.length-1].d; const d=new Date(last); d.setDate(d.getDate()+1); cells.push({d,out:true}); }

  const filteredEvents=events.filter(e=>activeCats.has(e.category)).filter(e=>!search||e.title.toLowerCase().includes(search.toLowerCase()));
  const byDay=new Map();
  filteredEvents.forEach(ev=>{
    if(ev.endDate && !isSameDay(new Date(ev.date), new Date(ev.endDate))) return; // multi-day handled separately
    const k=ymd(ev.date);
    if(!byDay.has(k)) byDay.set(k,[]);
    byDay.get(k).push(ev);
  });
  byDay.forEach(list=>list.sort((a,b)=>{ const pinDiff=(b.pinned?1:0)-(a.pinned?1:0); if(pinDiff!==0)return pinDiff; if(a.allDay!==b.allDay) return a.allDay?-1:1; return (a.time||'').localeCompare(b.time||''); }));

  const multiDayEvents=filteredEvents.filter(ev=>ev.endDate && !isSameDay(new Date(ev.date), new Date(ev.endDate)));

  const cols=showWeekends?7:5;
  const filteredCells=showWeekends ? cells : cells.filter(c=>c.d.getDay()!==0&&c.d.getDay()!==6);
  const weeks=[];
  for(let i=0;i<filteredCells.length;i+=cols) weeks.push(filteredCells.slice(i,i+cols));

  const maxChips=density==='compact'?2:density==='comfy'?4:3;
  const BANNER_H=22, CELL_NUM_H=28;

  const dowLabels=rotateDow(weekStart, showWeekends?DOW_SHORT:DOW_SHORT.filter((_,i)=>{ const dow=(weekStart+i)%7; return dow!==0&&dow!==6; }));

  // drag state
  const [dragId, setDragId]=useState(null);
  const [dragOver, setDragOver]=useState(null);

  return (
    <div className={showWeekends?'':'weekend-hidden'}>
      <div className="dow-row" style={{gridTemplateColumns:showWeekNumbers?`32px repeat(${cols},1fr)`:`repeat(${cols},1fr)`}}>
        {showWeekNumbers&&<div className="dow wk-num-col">Wk</div>}
        {Array.from({length:cols},(_,i)=>{
          const realDow=(weekStart+i)%7;
          const isWknd=realDow===0||realDow===6;
          return <div key={i} className={`dow${isWknd?' weekend':''}`}>{DOW_SHORT[(weekStart+i)%7]}</div>;
        })}
      </div>
      <div className="cal-grid">
        {weeks.map((weekCells,wi)=>{
          const wStart=weekCells[0].d;
          const wEnd=weekCells[weekCells.length-1].d;

          // Multi-day banner lane assignment for this week
          const mdInWeek=multiDayEvents.filter(ev=>{
            const es=new Date(ev.date), ee=new Date(ev.endDate);
            return es<=wEnd && ee>=wStart;
          });
          const laneAssign=[];
          mdInWeek.forEach(ev=>{
            const es=new Date(ev.date), ee=new Date(ev.endDate);
            const cs=Math.max(0, daysBetween(wStart,es));
            const ce=Math.min(cols-1, daysBetween(wStart,ee));
            let lane=0;
            while(laneAssign.some(a=>a.lane===lane && a.cs<=ce && a.ce>=cs)) lane++;
            laneAssign.push({ev,cs,ce,lane});
          });
          const numLanes=laneAssign.length>0?Math.max(...laneAssign.map(a=>a.lane))+1:0;
          const chipOffset=numLanes*BANNER_H;

          return (
            <div key={wi} className="week-row" style={{'--cols':cols,'--banner-offset':`${chipOffset}px`,gridTemplateColumns:showWeekNumbers?`32px repeat(${cols},1fr)`:`repeat(${cols},1fr)`}}>
              {showWeekNumbers&&<div className="wk-num-cell">{getWeekNum(weekCells[0].d)}</div>}
              {weekCells.map((c,di)=>{
                const list=byDay.get(ymd(c.d))||[];
                const isToday=isSameDay(c.d,today);
                const isWknd=c.d.getDay()===0||c.d.getDay()===6;
                const cls=['cell'];
                if(c.out) cls.push('out');
                if(isToday) cls.push('today');
                if(isWknd) cls.push('weekend');
                if(dragOver&&isSameDay(c.d,dragOver)) cls.push('drag-over');
                const shown=list.slice(0,maxChips);
                const extra=list.length-shown.length;
                return (
                  <div
                    key={di}
                    className={cls.join(' ')}
                    onClick={(e)=>{ if(e.target.closest('.chip,.event-banner,.chip-more')) return; onNewEventOnDate(c.d); }}
                    onDragOver={(e)=>{ e.preventDefault(); setDragOver(c.d); }}
                    onDragLeave={()=>setDragOver(null)}
                    onDrop={(e)=>{ e.preventDefault(); setDragOver(null); if(dragId) onDropOnDate(dragId,c.d); setDragId(null); }}
                  >
                    <div className={`cell-num${isToday?' today-num':''}`}>{c.d.getDate()}</div>
                    {isToday&&<div className="today-label">TODAY</div>}
                    <div className="chips" style={{paddingTop:`${chipOffset}px`}}>
                      {shown.map(ev=>{
                        const cat=CATMAP[ev.category];
                        const schedColor=ev.source==='scheduler'&&ev.progress>0?ssPctColor(ev.progress+'%'):null;
                        const fg=schedColor||(ev.color||cat.sw), bg=schedColor?(schedColor+'22'):(ev.color?(ev.color+'22'):cat.swBg);
                        const isMatch=search&&ev.title.toLowerCase().includes(search.toLowerCase());
                        const chipCls=['chip'];
                        if(ev.pinned) chipCls.push('pinned');
                        if(isMatch) chipCls.push('chip-match');
                        else if(search) chipCls.push('chip-dim');
                        return (
                          <div
                            key={ev.id}
                            className={chipCls.join(' ')}
                            style={{'--chip-fg':fg,'--chip-bg':bg}}
                            draggable={!ev.seeded && !ev.readOnly}
                            onDragStart={(e)=>{ e.stopPropagation(); setDragId(ev.id); e.dataTransfer.effectAllowed='move'; }}
                            onClick={(e)=>{ e.stopPropagation(); onOpenEvent(ev); }}
                            onMouseEnter={(e)=>onHover&&onHover(ev,e)}
                            onMouseLeave={()=>onHoverEnd&&onHoverEnd()}
                            onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); onContextMenu&&onContextMenu(ev,e.clientX,e.clientY); }}
                            title={ev.title}
                          >
                            {!ev.allDay&&ev.time&&<span className="t">{fmtTime(ev.time,timezone).replace(' ','').toLowerCase()}</span>}
                            {ev.source==='scheduler'&&<span className="ss-badge" style={{background:'#1574C4'}} title={ev.project||'Scheduler'}>SCH</span>}
                            <span className="ttl">{ev.title}</span>
                            {ev.source==='scheduler'&&ev.progress>0&&<span className="ss-pct">{ev.progress}%</span>}
                            {ev.repeat&&ev.repeat!=='none'&&<span className="chip-recur">↻</span>}
                            {ev.notify&&<span title={`Reminder: ${ev.notify} min before`} style={{fontSize:9,opacity:0.7}}>🔔</span>}
                            {ev.pinned&&<span style={{fontSize:9}}>📌</span>}
                          </div>
                        );
                      })}
                      {extra>0&&<div className="chip-more" onClick={(e)=>{ e.stopPropagation(); onSeeMore(c.d,[...list]); }}>+{extra} more</div>}
                    </div>
                  </div>
                );
              })}

              {/* Multi-day banners */}
              {laneAssign.map(({ev,cs,ce,lane},li)=>{
                const cat=CATMAP[ev.category];
                const fg=ev.color||cat.sw, bg=ev.color?(ev.color+'22'):cat.swBg;
                const isStart=new Date(ev.date)>=wStart;
                const isEnd=new Date(ev.endDate)<=wEnd;
                return (
                  <div
                    key={li}
                    className={`event-banner${isStart?' banner-start':''}${isEnd?' banner-end':''}`}
                    style={{
                      left:`calc(${cs}/${cols}*100%)`,
                      width:`calc(${ce-cs+1}/${cols}*100%)`,
                      top:`${CELL_NUM_H+lane*BANNER_H}px`,
                      '--chip-fg':fg,'--chip-bg':bg,
                    }}
                    onClick={(e)=>{ e.stopPropagation(); onOpenEvent(ev); }}
                    title={ev.title}
                  >
                    {isStart&&<span className="banner-title">{ev.title}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ─────────────────────────────────────
function DeleteConfirmModal({ title, onConfirm, onCancel }) {
  return (
    <div className="scrim" onClick={e=>{ if(e.target===e.currentTarget) onCancel(); }}>
      <div className="modal" style={{width:'min(380px,calc(100vw - 32px))'}} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>Delete Event</h2><button className="iconbtn" onClick={onCancel}>{Icon.x}</button></div>
        <div className="modal-body">
          <p style={{margin:0,fontSize:14,color:'var(--ink-2)'}}>Delete <strong>"{title}"</strong>? This action cannot be undone.</p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <div className="spacer"/>
          <button className="btn danger" onClick={onConfirm}>{Icon.trash} Delete</button>
        </div>
      </div>
    </div>
  );
}

// ─── Event modal ──────────────────────────────────────────────
function EventModal({ mode, event, date, allEvents, onClose, onSave, onDelete, timezone }) {
  const defaultDate=date||new Date();
  const initial=mode==='edit' ? {...event} : {
    id:`user-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    title:'', date:defaultDate, category:'personal',
    allDay:true, time:'', endTime:'', endDate:null,
    location:'', description:'', repeat:'none',
    attendees:'', url:'', color:'', notify:'', pinned:false,
  };
  const [form, setForm]=useState(initial);
  const [conflicts, setConflicts]=useState([]);
  const [showConflict, setShowConflict]=useState(false);
  const [recurEditMode, setRecurEditMode]=useState(null);
  const [confirmingDelete, setConfirmingDelete]=useState(false);
  const [detailLevel, setDetailLevel]=useState('detailed');
  const [viewMode, setViewMode]=useState('view');
  const isSeeded=event&&event.seeded;
  const isScheduler=event&&event.source==='scheduler'; // read-only — never editable
  const isPaylocity=event && (String(event.id).startsWith('paylocity') || (event.description && String(event.description).startsWith('Paylocity Time Off Report')));
  const isReadOnly=isSeeded||isScheduler;
  const up=(k,v)=>{ if(isReadOnly) return; setForm(f=>({...f,[k]:v})); };
  const cat=CATMAP[form.category]||CATMAP['personal'];
  const emps=loadEmployees() || window.SDC_DATA?.DEFAULT_EMPLOYEES || [];

  const submit=(force=false)=>{
    if(!form.title.trim()) return;
    const saveData={
      ...form,
      title:form.title.trim(),
      date:form.date instanceof Date ? form.date : parseYMD(form.date),
      endDate:form.endDate?(form.endDate instanceof Date?form.endDate:parseYMD(form.endDate)):null,
    };
    if(!force) {
      const found=detectConflicts(saveData, allEvents);
      if(found.length>0){ setConflicts(found); setShowConflict(true); return; }
    }
    onSave(saveData);
  };

  // Feature 20: Recurring edit dialog
  if (event?.isRecurringInstance && mode==='edit' && !recurEditMode) return (
    <div className="scrim" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal" style={{width:'min(400px,calc(100vw - 32px))'}}>
        <div className="modal-head"><h2>Edit Recurring Event</h2><button className="iconbtn" onClick={onClose}>{Icon.x}</button></div>
        <div className="modal-body">
          <p style={{fontSize:14,color:'var(--ink-2)',margin:0}}>This event repeats. What would you like to edit?</p>
        </div>
        <div className="modal-foot" style={{flexDirection:'column',gap:8,alignItems:'stretch'}}>
          <button className="btn" style={{textAlign:'left',padding:'12px 16px',height:'auto'}} onClick={()=>setRecurEditMode('this')}>
            <div style={{fontWeight:600}}>This event only</div>
            <div style={{fontSize:12,color:'var(--ink-3)',marginTop:2}}>Only change {fmtDateShort(event.date)}</div>
          </button>
          <button className="btn" style={{textAlign:'left',padding:'12px 16px',height:'auto'}} onClick={()=>setRecurEditMode('all')}>
            <div style={{fontWeight:600}}>All events in series</div>
            <div style={{fontSize:12,color:'var(--ink-3)',marginTop:2}}>Change every occurrence</div>
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );

  if (showConflict) return (
    <div className="scrim" onClick={e=>{ if(e.target===e.currentTarget){setShowConflict(false); onClose();} }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head"><h2>Scheduling Conflict</h2><button className="iconbtn" onClick={()=>setShowConflict(false)} aria-label="Back">{Icon.x}</button></div>
        <div className="modal-body">
          <div className="conflict-banner">{Icon.warn}<span>{conflicts.length} overlapping event{conflicts.length>1?'s':''} on this day:</span></div>
          {conflicts.map(c=><div key={c.id} className="conflict-item"><strong>{c.title}</strong> — {fmtTime(c.time,timezone)}{c.endTime?` – ${fmtTime(c.endTime,timezone)}`:''}</div>)}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={()=>setShowConflict(false)}>Go back</button>
          <div className="spacer"/>
          <button className="btn primary" onClick={()=>{ setShowConflict(false); submit(true); }}>Save anyway</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="scrim" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{mode==='edit'?(isScheduler?'Scheduler Task':isSeeded?'Event details':'Edit event'):'New event'}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.x}</button>
        </div>

        {isSeeded ? (
          <React.Fragment>
            <div className="detail-head" style={{borderBottom:0,paddingBottom:0}}>
              <div className="detail-swatch" style={{'--sw':form.color||cat.sw}}></div>
              <div style={{flex:1}}>
                <h3 className="detail-title">{form.title}</h3>
                <div className="detail-when">{fmtDateLong(form.date)}{form.endDate&&!isSameDay(form.date,new Date(form.endDate))?` – ${fmtDateLong(new Date(form.endDate))}`:''}</div>
              </div>
            </div>
            <div className="detail-body">
              <div className="detail-row"><div className="k">Category</div><div style={{display:'flex',alignItems:'center',gap:8}}><span style={{width:8,height:8,borderRadius:'50%',background:cat.sw,display:'inline-block'}}></span>{cat.label}</div></div>
              {form.time&&<div className="detail-row"><div className="k">Time</div><div>{fmtTime(form.time,timezone)}{form.endTime?` – ${fmtTime(form.endTime,timezone)}`:''}</div></div>}
              {form.location&&<div className="detail-row"><div className="k">Location</div><div>{form.location}</div></div>}
              {form.url&&<div className="detail-row"><div className="k">Link</div><div><a href={form.url} target="_blank" rel="noopener noreferrer" className="detail-link">{form.url}</a></div></div>}
              {form.meta?.role&&<div className="detail-row"><div className="k">Team</div><div>{form.meta.role}</div></div>}
              {form.kind&&<div className="detail-row"><div className="k">Type</div><div>{form.kind==='federal'?'US Federal Holiday':'SDC Observed'}</div></div>}
              {form.description&&<div className="detail-row"><div className="k">Notes</div><div>{form.description}</div></div>}
              <div style={{fontSize:12,color:'var(--ink-3)',marginTop:8,fontStyle:'italic'}}>Seeded events are read-only. Add a personal note for this day using "New event".</div>
            </div>
            <div className="modal-foot"><div className="spacer"/><button className="btn primary" onClick={onClose}>Close</button></div>
          </React.Fragment>
        ) : isScheduler ? (
          <React.Fragment>
            <div className="detail-head" style={{borderBottom:0,paddingBottom:0,display:'flex',alignItems:'center',gap:12}}>
              <div style={{display:'flex',flexDirection:'column',gap:4,flexShrink:0}}>
                <span className="ss-badge" style={{background:'#1574C4',padding:'4px 8px',borderRadius:6,color:'#fff',fontWeight:700,textAlign:'center',fontSize:11}}>SCH</span>
                {form.isMilestone && <span style={{background:'rgba(21,116,196,0.1)',color:'#1574C4',padding:'2px 6px',borderRadius:4,fontWeight:600,fontSize:10,textAlign:'center'}}>MILESTONE</span>}
              </div>
              <div style={{flex:1}}>
                <h3 className="detail-title" style={{margin:0}}>{form.title}</h3>
                <div className="detail-when" style={{marginTop:4}}>{fmtDateLong(form.date)}{form.endDate&&!isSameDay(form.date,new Date(form.endDate))?` – ${fmtDateLong(new Date(form.endDate))}`:''}</div>
              </div>
            </div>

            <div className="detail-body" style={{paddingTop:12}}>
              <div className="detail-row">
                <div className="k">Project</div>
                <div style={{fontWeight:600,color:'var(--ink)'}}>{form.project || '—'}</div>
              </div>
              <div className="detail-row">
                <div className="k">Phase</div>
                <div style={{fontWeight:500,color:'var(--ink)',textTransform:'capitalize'}}>{form.phase || '—'}</div>
              </div>
              <div className="detail-row">
                <div className="k">Assignee</div>
                <div>{form.assignee ? `👤 ${form.assignee}` : '—'}</div>
              </div>
              {(form.progress > 0) && (
                <div className="detail-row">
                  <div className="k">Progress</div>
                  <div style={{display:'flex',alignItems:'center',gap:10,flex:1}}>
                    <div style={{height:6,background:'var(--line)',borderRadius:3,overflow:'hidden',flex:1}}>
                      <div style={{height:'100%',width:`${Math.min(form.progress||0,100)}%`,background:ssPctColor(form.progress+'%'),borderRadius:3}}/>
                    </div>
                    <span style={{fontSize:11,fontWeight:700,color:ssPctColor(form.progress+'%')}}>{form.progress}%</span>
                  </div>
                </div>
              )}
              <div className="detail-row">
                <div className="k">Start Date</div>
                <div>{fmtDateLong(form.date)}</div>
              </div>
              <div className="detail-row">
                <div className="k">End Date</div>
                <div>{form.endDate ? fmtDateLong(new Date(form.endDate)) : '—'}</div>
              </div>
              {form.description && (
                <div className="detail-row" style={{flexDirection:'column',alignItems:'flex-start',gap:6,marginTop:4}}>
                  <div className="k">Notes</div>
                  <div style={{background:'var(--bg-elev)',padding:'12px 14px',borderRadius:8,width:'100%',fontSize:13,lineHeight:1.5,whiteSpace:'pre-wrap',border:'1px solid var(--line)',color:'var(--ink-2)',maxHeight:'200px',overflowY:'auto'}}>
                    {form.description}
                  </div>
                </div>
              )}
            </div>

            <div style={{margin:'0 20px 12px',padding:'10px 14px',background:'rgba(21,116,196,0.07)',border:'1px solid rgba(21,116,196,0.2)',borderRadius:8,display:'flex',alignItems:'center',gap:8,fontSize:12,color:'#1574C4'}}>
              <span className="ss-badge" style={{background:'#1574C4'}}>SCH</span>
              <span>This task is synced from <strong>SDC Scheduler</strong> and is <strong>read-only</strong>. Edit it in the Scheduler app.</span>
            </div>

            <div className="modal-foot">
              <div className="spacer"/>
              <button className="btn primary" onClick={onClose}>Close</button>
            </div>
          </React.Fragment>
        ) : (isPaylocity && viewMode === 'view') ? (
          <React.Fragment>
            {(() => {
              const data = {};
              if (form.description) {
                form.description.split('\n').forEach(line => {
                  const clean = (prefix) => line.replace(prefix, '').trim();
                  if (line.startsWith('Employee Number:')) data.empNo = clean('Employee Number:');
                  else if (line.startsWith('Employee #:')) data.empNo = clean('Employee #:');
                  else if (line.startsWith('Employee ID:')) data.empNo = clean('Employee ID:');
                  else if (line.startsWith('Employee:')) data.employee = clean('Employee:');
                  else if (line.startsWith('Type:')) data.type = clean('Type:');
                  else if (line.startsWith('Hours:')) data.hours = clean('Hours:');
                  else if (line.startsWith('Status:')) data.status = clean('Status:');
                });
              }
              const isApproved = data.status?.toLowerCase().includes('approved');
              const isPending  = data.status?.toLowerCase().includes('pending');
              
              let statusColor  = 'var(--ink-2)';
              let statusBg     = 'var(--bg-elev)';
              let statusBorder = '1px solid var(--line)';

              if (isApproved) {
                statusColor  = '#27AE60';
                statusBg     = '#E8F8F5';
                statusBorder = '1px solid #27AE60';
              } else if (isPending) {
                statusColor  = '#E67E22';
                statusBg     = '#FDF5E6';
                statusBorder = '1px solid #E67E22';
              }

              return (
                <React.Fragment>
                  <div className="detail-head" style={{borderBottom:0,paddingBottom:0,display:'flex',alignItems:'center',gap:12}}>
                    <div style={{display:'flex',flexDirection:'column',gap:4,flexShrink:0}}>
                      <span className="cat-pill active" style={{'--sw':'#27AE60','--sw-bg':'#E8F8F5',padding:'4px 8px',borderRadius:6,color:'#27AE60',fontWeight:700,textAlign:'center',fontSize:11,border:'1px solid #27AE60'}}>PTO</span>
                    </div>
                    <div style={{flex:1}}>
                      <h3 className="detail-title" style={{margin:0}}>{form.title}</h3>
                      <div className="detail-when" style={{marginTop:4}}>{fmtDateLong(form.date)}{form.endDate&&!isSameDay(form.date,new Date(form.endDate))?` – ${fmtDateLong(new Date(form.endDate))}`:''}</div>
                    </div>
                  </div>

                  {/* ── Toggle ── */}
                  <div style={{margin:'12px 20px 4px',display:'flex',gap:6,background:'var(--bg-elev)',padding:4,borderRadius:20,border:'1px solid var(--line)',width:'max-content'}}>
                    {['Simple', 'Short', 'Detailed'].map(lvl => (
                      <button
                        key={lvl}
                        type="button"
                        className={`btn btn-sm`}
                        style={{
                          padding:'4px 16px',
                          borderRadius:16,
                          fontSize:12,
                          fontWeight:600,
                          border:'none',
                          background:detailLevel===lvl.toLowerCase()?'#27AE60':'transparent',
                          color:detailLevel===lvl.toLowerCase()?'#fff':'var(--ink-3)',
                          cursor:'pointer',
                          transition:'all 0.2s'
                        }}
                        onClick={()=>setDetailLevel(lvl.toLowerCase())}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>

                  <div className="detail-body" style={{paddingTop:8}}>
                    {/* Level 1: Simple View */}
                    <div className="detail-row">
                      <div className="k">Employee Name</div>
                      <div style={{fontWeight:600,color:'var(--ink)'}}>{data.employee || '—'}</div>
                    </div>
                    <div className="detail-row">
                      <div className="k">Start Date</div>
                      <div>{fmtDateLong(form.date)}</div>
                    </div>
                    <div className="detail-row">
                      <div className="k">End Date</div>
                      <div>{form.endDate ? fmtDateLong(new Date(form.endDate)) : fmtDateLong(form.date)}</div>
                    </div>

                    {/* Level 2: Short View */}
                    {(detailLevel === 'short' || detailLevel === 'detailed') && (
                      <React.Fragment>
                        <div className="detail-row">
                          <div className="k">Employee Number</div>
                          <div>{data.empNo || '—'}</div>
                        </div>
                        <div className="detail-row">
                          <div className="k">Hours</div>
                          <div style={{fontWeight:600}}>{data.hours ? `⏱ ${data.hours}` : '—'}</div>
                        </div>
                        <div className="detail-row">
                          <div className="k">Status</div>
                          <span style={{
                            background: statusBg,
                            color: statusColor,
                            padding: '4px 12px',
                            borderRadius: 12,
                            fontSize: 12,
                            fontWeight: 700,
                            border: statusBorder
                          }}>
                            {data.status || 'Unknown'}
                          </span>
                        </div>
                      </React.Fragment>
                    )}

                    {/* Level 3: Detailed View */}
                    {detailLevel === 'detailed' && (
                      <div className="detail-row">
                        <div className="k">Description</div>
                        <div style={{fontWeight:500,color:'var(--ink-2)'}}>{data.type || 'Time Off'}</div>
                      </div>
                    )}
                  </div>

                  <div className="modal-foot">
                    <button className="btn danger" onClick={()=>setConfirmingDelete(true)}>{Icon.trash} Delete</button>
                    <button className="btn btn-sm" onClick={()=>{ const newPinned = !form.pinned; setForm(f=>({...f, pinned: newPinned})); onSave({...form, pinned: newPinned}); }} title="Pin this event" style={{color:form.pinned?'#F39C12':'var(--ink-3)',borderColor:form.pinned?'#F39C12':'var(--line-strong)'}}>
                      {form.pinned ? '📌 Pinned' : '📌 Pin'}
                    </button>
                    <div className="spacer"/>
                    <button className="btn" onClick={()=>setViewMode('edit')} style={{display:'flex',alignItems:'center',gap:4}}>✏️ Edit</button>
                    <button className="btn primary" onClick={onClose}>Close</button>
                  </div>
                  {confirmingDelete&&<DeleteConfirmModal title={form.title} onConfirm={()=>onDelete(form.id)} onCancel={()=>setConfirmingDelete(false)}/>}
                </React.Fragment>
              );
            })()}
          </React.Fragment>
        ) : (
          <React.Fragment>
            <div className="modal-body">
              <input className="input title-input" placeholder="Add title" autoFocus value={form.title} onChange={e=>up('title',e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') submit(); }} />

              <div className="field">
                <label>Category</label>
                <div className="cat-grid">
                  {CATEGORIES.map(c=>(
                    <button key={c.id} type="button" className={`cat-pill ${form.category===c.id?'active':''}`} style={{'--sw':c.sw,'--sw-bg':c.swBg}} onClick={()=>up('category',c.id)}>
                      <span className="dot"></span>{c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="row">
                <div className="field">
                  <label>Start date</label>
                  <input type="date" className="input" value={form.date instanceof Date?ymd(form.date):form.date} onChange={e=>up('date',parseYMD(e.target.value))} />
                </div>
                <div className="field">
                  <label>End date <span style={{fontWeight:400,textTransform:'none'}}>(multi-day)</span></label>
                  <input type="date" className="input" value={form.endDate?(form.endDate instanceof Date?ymd(form.endDate):form.endDate):''} onChange={e=>up('endDate',e.target.value?parseYMD(e.target.value):null)} />
                </div>
              </div>

              <div className="row">
                <div className="field">
                  <label>Repeat</label>
                  <select className="input" value={form.repeat} onChange={e=>up('repeat',e.target.value)}>
                    <option value="none">Doesn't repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
                <div className="field">
                  <label>Reminder</label>
                  <select className="input" value={form.notify||''} onChange={e=>up('notify',e.target.value)}>
                    <option value="">None</option>
                    <option value="5">5 minutes before</option>
                    <option value="15">15 minutes before</option>
                    <option value="30">30 minutes before</option>
                    <option value="60">1 hour before</option>
                    <option value="1440">1 day before</option>
                  </select>
                </div>
              </div>

              <div className="toggle-row">
                <div className={`toggle ${form.allDay?'on':''}`} onClick={()=>up('allDay',!form.allDay)} role="switch" aria-checked={form.allDay}></div>
                <span>All-day event</span>
              </div>

              {!form.allDay&&(
                <div className="row">
                  <div className="field"><label>Starts</label><input type="time" className="input" value={form.time||''} onChange={e=>up('time',e.target.value)}/></div>
                  <div className="field"><label>Ends</label><input type="time" className="input" value={form.endTime||''} onChange={e=>up('endTime',e.target.value)}/></div>
                </div>
              )}

              <div className="field">
                <label>Location</label>
                <input className="input" placeholder="Add location or meeting room" value={form.location||''} onChange={e=>up('location',e.target.value)}/>
              </div>

              <div className="field">
                <label>Meeting link / URL</label>
                <input className="input" placeholder="https://…" value={form.url||''} onChange={e=>up('url',e.target.value)} type="url"/>
              </div>

              <div className="row">
                <div className="field">
                  <label>Attendees</label>
                  <input className="input" list="employees-list" placeholder="Comma-separated names" value={form.attendees||''} onChange={e=>up('attendees',e.target.value)}/>
                  <datalist id="employees-list">
                    {emps.map(emp => {
                      const emailStr = emp.email || `${emp.name.toLowerCase().replace(/\s+/g, '.')}@sdcautomation.com`;
                      return (
                        <option key={emp.name} value={emailStr}>{emp.name} ({emailStr})</option>
                      );
                    })}
                  </datalist>
                </div>
                <div className="field">
                  <label>Custom color</label>
                  <div className="color-row">
                    <input type="color" className="color-pick" value={form.color||'#1574C4'} onChange={e=>up('color',e.target.value)}/>
                    {form.color&&<button className="btn btn-sm" onClick={()=>up('color','')}>Use category color</button>}
                  </div>
                </div>
              </div>

              <div className="field">
                <label>Description</label>
                <textarea className="input" rows="3" placeholder="Add notes…" value={form.description||''} onChange={e=>up('description',e.target.value)}/>
              </div>

              {mode==='edit'&&event?.creatorName&&(
                <div style={{fontSize:11,color:'var(--ink-3)',padding:'0 0 4px',display:'flex',alignItems:'center',gap:4}}>
                  {Icon.users} Created by <strong style={{color:'var(--ink-2)'}}>{event.creatorName}</strong>
                </div>
              )}
            </div>

            {isScheduler && (
              <div style={{margin:'0 20px 12px',padding:'10px 14px',background:'rgba(21,116,196,0.07)',border:'1px solid rgba(21,116,196,0.2)',borderRadius:8,display:'flex',alignItems:'center',gap:8,fontSize:12,color:'#1574C4'}}>
                <span className="ss-badge" style={{background:'#1574C4'}}>SCH</span>
                <span>This task is synced from <strong>SDC Scheduler</strong> and is <strong>read-only</strong>.</span>
              </div>
            )}
            <div className="modal-foot">
              {mode==='edit'&&!isReadOnly&&<button className="btn danger" onClick={()=>setConfirmingDelete(true)}>{Icon.trash} Delete</button>}
              {!isReadOnly&&<button className="btn btn-sm" onClick={()=>up('pinned',!form.pinned)} title="Pin this event" style={{color:form.pinned?'#F39C12':'var(--ink-3)',borderColor:form.pinned?'#F39C12':'var(--line-strong)'}}>
                {form.pinned ? '📌 Pinned' : '📌 Pin'}
              </button>}
              <div className="spacer"/>
              <button className="btn" onClick={onClose}>{isReadOnly?'Close':'Cancel'}</button>
              {!isReadOnly&&<button className="btn primary" onClick={()=>submit()} disabled={!form.title.trim()}>{mode==='edit'?'Save changes':'Create event'}</button>}
            </div>
            {confirmingDelete&&<DeleteConfirmModal title={form.title} onConfirm={()=>onDelete(form.id)} onCancel={()=>setConfirmingDelete(false)}/>}
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

// ─── Helper: extract job number from sheet name ───────────────
// "1118-Air Loop Assembly" → "1118"
// "1132 - Uniformity Mapper" → "1132"
function getJobNum(sheetName) {
  if (!sheetName) return null;
  const m = String(sheetName).match(/^(\d{3,6})/);
  return m ? m[1] : null;
}

// ─── Helper: progress colour for SS events ───────────────────
function ssPctColor(pct) {
  const p = parseInt(pct) || 0;
  if (p >= 100) return '#1B8A3F';
  if (p >= 75)  return '#2E9E55';
  if (p >= 50)  return '#E07B00';
  if (p >= 25)  return '#C0510A';
  return '#B71C1C';
}

// ─── Day overflow modal ───────────────────────────────────────
function DayModal({ date, events, onClose, onOpenEvent, onNewOnDate }) {
  const schedEvents = events.filter(e => e.source === 'scheduler');
  const regEvents   = events.filter(e => e.source !== 'scheduler');

  const RegChip = ({ev}) => {
    const cat = CATMAP[ev.category];
    const fg  = ev.color||cat.sw, bg = ev.color?(ev.color+'22'):cat.swBg;
    return (
      <div className="day-modal-chip" style={{'--chip-fg':fg,'--chip-bg':bg}} onClick={()=>{ onClose(); onOpenEvent(ev); }}>
        {!ev.allDay&&ev.time&&<span style={{fontSize:11,opacity:0.7,flexShrink:0}}>{fmtTime(ev.time)}</span>}
        <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ev.title}</span>
        {ev.pinned&&<span style={{fontSize:10}}>📌</span>}
      </div>
    );
  };

  const SSChip = ({ev}) => {
    const pct   = parseInt(ev.pctComplete)||0;
    const color = ssPctColor(pct);
    return (
      <div className="day-modal-ss-chip" onClick={()=>{ onClose(); onOpenEvent(ev); }}>
        {/* Header row: job badge + title + % */}
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
          <span className="ss-badge" style={{background:color,flexShrink:0}}>SS</span>
          {getJobNum(ev.sheetName)&&<span className="ss-job-num" style={{flexShrink:0}}>{getJobNum(ev.sheetName)}</span>}
          <span style={{fontSize:12,fontWeight:600,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'var(--ink)'}}>{ev.title}</span>
          {ev.pctComplete&&<span style={{fontSize:11,fontWeight:700,color,flexShrink:0}}>{ev.pctComplete}</span>}
        </div>
        {/* Progress bar */}
        <div style={{height:4,background:'var(--line)',borderRadius:2,overflow:'hidden',marginBottom:5}}>
          <div style={{height:'100%',width:`${Math.min(pct,100)}%`,background:color,borderRadius:2,transition:'width 0.3s'}}/>
        </div>
        {/* Meta row: project name · manager · duration · status */}
        <div style={{display:'flex',gap:10,fontSize:10,color:'var(--ink-3)',flexWrap:'wrap',alignItems:'center'}}>
          {ev.sheetName&&<span style={{fontWeight:500,color:'var(--ink-2)'}}>📋 {ev.sheetName.replace(/^\d{3,6}[-–\s]*/,'').trim()}</span>}
          {ev.manager&&<span>👤 {ev.manager}</span>}
          {ev.duration&&<span>⏱ {ev.duration}</span>}
          {ev.status&&<span style={{color:ev.status.toLowerCase().includes('complete')?'#1B8A3F':'var(--ink-3)',fontWeight:ev.status.toLowerCase().includes('complete')?600:400}}>● {ev.status}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="scrim" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal" style={{width:'min(520px,calc(100vw - 32px))'}} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2 style={{margin:0}}>{DOW_LONG[date.getDay()]}, {MONTHS[date.getMonth()]} {date.getDate()}</h2>
            <div style={{fontSize:12,color:'var(--ink-3)',marginTop:2}}>{events.length} event{events.length!==1?'s':''}{schedEvents.length>0?` · ${schedEvents.length} from Scheduler`:''}</div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.x}</button>
        </div>
        <div className="modal-body" style={{gap:0,padding:'12px 16px',maxHeight:'60vh',overflowY:'auto'}}>

          {/* Regular events */}
          {regEvents.length > 0 && (
            <div style={{marginBottom: schedEvents.length>0?16:0}}>
              {regEvents.length > 0 && schedEvents.length > 0 && (
                <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--ink-3)',marginBottom:6,paddingLeft:2}}>Calendar Events</div>
              )}
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                {regEvents.map(ev=><RegChip key={ev.id} ev={ev}/>)}
              </div>
            </div>
          )}

          {/* Scheduler tasks */}
          {schedEvents.length > 0 && (
            <div>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.1em',textTransform:'uppercase',color:'#1574C4',marginBottom:6,paddingLeft:2,display:'flex',alignItems:'center',gap:6}}>
                <span className="ss-badge" style={{background:'#1574C4'}}>SCH</span> Scheduler Tasks ({schedEvents.length})
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {schedEvents.map(ev=><SSChip key={ev.id} ev={ev}/>)}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div className="spacer"/>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={()=>{ onClose(); onNewOnDate(date); }}>{Icon.plus} New event</button>
        </div>
      </div>
    </div>
  );
}

// ─── Employee directory modal ─────────────────────────────────
function EmployeeModal({ employees, onSave, onClose }) {
  const [list, setList]=useState(()=>employees.map((e,i)=>({...e,_id:i})));
  const [editing, setEditing]=useState(null); 
  const [form, setForm]=useState({name:'',role:'',email:'',bMonth:1,bDay:1,id:''});

  const startEdit=(e)=>{ 
    setEditing(e._id); 
    setForm({name:e.name,role:e.role,email:e.email||'',bMonth:e.bMonth||1,bDay:e.bDay||1,id:e.id||''}); 
  };
  
  const saveEdit=()=>{
    if(!form.name.trim()) return;
    setList(l=>l.map(e=>e._id===editing?{...e,...form,name:form.name.trim()}:e));
    setEditing(null);
  };
  
  const addNew=()=>{
    if(!form.name.trim()) return;
    const _id=Date.now();
    setList(l=>[...l,{...form,name:form.name.trim(),_id}]);
    setForm({name:'',role:'',email:'',bMonth:1,bDay:1,id:''});
    setEditing(null);
  };
  
  const del=(id)=>setList(l=>l.filter(e=>e._id!==id));
  const saveAll=()=>onSave(list.map(({_id,...rest})=>rest));

  return (
    <div className="scrim" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal emp-modal" role="dialog" aria-modal="true" style={{width:'min(800px, calc(100vw - 32px))'}}>
        <div className="modal-head"><h2>Employee Directory</h2><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.x}</button></div>
        
        <div className="modal-body" style={{padding:0,maxHeight:'50vh',overflowY:'auto'}}>
          <table className="emp-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Job Title</th>
                <th>Email</th>
                <th>Birthday</th>
                <th style={{textAlign:'right'}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map(e=>(
                <tr key={e._id}>
                  {editing===e._id ? (
                    <td colSpan={6}>
                      <div className="emp-edit-form" style={{padding:'12px',background:'var(--bg-tint)',borderRadius:6,margin:'4px 0',display:'flex',flexDirection:'column',gap:8}}>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                          <input className="input" placeholder="Name" value={form.name} onChange={x=>setForm(f=>({...f,name:x.target.value}))} autoFocus/>
                          <input className="input" placeholder="Job Title" value={form.role} onChange={x=>setForm(f=>({...f,role:x.target.value}))}/>
                          <input className="input" placeholder="Employee ID" value={form.id||''} onChange={x=>setForm(f=>({...f,id:x.target.value}))}/>
                        </div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                          <input className="input" placeholder="Email" value={form.email||''} onChange={x=>setForm(f=>({...f,email:x.target.value}))}/>
                          <select className="input" value={form.bMonth} onChange={x=>setForm(f=>({...f,bMonth:+x.target.value}))}>
                            {MONTHS.map((m,i)=><option key={i} value={i+1}>{m}</option>)}
                          </select>
                          <input className="input" type="number" min="1" max="31" placeholder="Day" value={form.bDay} onChange={x=>setForm(f=>({...f,bDay:+x.target.value}))}/>
                        </div>
                        <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                          <button className="btn primary btn-sm" onClick={saveEdit}>Save</button>
                          <button className="btn btn-sm" onClick={()=>setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  ) : (
                    <React.Fragment>
                      <td style={{fontFamily:'var(--font-mono)',fontSize:12,color:'var(--ink-3)'}}>{e.id || '—'}</td>
                      <td style={{fontWeight:600}}>{e.name}</td>
                      <td>{e.role}</td>
                      <td style={{color:'var(--ink-3)',fontSize:12}}>{e.email || '—'}</td>
                      <td>{e.bMonth && e.bDay ? `${MONTHS_SHORT[e.bMonth-1]} ${e.bDay}` : '—'}</td>
                      <td>
                        <div style={{display:'flex',gap:4,justifyContent:'flex-end'}}>
                          <button className="iconbtn btn-sm" onClick={()=>startEdit(e)} title="Edit">{Icon.edit}</button>
                          <button className="iconbtn btn-sm danger" onClick={()=>del(e._id)} title="Delete">{Icon.trash}</button>
                        </div>
                      </td>
                    </React.Fragment>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="emp-add">
          <div className="section-label" style={{padding:'0 0 8px',color:'var(--ink-3)'}}>Add new employee</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
            <input className="input" placeholder="Full name" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
            <input className="input" placeholder="Job Title" value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))}/>
            <input className="input" placeholder="Employee ID" value={form.id||''} onChange={e=>setForm(f=>({...f,id:e.target.value}))}/>
          </div>
          <div className="row" style={{marginTop:6,gap:8,gridTemplateColumns:'1fr 1fr 1fr'}}>
            <input className="input" placeholder="Email" value={form.email||''} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/>
            <select className="input" value={form.bMonth} onChange={e=>setForm(f=>({...f,bMonth:+e.target.value}))}>{MONTHS.map((m,i)=><option key={i} value={i+1}>{m}</option>)}</select>
            <input className="input" type="number" min="1" max="31" value={form.bDay} onChange={e=>setForm(f=>({...f,bDay:+e.target.value}))} placeholder="Day"/>
          </div>
          <button className="btn primary" style={{marginTop:8,width:'100%'}} onClick={addNew} disabled={!form.name.trim()}>{Icon.plus} Add employee</button>
        </div>

        <div className="modal-foot">
          <div className="spacer"/>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={saveAll}>Save directory</button>
        </div>
      </div>
    </div>
  );
}

// ─── Import / Export modal ────────────────────────────────────
function ImportExportModal({ allEvents, userEvents, onImport, onClearPaylocity, onClose }) {
  const [tab, setTab]=useState('export');
  const [importText, setImportText]=useState('');
  const [importResult, setImportResult]=useState(null);
  const fileRef=useRef(null);

  const exportICS=()=>{
    const ics=generateICS(allEvents);
    downloadFile('sdc-calendar.ics',ics,'text/calendar');
  };
  const exportJSON=()=>{
    downloadFile('sdc-user-events.json',JSON.stringify(userEvents,null,2),'application/json');
  };
  const exportShare=()=>{
    // Generate a compact shareable HTML page
    const data=JSON.stringify(userEvents.map(e=>({...e,date:e.date.toISOString(),endDate:e.endDate?e.endDate.toISOString():null})));
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SDC Calendar Export</title></head><body>
<h2>SDC Calendar — Shared Events</h2>
<p>Open this in SDC Calendar to import: <button onclick="copyData()">Copy import data</button></p>
<pre id="d" style="white-space:pre-wrap;word-break:break-all">${data}</pre>
<script>function copyData(){navigator.clipboard.writeText(document.getElementById('d').textContent).then(()=>alert('Copied! Paste in Import tab.'))}</script>
</body></html>`;
    downloadFile('sdc-calendar-share.html',html,'text/html');
  };

  const handleFile=(e)=>{
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    const isExcel = file.name.endsWith('.xls') || file.name.endsWith('.xlsx');

    reader.onload=(ev)=>{
      try {
        let parsedEvents = [];
        if (isExcel) {
          const data = new Uint8Array(ev.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
          
          if (rows.length < 2) throw new Error('Excel sheet is empty.');
          
          let headerIdx = -1;
          let headers = [];
          for (let r = 0; r < Math.min(rows.length, 30); r++) {
            if (!rows[r]) continue;
            const candidate = Array.from(rows[r] || []).map(h => String(h || '').toLowerCase());
            const hasName = candidate.some(h => h.includes('name') || h.includes('employee'));
            const hasDate = candidate.some(h => h.includes('start') || h.includes('date'));
            if (hasName && hasDate) {
              headerIdx = r;
              headers = candidate;
              break;
            }
          }
          
          if (headerIdx === -1) {
            throw new Error('Could not locate the header row in the Excel sheet.');
          }

          let nameIdx = headers.findIndex(h => h && typeof h === 'string' && h.includes('name'));
          if (nameIdx === -1) {
            nameIdx = headers.findIndex(h => h && typeof h === 'string' && h.includes('employee'));
          }
          const empNoIdx = headers.findIndex(h => h && typeof h === 'string' && (h.includes('number') || h.includes('emp no') || h.includes('#') || h.includes('id')));
          const startIdx = headers.findIndex(h => h && typeof h === 'string' && (h.includes('start') || h.includes('date') || h.includes('from')));
          const endIdx = headers.findIndex(h => h && typeof h === 'string' && (h.includes('end') || h.includes('finish') || h.includes('to') || h.includes('thru')));
          const typeIdx = headers.findIndex(h => h && typeof h === 'string' && (h.includes('type') || h.includes('category') || h.includes('pto') || h.includes('vacation') || h.includes('code')));
          const hoursIdx = headers.findIndex(h => h && typeof h === 'string' && h.includes('hours'));
          const statusIdx = headers.findIndex(h => h && typeof h === 'string' && h.includes('status'));
          const descIdx = headers.findIndex(h => h && typeof h === 'string' && h.includes('description'));
          
          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[nameIdx] || !row[startIdx]) continue;
            
            const name = String(row[nameIdx]);
            const empNoStr = empNoIdx !== -1 && row[empNoIdx] ? String(row[empNoIdx]) : '';
            const startRaw = row[startIdx];
            const endRaw = endIdx !== -1 ? row[endIdx] : startRaw;
            
            let typeStr = 'Time Off';
            if (descIdx !== -1 && row[descIdx]) typeStr = String(row[descIdx]);
            else if (typeIdx !== -1 && row[typeIdx]) typeStr = String(row[typeIdx]);
            
            const hoursStr = hoursIdx !== -1 && row[hoursIdx] ? `${row[hoursIdx]} hrs` : '';
            const statusStr = statusIdx !== -1 && row[statusIdx] ? String(row[statusIdx]) : '';
            
            let startDate = new Date(startRaw);
            let startTimeStr = '';
            let endTimeStr = '';
            let isAllDay = true;

            if (typeof startRaw === 'number') {
              const daysOnly = Math.floor(startRaw);
              const baseDate = new Date(1899, 11, 30);
              startDate = new Date(baseDate.getTime() + daysOnly * 86400000);
              
              const fraction = startRaw - daysOnly;
              if (fraction > 0.0001) {
                isAllDay = false;
                const totalMs = Math.round(fraction * 86400000);
                const hrs = Math.floor(totalMs / 3600000);
                const mins = Math.floor((totalMs % 3600000) / 60000);
                startTimeStr = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
              }
            }
            if (isNaN(startDate.getTime())) continue;

            if (typeof endRaw === 'number') {
              const daysOnly = Math.floor(endRaw);
              const fraction = endRaw - daysOnly;
              if (fraction > 0.0001) {
                const totalMs = Math.round(fraction * 86400000);
                const hrs = Math.floor(totalMs / 3600000);
                const mins = Math.floor((totalMs % 3600000) / 60000);
                endTimeStr = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
              }
            }
            
            const fullTitle = [
              name,
              typeStr ? `(${typeStr})` : '',
              hoursStr ? `[${hoursStr}]` : '',
              statusStr ? `{${statusStr}}` : ''
            ].filter(Boolean).join(' ');

            parsedEvents.push({
              id: `paylocity-xls-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
              title: fullTitle,
              date: startDate,
              endDate: null,
              allDay: isAllDay,
              time: startTimeStr || null,
              endTime: endTimeStr || null,
              category: 'vacation',
              description: `Paylocity Time Off Report\nEmployee: ${name}\nEmployee Number: ${empNoStr}\nType: ${typeStr}\nHours: ${hoursStr}\nStatus: ${statusStr}`,
            });
          }
          setImportResult({events:parsedEvents, type:'xls'});

        } else {
          const text=ev.target.result;
          if(file.name.endsWith('.ics')) {
            const parsed=parseICS(text);
            setImportResult({events:parsed,type:'ics'});
          } else if(file.name.endsWith('.json')) {
            const parsed=JSON.parse(text).map(e=>({...e,date:new Date(e.date),endDate:e.endDate?new Date(e.endDate):null}));
            setImportResult({events:parsed,type:'json'});
          } else if(file.name.endsWith('.csv')) {
            const rows = text.split(/\r?\n/).map(r => r.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
            const headers = rows[0].map(h => h.toLowerCase());
            let nameIdx = headers.findIndex(h => h.includes('name'));
            if (nameIdx === -1) nameIdx = headers.findIndex(h => h.includes('employee'));
            const empNoIdx = headers.findIndex(h => h.includes('number') || h.includes('emp no') || h.includes('#') || h.includes('id'));
            const startIdx = headers.findIndex(h => h.includes('start') || h.includes('date') || h.includes('from'));
            const endIdx = headers.findIndex(h => h.includes('end') || h.includes('finish') || h.includes('to') || h.includes('thru'));
            const typeIdx = headers.findIndex(h => h.includes('type') || h.includes('category') || h.includes('pto') || h.includes('vacation') || h.includes('code'));
            
            if (nameIdx === -1 || startIdx === -1) throw new Error('CSV headers missing.');
            
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              if (row.length < 2 || !row[nameIdx] || !row[startIdx]) continue;
              const name = row[nameIdx];
              const empNoStr = empNoIdx !== -1 && row[empNoIdx] ? String(row[empNoIdx]) : '';
              const startRaw = row[startIdx];
              const endRaw = endIdx !== -1 ? row[endIdx] : startRaw;
              let typeStr = 'Time Off';
              if (descIdx !== -1 && row[descIdx]) typeStr = String(row[descIdx]);
              else if (typeIdx !== -1 && row[typeIdx]) typeStr = String(row[typeIdx]);
              
              const hoursStr = hoursIdx !== -1 && row[hoursIdx] ? `${row[hoursIdx]} hrs` : '';
              const statusStr = statusIdx !== -1 && row[statusIdx] ? String(row[statusIdx]) : '';
              
              const startDate = new Date(startRaw);
              if (isNaN(startDate.getTime())) continue;

              const fullTitle = [
                name,
                typeStr ? `(${typeStr})` : '',
                hoursStr ? `[${hoursStr}]` : '',
                statusStr ? `{${statusStr}}` : ''
              ].filter(Boolean).join(' ');

              parsedEvents.push({
                id: `paylocity-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
                title: fullTitle,
                date: startDate,
                endDate: null,
                allDay: true,
                category: 'vacation',
                description: `Paylocity Time Off Report\nEmployee: ${name}\nEmployee Number: ${empNoStr}\nType: ${typeStr}\nHours: ${hoursStr}\nStatus: ${statusStr}`,
              });
            }
            setImportResult({events:parsedEvents, type:'csv'});
          }
        }
      } catch(err) { alert('Could not parse file: '+err.message); }
    };

    if (isExcel) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  };

  const doImport=()=>{
    if(!importResult) return;
    onImport(importResult.events);
    onClose();
  };

  return (
    <div className="scrim" onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head"><h2>Import / Export</h2><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.x}</button></div>
        <div className="modal-body">
          <div className="tab-row">
            <button className={`tab-btn ${tab==='export'?'active':''}`} onClick={()=>setTab('export')}>Export</button>
            <button className={`tab-btn ${tab==='import'?'active':''}`} onClick={()=>setTab('import')}>Import</button>
          </div>

          {tab==='export'&&(
            <div className="export-options">
              <div className="export-option" onClick={exportICS}>
                <div className="export-icon">{Icon.download}</div>
                <div><div className="export-label">Export as .ics</div><div className="export-desc">Compatible with Outlook, Google Calendar, Apple Calendar</div></div>
              </div>
              <div className="export-option" onClick={exportJSON}>
                <div className="export-icon">{Icon.download}</div>
                <div><div className="export-label">Export user events as JSON</div><div className="export-desc">Backup your custom events for re-import later</div></div>
              </div>
              <div className="export-option" onClick={exportShare}>
                <div className="export-icon">{Icon.share}</div>
                <div><div className="export-label">Export shareable HTML page</div><div className="export-desc">Send to colleagues — they can copy data to import</div></div>
              </div>
            </div>
          )}

          {tab==='import'&&(
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <div className="import-drop" onClick={()=>fileRef.current.click()}>
                <div>{Icon.upload}</div>
                <div>Click to choose a .ics, .json, .csv, or .xls/.xlsx Paylocity report</div>
                <input ref={fileRef} type="file" accept=".ics,.json,.csv,.xls,.xlsx" style={{display:'none'}} onChange={handleFile}/>
              </div>
              {importResult&&(
                <div className="import-preview">
                  <div className="import-count">{importResult.events.length} event{importResult.events.length!==1?'s':''} ready to import</div>
                  <div className="import-list">
                    {importResult.events.slice(0,8).map((e,i)=><div key={i} className="import-item">{e.title} — {fmtDateShort(e.date)}</div>)}
                    {importResult.events.length>8&&<div className="import-item" style={{color:'var(--ink-3)'}}>…and {importResult.events.length-8} more</div>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {userEvents.some(ev => String(ev.id).includes('paylocity')) && (
            <button className="btn" onClick={onClearPaylocity} style={{ color: '#D96A4A', borderColor: '#D96A4A' }}>🗑 Clear Paylocity</button>
          )}
          <div className="spacer"/>
          <button className="btn" onClick={onClose}>Close</button>
          {tab==='import'&&<button className="btn primary" onClick={doImport} disabled={!importResult}>{Icon.upload} Import events</button>}
        </div>
      </div>
    </div>
  );
}

// ─── Tweaks panel ─────────────────────────────────────────────
const ACCENT_SWATCHES=[
  {name:'SDC Blue',value:'#1574C4',ink:'#0E548E',soft:'#E8F1F9'},
  {name:'Navy',    value:'#2E4A7A',ink:'#1B3258',soft:'#D7DFEE'},
  {name:'Teal',    value:'#0B7285',ink:'#095F6E',soft:'#C8EAF0'},
  {name:'Forest',  value:'#3C7D5C',ink:'#255A40',soft:'#D3E7DA'},
  {name:'Slate',   value:'#4A5464',ink:'#2F3744',soft:'#DCE0E6'},
  {name:'Coral',   value:'#D96A4A',ink:'#9A4428',soft:'#F5D9CE'},
];

function TweaksPanel({ open, onClose, prefs, setPrefs }) {
  if (!open) return null;
  const set=(k,v)=>{
    const next={...prefs,[k]:v};
    setPrefs(next);
    try { window.parent.postMessage({type:'__edit_mode_set_keys',edits:{[k]:v}},'*'); } catch {}
  };
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="tweaks">
      <div className="tweaks-head">
        <div className="t">Tweaks</div>
        <button className="iconbtn" style={{height:24,width:24,border:0,background:'transparent'}} onClick={onClose} aria-label="Close tweaks">{Icon.x}</button>
      </div>
      <div className="tweaks-body">
        <div className="tweak">
          <label>Accent color</label>
          <div className="swatches">
            {ACCENT_SWATCHES.map(s=>(
              <div key={s.name} className={`sw-chip ${prefs.accent===s.value?'active':''}`} title={s.name} style={{background:s.value}} onClick={()=>set('accent',s.value)}/>
            ))}
          </div>
        </div>
        <div className="tweak">
          <label>Theme</label>
          <div className="seg">
            <button className={prefs.theme==='light'?'active':''} onClick={()=>set('theme','light')}>Light</button>
            <button className={prefs.theme==='dark'?'active':''} onClick={()=>set('theme','dark')}>Dark</button>
          </div>
        </div>
        <div className="tweak">
          <label>Week starts</label>
          <div className="seg">
            <button className={prefs.weekStart===0?'active':''} onClick={()=>set('weekStart',0)}>Sunday</button>
            <button className={prefs.weekStart===1?'active':''} onClick={()=>set('weekStart',1)}>Monday</button>
          </div>
        </div>
        <div className="tweak">
          <label>Density</label>
          <div className="seg">
            <button className={prefs.density==='compact'?'active':''} onClick={()=>set('density','compact')}>Compact</button>
            <button className={prefs.density==='normal'?'active':''} onClick={()=>set('density','normal')}>Normal</button>
            <button className={prefs.density==='comfy'?'active':''} onClick={()=>set('density','comfy')}>Comfy</button>
          </div>
        </div>
        <div className="tweak">
          <label>Weekends</label>
          <div className="seg">
            <button className={prefs.showWeekends?'active':''} onClick={()=>set('showWeekends',true)}>Show</button>
            <button className={!prefs.showWeekends?'active':''} onClick={()=>set('showWeekends',false)}>Hide</button>
          </div>
        </div>
        <div className="tweak">
          <label>Week numbers</label>
          <div className="seg">
            <button className={prefs.showWeekNumbers?'active':''} onClick={()=>set('showWeekNumbers',true)}>Show</button>
            <button className={!prefs.showWeekNumbers?'active':''} onClick={()=>set('showWeekNumbers',false)}>Hide</button>
          </div>
        </div>
        <div className="tweak">
          <label>Display timezone</label>
          <select className="input tweak-select" value={prefs.timezone||tz} onChange={e=>set('timezone',e.target.value)}>
            {TIMEZONES.map(t=><option key={t} value={t}>{t.replace('_',' ')}</option>)}
          </select>
          <div style={{fontSize:11,color:'var(--ink-3)',marginTop:3}}>Browser: {tz}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Resizer ──────────────────────────────────────────────────
function Resizer({ width, onChange }) {
  const [dragging, setDragging]=useState(false);
  const ref=useRef({x:0,w:0});
  useEffect(()=>{
    if(!dragging) return;
    const onMove=(e)=>{ const dx=e.clientX-ref.current.x; onChange(Math.max(220,Math.min(520,ref.current.w+dx))); };
    const onUp=()=>setDragging(false);
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    return ()=>{ window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp); document.body.style.cursor=''; document.body.style.userSelect=''; };
  },[dragging,onChange]);
  return (
    <div className={`resizer ${dragging?'dragging':''}`} onMouseDown={e=>{ ref.current={x:e.clientX,w:width}; setDragging(true); e.preventDefault(); }} onDoubleClick={()=>onChange(300)} role="separator" title="Drag · double-click to reset">
      <div className="resizer-grip"/>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────
const SHAPES = { holiday:'★', payday:'●', birthday:'♥', meeting:'■', company:'▲', deadline:'◆', personal:'○', vacation:'🌴' };

// ─── Birthday Spotlight ───────────────────────────────────────
function BirthdaySpotlight({ birthdays }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? birthdays : birthdays.slice(0, 3);
  const extra = birthdays.length - 3;
  return (
    <div style={{background:'var(--side-bg-elev)',border:'1px solid var(--side-line-strong)',borderRadius:8,padding:'10px 12px'}}>
      <div style={{fontSize:11,color:'var(--side-ink-3)',textTransform:'uppercase',letterSpacing:'0.1em',fontWeight:600,marginBottom:6}}>🎂 Birthdays This Week</div>
      {shown.map(e=>(
        <div key={e.id} style={{fontSize:13,color:'var(--side-ink)',padding:'3px 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span>{e.title.replace("'s Birthday",'')}</span>
          <span style={{fontSize:11,color:'var(--side-ink-3)',flexShrink:0,marginLeft:8}}>{fmtDateShort(e.date)}</span>
        </div>
      ))}
      {extra > 0 && (
        <button
          onClick={()=>setExpanded(x=>!x)}
          style={{marginTop:6,fontSize:11,color:'var(--accent)',background:'transparent',border:'none',cursor:'pointer',padding:0,fontWeight:500,textDecoration:'underline'}}
        >
          {expanded ? '▲ Show less' : `+${extra} more`}
        </button>
      )}
    </div>
  );
}

function Sidebar({ viewDate, setViewDate, allEvents, activeCats, setActiveCats, search, setSearch, onNewEvent, onOpenEvent, weekStart, onOpenDirectory, onOpenImportExport, onUndo, onRedo, canUndo, canRedo, myEventsOnly, setMyEventsOnly, authUser, onSignOut, appVersion, prefs, setPrefs }) {
  const [collapsed, setCollapsed]=useState({mini:false,cats:false,upcoming:false});

  const eventsByDay=useMemo(()=>{
    const m=new Map();
    allEvents.forEach(e=>{ if(!activeCats.has(e.category)) return; const k=ymd(e.date); if(!m.has(k)) m.set(k,[]); m.get(k).push(e); });
    return m;
  },[allEvents,activeCats]);

  // Feature 7: View counts for current month
  const viewCounts=useMemo(()=>{
    const c={}; CATEGORIES.forEach(cat=>{ c[cat.id]=0; });
    const som=startOfMonth(viewDate), eom=endOfMonth(viewDate);
    allEvents.filter(e=>e.date>=som&&e.date<=eom).forEach(e=>{ c[e.category]=(c[e.category]||0)+1; });
    return c;
  },[allEvents,viewDate]);

  // Feature 23: Next 7 days upcoming
  const upcoming=useMemo(()=>{
    const now=new Date(); now.setHours(0,0,0,0);
    const week=new Date(now); week.setDate(week.getDate()+7);
    return allEvents.filter(e=>activeCats.has(e.category)).filter(e=>e.date>=now&&e.date<=week).filter(e=>!search||e.title.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>a.date-b.date).slice(0,8);
  },[allEvents,activeCats,search,viewDate]);

  // Feature 8: Next payday
  const nextPayday=useMemo(()=>{
    const now=new Date(); now.setHours(0,0,0,0);
    return allEvents.filter(e=>e.category==='payday'&&e.date>=now).sort((a,b)=>a.date-b.date)[0];
  },[allEvents]);

  // Feature 9: Birthdays this week
  const upcomingBirthdays=useMemo(()=>{
    const now=new Date(); now.setHours(0,0,0,0);
    const week=new Date(now); week.setDate(week.getDate()+7);
    return allEvents.filter(e=>e.category==='birthday'&&e.date>=now&&e.date<=week).sort((a,b)=>a.date-b.date);
  },[allEvents]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="assets/sdc-logo.png" alt="SDC" className="brand-logo"/>
        <div>
          <div className="brand-title">Centralized Calendar</div>
          <div className="brand-sub">SDC Automation · {new Date().getFullYear()} <span className="brand-version">v{appVersion||APP_VERSION}</span></div>
        </div>
      </div>
      <div className="sidebar-inner">
        <button className="btn-new" onClick={onNewEvent}>{Icon.plus} New event</button>
        <div className="search">
          {Icon.search}
          <input type="search" placeholder="Search events…" value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
        {/* Feature 11: My Events Only toggle */}
        <button
          onClick={()=>setMyEventsOnly(m=>!m)}
          style={{width:'100%',padding:'7px 12px',border:'1px solid var(--side-line-strong)',borderRadius:'var(--radius)',background:myEventsOnly?'var(--accent)':'transparent',color:myEventsOnly?'#fff':'var(--side-ink-2)',fontSize:12,fontWeight:500,textAlign:'left',display:'flex',alignItems:'center',gap:8,transition:'all .15s'}}
        >
          <span>{myEventsOnly ? '✓' : '○'}</span> My Events Only
        </button>

        {/* Feature 6: Collapsible Mini Cal */}
        <div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',cursor:'pointer',userSelect:'none'}} onClick={()=>setCollapsed(c=>({...c,mini:!c.mini}))}>
            <div className="section-label" style={{margin:0}}>Mini Calendar</div>
            <span style={{color:'var(--side-ink-3)',fontSize:12,display:'inline-block',transform:collapsed.mini?'rotate(-90deg)':'rotate(0deg)',transition:'transform .2s'}}>▾</span>
          </div>
          {!collapsed.mini&&<MiniCal viewDate={viewDate} onJump={setViewDate} eventsByDay={eventsByDay} selectedDate={viewDate} weekStart={weekStart}/>}
        </div>

        {/* Feature 6+7: Collapsible Categories with view counts */}
        <div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',cursor:'pointer',userSelect:'none'}} onClick={()=>setCollapsed(c=>({...c,cats:!c.cats}))}>
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div className="section-label" style={{margin:0}}>Categories</div>
              <span style={{fontSize:9,color:'var(--side-ink-3)',fontWeight:400,textTransform:'none',letterSpacing:'normal'}}>(this month)</span>
            </div>
            <span style={{color:'var(--side-ink-3)',fontSize:12,display:'inline-block',transform:collapsed.cats?'rotate(-90deg)':'rotate(0deg)',transition:'transform .2s'}}>▾</span>
          </div>
          {!collapsed.cats&&(
            <div className="filters" style={{marginTop:8}}>
              {CATEGORIES.map(cat=>{
                const active=activeCats.has(cat.id);
                return (
                  <label key={cat.id} className="filter">
                    <input type="checkbox" checked={active} onChange={e=>{ const next=new Set(activeCats); if(e.target.checked) next.add(cat.id); else next.delete(cat.id); setActiveCats(next); }}/>
                    <span className="swatch" style={{'--sw':cat.sw}}>{SHAPES[cat.id]||'●'}</span>
                    <span>{cat.label}</span>
                    <span className="count">{viewCounts[cat.id]||0}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Feature 8: Payday Countdown */}
        {nextPayday&&(
          <div style={{background:'var(--side-bg-elev)',border:'1px solid var(--side-line-strong)',borderRadius:8,padding:'10px 12px',display:'flex',alignItems:'center',gap:10}}>
            <div style={{fontSize:22}}>💰</div>
            <div>
              <div style={{fontSize:11,color:'var(--side-ink-3)',textTransform:'uppercase',letterSpacing:'0.1em',fontWeight:600}}>Next Payday</div>
              <div style={{fontSize:14,fontWeight:700,color:'var(--side-ink)'}}>{fmtDateShort(nextPayday.date)}</div>
              <div style={{fontSize:12,color:'var(--cat-payday)'}}>
                {Math.ceil((nextPayday.date-new Date())/86400000)===0?'🎉 Today!':
                 Math.ceil((nextPayday.date-new Date())/86400000)===1?'Tomorrow!':
                 `in ${Math.ceil((nextPayday.date-new Date())/86400000)} days`}
              </div>
            </div>
          </div>
        )}

        {/* Feature 9: Birthday Spotlight */}
        {upcomingBirthdays.length>0&&(
          <BirthdaySpotlight birthdays={upcomingBirthdays} />
        )}

        {/* Feature 6+23: Collapsible Upcoming / Next 7 Days */}
        <div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',cursor:'pointer',userSelect:'none'}} onClick={()=>setCollapsed(c=>({...c,upcoming:!c.upcoming}))}>
            <div className="section-label" style={{margin:0}}>Next 7 Days</div>
            <span style={{color:'var(--side-ink-3)',fontSize:12,display:'inline-block',transform:collapsed.upcoming?'rotate(-90deg)':'rotate(0deg)',transition:'transform .2s'}}>▾</span>
          </div>
          {!collapsed.upcoming&&(
            <div className="upcoming" style={{marginTop:8}}>
              {upcoming.length===0&&<div style={{fontSize:12,color:'var(--side-ink-3)'}}>Nothing in the next 7 days.</div>}
              {upcoming.map(e=>{
                const cat=CATMAP[e.category];
                return (
                  <div key={e.id} className="up-item" onClick={()=>onOpenEvent(e)}>
                    <div className="up-date"><div className="m">{MONTHS_SHORT[e.date.getMonth()]}</div><div className="d">{e.date.getDate()}</div></div>
                    <div><div className="up-title">{e.title}</div><div className="up-meta"><span className="up-dot" style={{'--sw':e.color||cat.sw}}></span><span>{!e.allDay&&e.time?fmtTime(e.time):cat.label}</span></div></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar-tools">
          <button className="tool-btn" onClick={onOpenDirectory} title="Employee Directory">{Icon.users} Directory</button>
          <button className="tool-btn" onClick={onOpenImportExport} title="Import / Export">{Icon.download} Import/Export</button>
          <button className="tool-btn" onClick={() => setPrefs(p => ({ ...p, theme: (prefs?.theme === 'dark') ? 'light' : 'dark' }))} title={prefs?.theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
            {prefs?.theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
          </button>
          <button className={`tool-btn ${!canUndo?'disabled':''}`} onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">{Icon.undo}</button>
          <button className={`tool-btn ${!canRedo?'disabled':''}`} onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">{Icon.redo}</button>
        </div>

        {/* Feature 24: User Profile */}
        {authUser&&(
          <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',borderTop:'1px solid var(--side-line)',marginTop:'auto',flexShrink:0}}>
            <div style={{width:32,height:32,borderRadius:'50%',background:'var(--accent)',color:'#fff',display:'grid',placeItems:'center',fontSize:12,fontWeight:700,flexShrink:0}}>
              {(authUser.name||authUser.email||'U').charAt(0).toUpperCase()}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,color:'var(--side-ink)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{authUser.name||authUser.email}</div>
              <div style={{fontSize:10,color:'var(--side-ink-3)',textTransform:'uppercase',letterSpacing:'0.1em'}}>{authUser.role||'User'}</div>
            </div>
            <button style={{border:0,background:'transparent',color:'var(--side-ink-3)',cursor:'pointer',fontSize:12}} onClick={onSignOut} title="Sign out">↪</button>
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Toast notification ───────────────────────────────────────
function Toast({ msg, onDone }) {
  useEffect(()=>{ const id=setTimeout(onDone,3000); return ()=>clearTimeout(id); },[onDone]);
  return <div className="toast">{msg}</div>;
}

// ─── Auth helpers ─────────────────────────────────────────────
function parseJWT(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}
function getStoredAuth() {
  const token = localStorage.getItem('sdc_auth_token');
  if (!token) return null;
  const payload = parseJWT(token);
  if (!payload || payload.exp * 1000 < Date.now()) {
    localStorage.removeItem('sdc_auth_token');
    return null;
  }
  return { token, ...payload };
}

// ─── Login Screen ─────────────────────────────────────────────
function LoginScreen({ onAuthReady }) {
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    // Check URL hash for token returned by backend after SSO
    const hash = window.location.hash;
    if (hash.includes('token=')) {
      const token = new URLSearchParams(hash.slice(1)).get('token');
      if (token) {
        localStorage.setItem('sdc_auth_token', token);
        window.history.replaceState(null, '', window.location.pathname);
        onAuthReady(token);
        return;
      }
    }
    if (hash.includes('error=')) {
      const errMsg = decodeURIComponent(new URLSearchParams(hash.slice(1)).get('error') || '');
      setError(errMsg || 'Sign-in failed. Please try again.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    setChecking(false);
  }, []);

  if (checking) return (
    <div className="login-screen">
      <div className="login-spinner"></div>
    </div>
  );

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="assets/sdc-logo.png" alt="SDC" className="login-logo" />
        <h1 className="login-title">Centralized Calendar</h1>
        <p className="login-sub">Sign in with your SDC Microsoft account to continue</p>
        {error && <div className="login-error">{error}</div>}
        <a href={`${API_URL}/auth/login`} className="btn-microsoft">
          <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
            <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
            <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
          </svg>
          Sign in with Microsoft
        </a>
        <p className="login-footer">SDC Automation · Internal use only</p>
      </div>
    </div>
  );
}

// ─── Admin Panel ───────────────────────────────────────────────
function AdminPanel({ authToken, onClose }) {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [tab, setTab] = useState('users');
  const [saving, setSaving] = useState(null);
  const [noBackend, setNoBackend] = useState(false);

  const ALL_CATS = ['holiday','payday','birthday','meeting','company','deadline','personal'];
  const ROLE_LABELS = { admin:'Admin', hr:'HR', manager:'Manager', employee:'Employee' };

  const headers = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    if (!authToken) { setNoBackend(true); return; }
    const safe = (data) => Array.isArray(data) ? data : [];
    fetch(`${API_URL}/api/admin/users`, { headers })
      .then(r => r.json()).then(d => setUsers(safe(d))).catch(() => setNoBackend(true));
    fetch(`${API_URL}/api/admin/roles`,  { headers })
      .then(r => r.json()).then(d => setRoles(safe(d))).catch(() => {});
  }, []);

  const updateRole = async (userId, newRole) => {
    setSaving(userId);
    await fetch(`${API_URL}/api/admin/users/${userId}/role`, {
      method: 'PUT', headers, body: JSON.stringify({ role: newRole })
    });
    setUsers(u => u.map(x => x.id === userId ? { ...x, role: newRole } : x));
    setSaving(null);
  };

  const toggleCat = async (role, cat) => {
    const r = roles.find(x => x.role === role);
    if (!r) return;
    const cats = r.categories.split(',');
    const next = cats.includes(cat) ? cats.filter(c => c !== cat) : [...cats, cat];
    await fetch(`${API_URL}/api/admin/roles/${role}`, {
      method: 'PUT', headers, body: JSON.stringify({ categories: next })
    });
    setRoles(rs => rs.map(x => x.role === role ? { ...x, categories: next.join(',') } : x));
  };

  return (
    <div className="scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(700px, calc(100vw - 32px))' }}>
        <div className="modal-head">
          <h2>Admin Panel</h2>
          <button className="iconbtn" onClick={onClose}>{Icon.x}</button>
        </div>
        <div style={{ display:'flex', borderBottom:'1px solid var(--line)', padding:'0 20px', background:'var(--bg-tint)' }}>
          {['users','roles'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding:'10px 16px', border:0, background:'transparent', fontWeight:600,
              fontSize:13, textTransform:'uppercase', letterSpacing:'0.06em',
              borderBottom: tab===t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab===t ? 'var(--accent)' : 'var(--ink-3)', cursor:'pointer'
            }}>{t==='users' ? 'Users' : 'Role Permissions'}</button>
          ))}
        </div>

        {noBackend && (
          <div style={{ margin:'16px 20px', padding:'12px 16px', background:'#FFF8E6', border:'1px solid #F5C518', borderRadius:8, fontSize:13, color:'#7A5800', display:'flex', alignItems:'center', gap:10 }}>
            <span style={{fontSize:18}}>⚠️</span>
            <div>
              <strong>Local Mode — no backend connected.</strong><br/>
              <span style={{color:'#9A7020'}}>User management requires the Node.js server running on port 3001. Set <code>LOCAL_MODE = false</code> and start the server to manage users.</span>
            </div>
          </div>
        )}
        <div className="modal-body" style={{ maxHeight: 420, overflowY:'auto' }}>
          {tab === 'users' && (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'var(--bg-tint)' }}>
                  {['Name','Email','Role','Last Login'].map(h => (
                    <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600, fontSize:11, letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--ink-3)', borderBottom:'1px solid var(--line)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderBottom:'1px solid var(--line)' }}>
                    <td style={{ padding:'8px 12px', fontWeight:500 }}>{u.name || '—'}</td>
                    <td style={{ padding:'8px 12px', color:'var(--ink-3)', fontSize:12 }}>{u.email}</td>
                    <td style={{ padding:'8px 12px' }}>
                      <select
                        value={u.role}
                        disabled={saving === u.id}
                        onChange={e => updateRole(u.id, e.target.value)}
                        style={{ fontSize:12, padding:'4px 8px', borderRadius:6, border:'1px solid var(--line-strong)', background:'var(--bg)', color:'var(--ink)' }}
                      >
                        {Object.entries(ROLE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td style={{ padding:'8px 12px', color:'var(--ink-3)', fontSize:12 }}>
                      {u.last_login ? new Date(u.last_login).toLocaleDateString() : 'Never'}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={4} style={{ padding:20, textAlign:'center', color:'var(--ink-3)' }}>No users yet — they appear after first login.</td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'roles' && (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {roles.map(r => (
                <div key={r.role} style={{ border:'1px solid var(--line)', borderRadius:8, overflow:'hidden' }}>
                  <div style={{ padding:'10px 14px', background:'var(--bg-tint)', fontWeight:700, fontSize:13, textTransform:'uppercase', letterSpacing:'0.06em', borderBottom:'1px solid var(--line)' }}>
                    {ROLE_LABELS[r.role] || r.role}
                  </div>
                  <div style={{ padding:'12px 14px', display:'flex', flexWrap:'wrap', gap:8 }}>
                    {ALL_CATS.map(cat => {
                      const active = r.categories.split(',').includes(cat);
                      const c = CATMAP[cat];
                      return (
                        <button key={cat} onClick={() => toggleCat(r.role, cat)}
                          style={{
                            padding:'5px 12px', borderRadius:999, fontSize:12, fontWeight:500, cursor:'pointer',
                            border: `1px solid ${active ? c.sw : 'var(--line-strong)'}`,
                            background: active ? c.swBg : 'var(--bg)',
                            color: active ? c.sw : 'var(--ink-3)',
                          }}>
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div className="spacer"/>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ─── Scheduler Panel — sync tasks from SDC Scheduler ─────────
function SchedulerPanel({ onClose, onSync, currentEvents }) {
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sdc_sched_projects') || '[]')); }
    catch { return new Set(); }
  });
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const lastSync = localStorage.getItem('sdc_sched_last_sync');

  useEffect(() => {
    fetch(`${API_URL}/api/scheduler/projects`)
      .then(r => r.json())
      .then(data => { setProjects(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => { setError('Cannot load projects — check that the calendar server is running.'); setLoading(false); });
  }, []);

  const toggleProject = (name) => setSelected(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    localStorage.setItem('sdc_sched_projects', JSON.stringify([...next]));
    return next;
  });
  const selectAll  = () => { const s = new Set(projects); setSelected(s); localStorage.setItem('sdc_sched_projects', JSON.stringify([...s])); };
  const selectNone = () => { setSelected(new Set()); localStorage.setItem('sdc_sched_projects', '[]'); };

  const doSync = async () => {
    if (!selected.size) return;
    setSyncing(true); setError(null);
    try {
      const params = new URLSearchParams({ projects: [...selected].join(',') });
      const res  = await fetch(`${API_URL}/api/scheduler/tasks?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onSync(data);
      localStorage.setItem('sdc_sched_last_sync', new Date().toLocaleString());
    } catch (e) { setError(e.message); }
    finally     { setSyncing(false); }
  };

  const clearAll = () => { onSync([]); localStorage.removeItem('sdc_sched_last_sync'); };

  return (
    <div className="scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(520px, calc(100vw - 32px))' }}>

        <div className="modal-head">
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:20 }}>📅</span>
            <h2 style={{ margin:0 }}>SDC Scheduler Sync</h2>
          </div>
          <button className="iconbtn" onClick={onClose}>{Icon.x}</button>
        </div>

        <div className="modal-body" style={{ padding:'20px', display:'flex', flexDirection:'column', gap:16 }}>

          {/* Connection status */}
          <div style={{ padding:'12px 16px', borderRadius:10, border:'1px solid var(--line)', background: loading ? 'var(--bg-tint)' : error ? '#FFF3F3' : '#EDF7ED', display:'flex', alignItems:'center', gap:12 }}>
            {loading ? (
              <><div className="login-spinner" style={{ width:18, height:18, borderWidth:2 }}/><span style={{ color:'var(--ink-3)', fontSize:13 }}>Loading projects…</span></>
            ) : error ? (
              <>
                <span style={{ fontSize:18 }}>❌</span>
                <div>
                  <div style={{ fontWeight:600, fontSize:13, color:'#B71C1C' }}>Not Connected</div>
                  <div style={{ fontSize:12, color:'#C62828' }}>{error}</div>
                </div>
              </>
            ) : (
              <>
                <span style={{ fontSize:18 }}>✅</span>
                <div>
                  <div style={{ fontWeight:600, fontSize:13, color:'#1A6B1A' }}>SDC Scheduler Connected</div>
                  <div style={{ fontSize:12, color:'#2E7D32' }}>{projects.length} project{projects.length !== 1 ? 's' : ''} available</div>
                </div>
              </>
            )}
          </div>

          {/* Project list */}
          {!loading && !error && (
            <div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--ink)' }}>
                  Projects <span style={{ fontWeight:400, color:'var(--ink-3)' }}>({projects.length})</span>
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  <button onClick={selectAll}  style={{ fontSize:11, padding:'3px 10px', border:'1px solid var(--line-strong)', borderRadius:6, background:'transparent', cursor:'pointer', color:'var(--ink-3)' }}>All</button>
                  <button onClick={selectNone} style={{ fontSize:11, padding:'3px 10px', border:'1px solid var(--line-strong)', borderRadius:6, background:'transparent', cursor:'pointer', color:'var(--ink-3)' }}>None</button>
                </div>
              </div>
              <div style={{ maxHeight:220, overflowY:'auto', border:'1px solid var(--line)', borderRadius:8, background:'var(--bg)' }}>
                {projects.length === 0
                  ? <div style={{ padding:20, textAlign:'center', color:'var(--ink-3)', fontSize:13 }}>No projects found. Add tasks in the SDC Scheduler app first.</div>
                  : projects.map(proj => (
                      <label key={proj} className="ss-sheet-row">
                        <input type="checkbox" checked={selected.has(proj)} onChange={() => toggleProject(proj)} style={{ accentColor:'#1574C4', width:14, height:14, flexShrink:0 }}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:500, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{proj}</div>
                        </div>
                      </label>
                    ))
                }
              </div>
              <div style={{ fontSize:11, color:'var(--ink-3)', marginTop:6 }}>
                {selected.size} project{selected.size !== 1 ? 's' : ''} selected · Tasks shown as read-only calendar events
              </div>
            </div>
          )}

          {/* Stats */}
          {currentEvents.length > 0 && (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <div style={{ padding:'8px 14px', background:'rgba(21,116,196,0.08)', borderRadius:8, fontSize:12, color:'#1574C4', fontWeight:600 }}>
                📅 {currentEvents.length} task{currentEvents.length !== 1 ? 's' : ''} loaded
              </div>
              {lastSync && <div style={{ padding:'8px 14px', background:'var(--bg-tint)', borderRadius:8, fontSize:12, color:'var(--ink-3)' }}>🕐 Last synced {lastSync}</div>}
            </div>
          )}

          {error && (
            <div style={{ padding:'10px 14px', background:'#FFF0F0', border:'1px solid #FFB3B3', borderRadius:8, fontSize:13, color:'#CC0000' }}>⚠️ {error}</div>
          )}
        </div>

        <div className="modal-foot">
          {currentEvents.length > 0 && (
            <button className="btn" onClick={clearAll} style={{ color:'#CC3333', borderColor:'#CC3333' }}>🗑 Clear Tasks</button>
          )}
          <div className="spacer"/>
          <button className="btn" onClick={onClose}>Close</button>
          {!error && !loading && (
            <button className="btn primary" onClick={doSync} disabled={syncing || selected.size === 0} style={{ display:'flex', alignItems:'center', gap:6, opacity: selected.size === 0 ? 0.5 : 1 }}>
              {syncing ? <><div className="login-spinner" style={{ width:14, height:14, borderWidth:2, borderTopColor:'#fff', borderColor:'rgba(255,255,255,0.3)' }}/> Syncing…</> : '🔄 Sync Now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Error Boundary ───────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[SDC Calendar Error]', error, info.componentStack); }
  render() {
    if (this.state.error) return (
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',gap:16,padding:32,textAlign:'center'}}>
        <div style={{fontSize:48}}>⚠️</div>
        <h2 style={{margin:0,fontSize:20,color:'var(--ink)'}}>Something went wrong</h2>
        <p style={{color:'var(--ink-3)',maxWidth:440,lineHeight:1.5,margin:0}}>{this.state.error.message}</p>
        <button className="btn primary" onClick={()=>{ this.setState({error:null}); window.location.reload(); }}>Reload Calendar</button>
      </div>
    );
    return this.props.children;
  }
}

// ─── App ──────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent":"#1574C4","theme":"light","weekStart":1,"density":"normal","showWeekends":true,"sidebarWidth":300,"timezone":"","showWeekNumbers":false
}/*EDITMODE-END*/;

// ─── AppShell — handles auth, shows login or calendar ─────────
function App() {
  // All hooks declared unconditionally — rules of hooks compliance
  const [resolvedUser,  setResolvedUser]  = useState(LOCAL_USER);
  const [authToken,     setAuthToken]     = useState(() => LOCAL_MODE ? null : (getStoredAuth()?.token || null));
  const [authUser,      setAuthUser]      = useState(null);
  const [authLoading,   setAuthLoading]   = useState(!LOCAL_MODE && !!(getStoredAuth()?.token));
  const [allowedCats,   setAllowedCats]   = useState(null);

  // Resolve real SSO user from shell when in LOCAL_MODE
  useEffect(() => {
    if (!LOCAL_MODE) return;
    if (window.electronAPI?.authGetStatus) {
      window.electronAPI.authGetStatus().then(status => {
        if (status?.isAuthenticated && status.user) {
          setResolvedUser(u => ({ ...u, name: status.user.name || u.name, email: status.user.email || u.email }));
        }
      }).catch(() => {});
    }
    // Same fix as src/App.jsx (2026-08-20): the shell's IPC only carries
    // name/email, never a role — the real role/allowedCategories come from
    // this app's own backend, resolved from the sdc_session cookie the
    // shell set (server/middleware/requireAuth.js). Falls back to the
    // LOCAL_USER admin defaults already in state on any failure, same as
    // before this fix.
    fetch(`${API_URL}/auth/me`, { credentials: 'include', signal: AbortSignal.timeout(8000) })
      .then(r => { if (!r.ok) throw new Error('unauth'); return r.json(); })
      .then(data => {
        setResolvedUser(u => ({ ...u, role: data.role, allowedCategories: data.allowedCategories }));
        setAllowedCats(new Set(data.allowedCategories));
      })
      .catch(() => {});
  }, []);

  // Verify JWT token when not in LOCAL_MODE
  useEffect(() => {
    if (LOCAL_MODE || !authToken) { setAuthLoading(false); return; }
    fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(8000) })
      .then(r => { if (!r.ok) throw new Error('unauth'); return r.json(); })
      .then(data => { setAuthUser(data); setAllowedCats(new Set(data.allowedCategories)); setAuthLoading(false); })
      .catch(() => { localStorage.removeItem('sdc_auth_token'); setAuthToken(null); setAuthLoading(false); });
  }, [authToken]);

  const handleAuthReady = (token) => { localStorage.setItem('sdc_auth_token', token); setAuthToken(token); };
  const handleSignOut   = () => { localStorage.removeItem('sdc_auth_token'); setAuthToken(null); setAuthUser(null); setAllowedCats(null); };

  if (LOCAL_MODE) {
    return <CalendarApp authToken={null} authUser={resolvedUser} allowedCats={allowedCats || new Set(LOCAL_USER.allowedCategories)} onSignOut={()=>{ window.location.reload(); }} />;
  }
  if (!authToken)  return <LoginScreen onAuthReady={handleAuthReady} />;
  if (authLoading) return <div className="login-screen"><div className="login-spinner"></div></div>;
  return <CalendarApp authToken={authToken} authUser={authUser} allowedCats={allowedCats} onSignOut={handleSignOut} />;
}

// ─── CalendarApp — full calendar UI ───────────────────────────
function CalendarApp({ authToken, authUser, allowedCats, onSignOut }) {
  const [serverOnline, setServerOnline] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);
  const [schedOpen,        setSchedOpen]        = useState(false);
  const [schedulerEvents,  setSchedulerEvents]  = useState(() => { try { return JSON.parse(localStorage.getItem('sdc_scheduler_events') || '[]'); } catch { return []; } });
  const [viewDate, setViewDate]=useState(()=>{ const s=localStorage.getItem('sdc_view_date'); return s?new Date(s):new Date(); });
  const [viewMode, setViewMode]=useState('month'); // month | week | day
  const [userEvents, setUserEventsRaw]=useState(()=>loadUserEvents());
  const [undoStack, setUndoStack]=useState([]);
  const [redoStack, setRedoStack]=useState([]);
  const [activeCats, setActiveCats]=useState(()=>new Set(CATEGORIES.map(c=>c.id)));
  const [search, setSearch]=useState('');
  const [modal, setModal]=useState(null);
  const [dayModal, setDayModal]=useState(null);
  const [tweaksOpen, setTweaksOpen]=useState(false);
  const [empModal, setEmpModal]=useState(false);
  const [importExportModal, setImportExportModal]=useState(false);
  const [toast, setToast]=useState(null);
  const [employeesVer, setEmployeesVer]=useState(0);
  const notifiedRef=useRef(new Set());
  // New state for features
  const [hoverCard, setHoverCard]=useState(null);
  const [jumpOpen, setJumpOpen]=useState(false);
  const [shortcutsOpen, setShortcutsOpen]=useState(false);
  const [myEventsOnly, setMyEventsOnly]=useState(false);
  const [appVersion, setAppVersion]=useState(APP_VERSION);
  useEffect(()=>{ if(window.electronAPI?.getVersion) window.electronAPI.getVersion().then(v=>{ if(v) setAppVersion(v); }); },[]);
  const [contextMenu, setContextMenu]=useState(null);
  const [deleteConfirm, setDeleteConfirm]=useState(null); // {id, title}
  const [userMenuOpen, setUserMenuOpen]=useState(false);
  const userMenuRef=useRef(null);
  const hoverTimerRef=useRef(null);

  useEffect(() => {
    if (LOCAL_MODE) return;
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    fetch(`${API_URL}/api/events`, { headers, signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          const mapped = data.map(e => ({
            ...e,
            date: new Date(e.date + 'T00:00:00'),
            endDate: e.endDate ? new Date(e.endDate + 'T00:00:00') : null
          }));
          setUserEventsRaw(mapped);
        }
      }).catch(console.error);
  }, [authToken]);

  const savedPrefs=loadPrefs();
  const [prefs, setPrefs]=useState({...TWEAK_DEFAULTS,...savedPrefs});

  // Undo-aware setter
  const setUserEvents=useCallback((newEvents, skipHistory=false)=>{
    if(!skipHistory) {
      setUndoStack(prev=>[...prev.slice(-19), userEvents]);
      setRedoStack([]);
    }
    setUserEventsRaw(newEvents);
  },[userEvents]);

  const undo=useCallback(()=>{
    setUndoStack(prev=>{ if(prev.length===0) return prev; const top=prev[prev.length-1]; setRedoStack(r=>[userEvents,...r.slice(0,19)]); setUserEventsRaw(top); return prev.slice(0,-1); });
  },[userEvents]);
  const redo=useCallback(()=>{
    setRedoStack(prev=>{ if(prev.length===0) return prev; const top=prev[0]; setUndoStack(s=>[...s.slice(-19),userEvents]); setUserEventsRaw(top); return prev.slice(1); });
  },[userEvents]);

  // Feature 2: Hover card helpers
  // FIX: capture rect synchronously — React nullifies e.currentTarget after
  // the handler returns, so calling getBoundingClientRect inside setTimeout
  // always throws "Cannot read properties of null".
  const showHover=useCallback((ev, domEvent)=>{
    clearTimeout(hoverTimerRef.current);
    let rect;
    try { rect = domEvent.currentTarget ? domEvent.currentTarget.getBoundingClientRect() : null; } catch(e) { return; }
    if(!rect) return;
    hoverTimerRef.current=setTimeout(()=>{ setHoverCard({event:ev, rect}); }, 400);
  },[]);
  const hideHover=useCallback(()=>{
    clearTimeout(hoverTimerRef.current);
    setHoverCard(null);
  },[]);

  // Persist
  useEffect(()=>{ savePrefs(prefs); },[prefs]);
  useEffect(()=>{ localStorage.setItem('sdc_view_date',viewDate.toISOString()); },[viewDate]);
  useEffect(()=>{ if(!saveUserEvents(userEvents)) setToast('⚠️ Events not saved — browser storage may be full'); },[userEvents]);
  useEffect(()=>{ localStorage.setItem('sdc_scheduler_events', JSON.stringify(schedulerEvents)); },[schedulerEvents]);

  // Server health check — poll every 30s, show banner when offline
  useEffect(()=>{
    if(LOCAL_MODE) return;
    const check=()=>{
      fetch(`${API_URL}/api/health`,{signal:AbortSignal.timeout(5000)})
        .then(()=>setServerOnline(true))
        .catch(()=>setServerOnline(false));
    };
    check();
    const id=setInterval(check,30000);
    return ()=>clearInterval(id);
  },[]);

  // Close user menu on outside click
  useEffect(()=>{
    if(!userMenuOpen) return;
    const handler=(e)=>{ if(userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return ()=>document.removeEventListener('mousedown', handler);
  },[userMenuOpen]);

  // Theme + accent
  useEffect(()=>{
    document.documentElement.setAttribute('data-theme',prefs.theme||'light');
    const acc=ACCENT_SWATCHES.find(s=>s.value===prefs.accent)||ACCENT_SWATCHES[0];
    document.documentElement.style.setProperty('--accent',acc.value);
    document.documentElement.style.setProperty('--accent-ink',acc.ink);
    document.documentElement.style.setProperty('--accent-soft',acc.soft);
  },[prefs.theme,prefs.accent]);

  // Edit-mode protocol
  useEffect(()=>{
    const h=(e)=>{ const d=e.data||{}; if(d.type==='__activate_edit_mode') setTweaksOpen(true); if(d.type==='__deactivate_edit_mode') setTweaksOpen(false); };
    window.addEventListener('message',h);
    try { window.parent.postMessage({type:'__edit_mode_available'},'*'); } catch {}
    return ()=>window.removeEventListener('message',h);
  },[]);

  // Seeded events
  const seeded=useMemo(()=>{
    const year=viewDate.getFullYear();
    const emps=loadEmployees()||window.SDC_DATA.DEFAULT_EMPLOYEES;
    return window.SDC_DATA.seedAllEvents([year-1,year,year+1],emps);
  },[viewDate.getFullYear(), employeesVer]);

  // Expand recurring user events + scheduler tasks from SDC Scheduler
  const allEvents=useMemo(()=>{
    const rs=new Date(viewDate.getFullYear()-1,0,1);
    const re=new Date(viewDate.getFullYear()+2,11,31);
    const expandedUser=expandAll(userEvents,rs,re);
    // Scheduler events: normalize date strings → Date objects.
    // endDate is intentionally set to null — tasks often span months and would
    // render as stacked full-width banners across every row. Show as chips on
    // start date only; full date range is visible in the event detail panel.
    const schedulerVisible=schedulerEvents
      .filter(e=>{ const d=new Date(e.date); return d>=rs && d<=re; })
      .map(e=>({
        ...e,
        date:    new Date(e.date),
        endDate: null,
      }));
    if(myEventsOnly) return [...expandedUser.filter(e=>!e.seeded), ...schedulerVisible];
    return [...seeded,...expandedUser,...schedulerVisible];
  },[seeded,userEvents,schedulerEvents,viewDate.getFullYear(),myEventsOnly]);

  // Browser notification polling
  useEffect(()=>{
    if(!('Notification' in window)) return;
    const check=()=>{
      if(Notification.permission!=='granted') return;
      const now=new Date();
      allEvents.forEach(ev=>{
        if(!ev.notify||ev.seeded) return;
        const evDate=new Date(ev.date);
        if(ev.time){ const[h,m]=ev.time.split(':').map(Number); evDate.setHours(h,m,0,0); }
        const triggerMs=evDate.getTime()-Number(ev.notify)*60000;
        const key=`${ev.id}-${ev.notify}`;
        if(!notifiedRef.current.has(key) && Math.abs(now.getTime()-triggerMs)<65000) {
          notifiedRef.current.add(key);
          try {
            const notifTitle = `📅 ${ev.title}`;
            const notifBody  = `In ${ev.notify} min${ev.location ? ' — ' + ev.location : ''}`;
            if (window.electronAPI?.showNotification) {
              window.electronAPI.showNotification({ source: 'calendar', type: 'reminder', title: notifTitle, body: notifBody, icon: '📅' });
            } else if ('Notification' in window && Notification.permission === 'granted') {
              new Notification(notifTitle, { body: notifBody, icon: 'assets/sdc-logo.png' });
            }
          } catch {}
        }
      });
    };
    check();
    const id=setInterval(check,60000);
    return ()=>clearInterval(id);
  },[allEvents]);

  // Request notification permission on first interaction
  const requestNotifPermission=()=>{
    if('Notification' in window && Notification.permission==='default') {
      Notification.requestPermission().then(p=>{ if(p==='granted') setToast('Notifications enabled!'); });
    }
  };

  // Feature 14+5: Enhanced keyboard shortcuts
  useEffect(()=>{
    const h=(e)=>{
      if(e.target.matches('input,textarea,select')) return;
      if(e.ctrlKey||e.metaKey) {
        if(e.key==='z'&&!e.shiftKey){ e.preventDefault(); undo(); return; }
        if((e.key==='y')||(e.key==='z'&&e.shiftKey)){ e.preventDefault(); redo(); return; }
      }
      if(e.key==='Escape'){ setModal(null); setDayModal(null); setShortcutsOpen(false); setJumpOpen(false); setContextMenu(null); return; }
      if(e.key==='?'){ setShortcutsOpen(true); return; }
      if(e.key==='ArrowLeft')  setViewDate(d=>viewMode==='day'?addDays(d,-1):viewMode==='week'?addDays(d,-7):addMonths(d,-1));
      else if(e.key==='ArrowRight') setViewDate(d=>viewMode==='day'?addDays(d,1):viewMode==='week'?addDays(d,7):addMonths(d,1));
      else if(e.key.toLowerCase()==='t') setViewDate(new Date());
      else if(e.key.toLowerCase()==='n'&&!modal) setModal({mode:'new',date:viewDate});
      else if(e.key.toLowerCase()==='m') setViewMode('month');
      else if(e.key.toLowerCase()==='w') setViewMode('week');
      else if(e.key.toLowerCase()==='d') { setViewMode('day'); setViewDate(new Date()); }
      else if(e.key==='1') setViewMode('month');
      else if(e.key==='2') setViewMode('week');
      else if(e.key==='3') { setViewMode('day'); setViewDate(new Date()); }
    };
    window.addEventListener('keydown',h);
    return ()=>window.removeEventListener('keydown',h);
  },[modal,viewDate,viewMode,undo,redo]);

  const handleSave=async (ev)=>{
    if (LOCAL_MODE) {
      setUserEvents(prev=>{ const i=prev.findIndex(x=>x.id===ev.id); if(i>=0){ const c=[...prev]; c[i]=ev; return c; } return [...prev,ev]; });
      setModal(null);
      requestNotifPermission();
      return;
    }
    const isNew = !userEvents.some(x => x.id === ev.id);
    const url = isNew ? `${API_URL}/api/events` : `${API_URL}/api/events/${ev.id}`;
    const method = isNew ? 'POST' : 'PUT';
    try {
      await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          ...ev,
          date: ev.date.toISOString().split('T')[0],
          endDate: ev.endDate ? ev.endDate.toISOString().split('T')[0] : null
        })
      });
      const r = await fetch(`${API_URL}/api/events`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      if (Array.isArray(data)) {
        setUserEventsRaw(data.map(e => ({ ...e, date: new Date(e.date + 'T00:00:00'), endDate: e.endDate ? new Date(e.endDate + 'T00:00:00') : null })));
      }
      setModal(null);
      requestNotifPermission();
    } catch (e) {
      setToast('Failed to save event to server.');
    }
  };

  const handleDelete=async (id)=>{
    if (LOCAL_MODE) {
      setUserEvents(prev=>prev.filter(x=>x.id!==id));
      setModal(null);
      return;
    }
    try {
      await fetch(`${API_URL}/api/events/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      setUserEventsRaw(prev => prev.filter(x => x.id !== id));
      setModal(null);
    } catch (e) {
      setToast('Failed to delete event.');
    }
  };
  const handleDrop=(evId, newDate)=>{
    setUserEvents(prev=>prev.map(ev=>{ if(ev.id!==evId) return ev; const nd=new Date(newDate); if(ev.endDate){ const dur=ev.endDate-ev.date; return {...ev,date:nd,endDate:new Date(nd.getTime()+dur)}; } return {...ev,date:nd}; }));
    setToast('Event moved');
  };
  const handleImport = async (events) => {
    if (LOCAL_MODE) {
      setUserEvents(prev=>[
        ...prev.filter(ev=>!String(ev.id).includes('paylocity')),
        ...events
      ]);
      setToast(`${events.length} events imported (local)`);
      return;
    }

    try {
      setToast(`Saving ${events.length} events to database...`);
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
      
      // 1. Fetch all current events from backend
      const r = await fetch(`${API_URL}/api/events`, { headers });
      const current = await r.json();
      
      // 2. Delete old Paylocity records sequentially
      if (Array.isArray(current)) {
        const toDelete = current.filter(ev => String(ev.id).includes('paylocity'));
        for (const ev of toDelete) {
          await fetch(`${API_URL}/api/events/${ev.id}`, { method: 'DELETE', headers });
        }
      }
      
      // 3. POST new events
      for (const ev of events) {
        await fetch(`${API_URL}/api/events`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...ev,
            date: ev.date instanceof Date ? ev.date.toISOString().split('T')[0] : String(ev.date),
            endDate: ev.endDate ? (ev.endDate instanceof Date ? ev.endDate.toISOString().split('T')[0] : String(ev.endDate)) : null
          })
        });
      }
      
      // 4. Reload userEvents state from backend
      const r2 = await fetch(`${API_URL}/api/events`, { headers });
      const finalData = await r2.json();
      if (Array.isArray(finalData)) {
        setUserEventsRaw(finalData.map(e => ({ ...e, date: new Date(e.date + 'T00:00:00'), endDate: e.endDate ? new Date(e.endDate + 'T00:00:00') : null })));
      }
      
      setToast(`${events.length} events saved to shared database!`);
    } catch (err) {
      setToast('Failed to save events to database.');
    }
  };

  const handleClearPaylocity = async () => {
    if (LOCAL_MODE) {
      setUserEvents(prev=>prev.filter(ev=>!String(ev.id).includes('paylocity')));
      setToast(`Paylocity records cleared (local)`);
      return;
    }
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const r = await fetch(`${API_URL}/api/events`, { headers });
      const current = await r.json();
      
      if (Array.isArray(current)) {
        const toDelete = current.filter(ev => String(ev.id).includes('paylocity'));
        for (const ev of toDelete) {
          await fetch(`${API_URL}/api/events/${ev.id}`, { method: 'DELETE', headers });
        }
      }
      
      const r2 = await fetch(`${API_URL}/api/events`, { headers });
      const finalData = await r2.json();
      if (Array.isArray(finalData)) {
        setUserEventsRaw(finalData.map(e => ({ ...e, date: new Date(e.date + 'T00:00:00'), endDate: e.endDate ? new Date(e.endDate + 'T00:00:00') : null })));
      }
      setToast('Paylocity records removed from shared database.');
    } catch (err) {
      setToast('Failed to clear records from server.');
    }
  };

  const handleSaveEmployees=(emps)=>{ saveEmployees(emps); setEmployeesVer(v=>v+1); setEmpModal(false); setToast('Directory saved'); };

  // Feature 13+16: Pin toggle
  const handleTogglePin=(ev)=>{
    setUserEvents(userEvents.map(e=>e.id===ev.id?{...e,pinned:!e.pinned}:e));
  };

  // Feature 25: Drag-drop in time grid
  const handleDropWithTime=(evId, day, newTime)=>{
    setUserEvents(userEvents.map(ev=>{
      if(ev.id!==evId) return ev;
      const nd=new Date(day); if(ev.endDate){ const dur=ev.endDate-ev.date; return {...ev,date:nd,time:newTime,endDate:new Date(nd.getTime()+dur)}; }
      return {...ev,date:nd,time:newTime};
    }));
    setToast('Event moved');
  };

  // Feature 17: Touch swipe gestures
  useEffect(()=>{
    let startX=0, startY=0;
    const onStart=(e)=>{ startX=e.touches[0].clientX; startY=e.touches[0].clientY; };
    const onEnd=(e)=>{
      const dx=e.changedTouches[0].clientX-startX;
      const dy=e.changedTouches[0].clientY-startY;
      if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5){
        if(dx<0) setViewDate(d=>viewMode==='day'?addDays(d,1):viewMode==='week'?addDays(d,7):addMonths(d,1));
        else setViewDate(d=>viewMode==='day'?addDays(d,-1):viewMode==='week'?addDays(d,-7):addMonths(d,-1));
      }
    };
    document.addEventListener('touchstart',onStart,{passive:true});
    document.addEventListener('touchend',onEnd,{passive:true});
    return ()=>{ document.removeEventListener('touchstart',onStart); document.removeEventListener('touchend',onEnd); };
  },[viewDate,viewMode]);

  // Nav title for topbar
  const navTitle=()=>{
    if(viewMode==='month') return `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
    if(viewMode==='week') {
      const ws=startOfWeek(viewDate,prefs.weekStart);
      const we=addDays(ws,6);
      return ws.getMonth()===we.getMonth() ? `${MONTHS[ws.getMonth()]} ${ws.getFullYear()}` : `${MONTHS_SHORT[ws.getMonth()]} – ${MONTHS_SHORT[we.getMonth()]} ${we.getFullYear()}`;
    }
    return fmtDateLong(viewDate);
  };

  const tz=prefs.timezone||null;

  return (
    <div className={`app density-${prefs.density} ${prefs.showWeekends?'':'weekend-hidden'}`} style={{gridTemplateColumns:`${prefs.sidebarWidth||300}px 6px 1fr`}}>
      <Sidebar
        viewDate={viewDate} setViewDate={setViewDate} allEvents={allEvents}
        activeCats={activeCats} setActiveCats={setActiveCats}
        search={search} setSearch={setSearch}
        prefs={prefs} setPrefs={setPrefs}
        onNewEvent={()=>setModal({mode:'new',date:viewDate})}
        onOpenEvent={(ev)=>setModal({mode:'edit',event:ev})}
        weekStart={prefs.weekStart}
        onOpenDirectory={()=>setEmpModal(true)}
        onOpenImportExport={()=>setImportExportModal(true)}
        onUndo={undo} onRedo={redo}
        canUndo={undoStack.length>0} canRedo={redoStack.length>0}
        myEventsOnly={myEventsOnly} setMyEventsOnly={setMyEventsOnly}
        authUser={authUser} onSignOut={onSignOut}
        appVersion={appVersion}
      />
      <Resizer width={prefs.sidebarWidth||300} onChange={w=>setPrefs(p=>({...p,sidebarWidth:w}))}/>
      <div className="main">
        {/* Server offline banner */}
        {!LOCAL_MODE&&!serverOnline&&(
          <div style={{background:'#FFF3CD',borderBottom:'1px solid #FFC107',padding:'7px 16px',display:'flex',alignItems:'center',gap:8,fontSize:13,color:'#856404',flexShrink:0,zIndex:10}}>
            <span>⚠️</span>
            <span><strong>Server offline</strong> — changes may not save. Check that the Node.js server is running on port 3001.</span>
          </div>
        )}
        {/* Feature 4: Jump-to-date topbar */}
        <div className="topbar" style={{position:'relative'}}>
          <div className="month-title" style={{cursor:'pointer',userSelect:'none'}} onClick={()=>setJumpOpen(j=>!j)} title="Click to jump to date">
            <span>{viewMode==='month'?MONTHS[viewDate.getMonth()]:viewMode==='day'?MONTHS_SHORT[viewDate.getMonth()]:''}</span>
            {viewMode==='month'&&<span className="yr">{viewDate.getFullYear()}</span>}
            {viewMode==='week'&&<span style={{fontSize:18,color:'var(--ink-3)'}}>{navTitle()}</span>}
            {viewMode==='day'&&<span style={{fontSize:18,color:'var(--ink-3)'}}>{fmtDateLong(viewDate)}</span>}
            <span style={{fontSize:14,color:'var(--accent)',marginLeft:6,opacity:0.7}}>▾</span>
          </div>
          {jumpOpen&&(
            <div style={{position:'absolute',top:'100%',left:24,zIndex:60,background:'var(--bg-elev)',border:'1px solid var(--line)',borderRadius:8,boxShadow:'var(--shadow-md)',padding:12}}>
              <input type="month" className="input" style={{width:180}}
                defaultValue={`${viewDate.getFullYear()}-${String(viewDate.getMonth()+1).padStart(2,'0')}`}
                onChange={e=>{ const [y,m]=e.target.value.split('-'); setViewDate(new Date(+y,+m-1,1)); setJumpOpen(false); }}
              />
              <div style={{fontSize:11,color:'var(--ink-3)',marginTop:6,textAlign:'center'}}>or press T for today</div>
            </div>
          )}
          <div className="view-switcher">
            <button className={viewMode==='month'?'active':''} onClick={()=>setViewMode('month')} title="Month (M)">Month</button>
            <button className={viewMode==='week'?'active':''} onClick={()=>setViewMode('week')} title="Week (W)">Week</button>
            <button className={viewMode==='day'?'active':''} onClick={()=>{ setViewMode('day'); setViewDate(new Date()); }} title="Day (D)">Day</button>
          </div>
          <button className="today-btn" onClick={()=>setViewDate(new Date())}>Today</button>
          <div className="nav-btns">
            <button className="iconbtn" onClick={()=>setViewDate(d=>viewMode==='day'?addDays(d,-1):viewMode==='week'?addDays(d,-7):addMonths(d,-1))} aria-label="Previous">{Icon.chev('left')}</button>
            <button className="iconbtn" onClick={()=>setViewDate(d=>viewMode==='day'?addDays(d,1):viewMode==='week'?addDays(d,7):addMonths(d,1))} aria-label="Next">{Icon.chev('right')}</button>
          </div>
          {/* Feature 5: Keyboard shortcuts button */}
          <button className="iconbtn" onClick={()=>setShortcutsOpen(true)} title="Keyboard shortcuts (?)">?</button>
          <button className="iconbtn" onClick={()=>setTweaksOpen(t=>!t)} title="Settings">{Icon.settings}</button>
          <button className="iconbtn ss-topbar-btn" onClick={()=>setSchedOpen(true)} title="SDC Scheduler Sync">
            <span style={{fontSize:16,lineHeight:1}}>📅</span>
            {schedulerEvents.length > 0 && <span className="ss-topbar-badge">{schedulerEvents.length}</span>}
          </button>
          {authUser && (
            <div className="user-badge" ref={userMenuRef}>
              <div style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',padding:'4px 6px',borderRadius:8,transition:'background .15s'}} onClick={()=>setUserMenuOpen(o=>!o)}>
                <div className="user-avatar">{authUser.name?.[0]?.toUpperCase() || '?'}</div>
                <div className="user-info">
                  <div className="user-name">{authUser.name}</div>
                  <div className="user-role">{authUser.role}</div>
                </div>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{color:'var(--ink-3)',transform:userMenuOpen?'rotate(180deg)':'',transition:'transform .2s',flexShrink:0}}><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              <div className={`user-menu${userMenuOpen?' open':''}`}>
                {authUser.role === 'admin' && (
                  <button onClick={()=>{ setAdminOpen(true); setUserMenuOpen(false); }}>Admin Panel</button>
                )}
<button onClick={()=>{ onSignOut(); setUserMenuOpen(false); }}>Sign Out</button>
              </div>
            </div>
          )}
        </div>
        {/* Feature 10: Month Summary Bar */}
        {viewMode==='month'&&<MonthSummaryBar viewDate={viewDate} allEvents={allEvents} activeCats={activeCats} setActiveCats={setActiveCats}/>}
        <div className="grid-wrap">
          {viewMode==='month'&&(
            <MonthGrid
              viewDate={viewDate} events={allEvents} activeCats={activeCats} search={search}
              weekStart={prefs.weekStart} showWeekends={prefs.showWeekends} density={prefs.density}
              onOpenEvent={(ev)=>setModal({mode:'edit',event:ev})}
              onNewEventOnDate={(d)=>setModal({mode:'new',date:d})}
              onSeeMore={(d,list)=>setDayModal({date:d,events:list})}
              onDropOnDate={handleDrop}
              timezone={tz}
              onHover={showHover} onHoverEnd={hideHover}
              onContextMenu={(ev,x,y)=>setContextMenu({event:ev,x,y})}
              showWeekNumbers={prefs.showWeekNumbers}
            />
          )}
          {viewMode==='week'&&(
            <WeekView
              viewDate={viewDate} events={allEvents} activeCats={activeCats} search={search}
              weekStart={prefs.weekStart} showWeekends={prefs.showWeekends}
              onOpenEvent={(ev)=>setModal({mode:'edit',event:ev})}
              onNewEventOnDate={(d)=>setModal({mode:'new',date:d})}
              timezone={tz}
              onHover={showHover} onHoverEnd={hideHover}
              onDropWithTime={handleDropWithTime}
            />
          )}
          {viewMode==='day'&&(
            <DayView
              viewDate={viewDate} events={allEvents} activeCats={activeCats} search={search}
              onOpenEvent={(ev)=>setModal({mode:'edit',event:ev})}
              onNewEventOnDate={(d)=>setModal({mode:'new',date:d})}
              timezone={tz}
              onHover={showHover} onHoverEnd={hideHover}
              onDropWithTime={handleDropWithTime}
            />
          )}
        </div>
      </div>

      {/* Feature 18: Mobile Bottom Nav */}
      <div className="mobile-bottom-nav">
        <button className={viewMode==='month'?'active':''} onClick={()=>setViewMode('month')}>📅<span>Month</span></button>
        <button className={viewMode==='week'?'active':''} onClick={()=>setViewMode('week')}>📆<span>Week</span></button>
        <button onClick={()=>setModal({mode:'new',date:new Date()})}>➕<span>New</span></button>
        <button onClick={()=>setEmpModal(true)}>👥<span>People</span></button>
        <button onClick={()=>setTweaksOpen(true)}>⚙️<span>Settings</span></button>
      </div>

      {modal&&<EventModal mode={modal.mode} event={modal.event} date={modal.date} allEvents={allEvents} onClose={()=>setModal(null)} onSave={handleSave} onDelete={handleDelete} timezone={tz}/>}
      {dayModal&&<DayModal date={dayModal.date} events={dayModal.events} onClose={()=>setDayModal(null)} onOpenEvent={(ev)=>setModal({mode:'edit',event:ev})} onNewOnDate={(d)=>setModal({mode:'new',date:d})}/>}
      {empModal&&<EmployeeModal employees={loadEmployees()||window.SDC_DATA.DEFAULT_EMPLOYEES} onSave={handleSaveEmployees} onClose={()=>setEmpModal(false)}/>}
      {importExportModal&&<ImportExportModal allEvents={allEvents} userEvents={userEvents} onImport={handleImport} onClearPaylocity={handleClearPaylocity} onClose={()=>setImportExportModal(false)}/>}
      <TweaksPanel open={tweaksOpen} onClose={()=>setTweaksOpen(false)} prefs={prefs} setPrefs={setPrefs}/>
      {adminOpen && <AdminPanel authToken={authToken} onClose={()=>setAdminOpen(false)}/>}
      {schedOpen && <SchedulerPanel onClose={()=>setSchedOpen(false)} onSync={setSchedulerEvents} currentEvents={schedulerEvents}/>}
      {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}
      {/* Feature 2: Hover Card */}
      {hoverCard&&<HoverCard event={hoverCard.event} anchorRect={hoverCard.rect}/>}
      {/* Feature 5: Keyboard Shortcuts */}
      {shortcutsOpen&&<KeyboardShortcuts onClose={()=>setShortcutsOpen(false)}/>}
      {/* Feature 16: Context Menu */}
      {contextMenu&&<ContextMenu x={contextMenu.x} y={contextMenu.y} event={contextMenu.event}
        onEdit={()=>{ setModal({mode:'edit',event:contextMenu.event}); setContextMenu(null); }}
        onDelete={()=>{ setDeleteConfirm({id:contextMenu.event.id,title:contextMenu.event.title}); setContextMenu(null); }}
        onPin={()=>{ handleTogglePin(contextMenu.event); setContextMenu(null); }}
        onClose={()=>setContextMenu(null)}/>}
      {deleteConfirm&&<DeleteConfirmModal title={deleteConfirm.title} onConfirm={()=>{ handleDelete(deleteConfirm.id); setDeleteConfirm(null); }} onCancel={()=>setDeleteConfirm(null)}/>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App/></ErrorBoundary>);
