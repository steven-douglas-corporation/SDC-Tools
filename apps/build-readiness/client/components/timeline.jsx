import React, { useState, useMemo, useRef, useEffect } from 'react';
import { VendorAvatar } from './primitives.jsx';

// ── PO classification relative to build start ──────────────────────────
const CLS = {
  red:        { color: '#dc2626', bg: 'rgba(220,38,38,0.08)',  label: 'Missing',   sub: 'Past due, nothing received', rank: 3 },
  yellow:     { color: '#ca8a04', bg: 'rgba(202,138,4,0.08)',  label: 'Partial',   sub: 'Some parts received',        rank: 2 },
  lightGreen: { color: '#4ade80', bg: 'rgba(74,222,128,0.06)', label: 'On Track',  sub: 'Not due yet',                rank: 1 },
  green:      { color: '#16a34a', bg: 'rgba(22,163,74,0.06)',  label: 'Received',  sub: 'All parts received',         rank: 0 },
};

function poReceiptClass(po, today) {
  const parts = (po.parts || []).filter(p => (p.qty || 0) > 0);
  if (parts.length === 0) return 'green';
  const allRcvd = parts.every(p => (p.received || 0) >= p.qty);
  if (allRcvd) return 'green';
  const anyRcvd = parts.some(p => (p.received || 0) > 0);
  if (anyRcvd) return 'yellow';
  // nothing received — check due date
  if (po.dueDate && new Date(po.dueDate) < today) return 'red';
  return 'lightGreen';
}

function useTimelineDrag(scrollRef) {
  const dragging = useRef(false);
  const startX   = useRef(0);
  const startScroll = useRef(0);
  const moved    = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging.current   = true;
      moved.current      = false;
      startX.current     = e.clientX;
      startScroll.current = el.scrollLeft;
      el.style.cursor    = 'grabbing';
      el.style.userSelect = 'none';
    };
    const onMove = (e) => {
      if (!dragging.current) return;
      const dx = e.clientX - startX.current;
      if (Math.abs(dx) > 3) moved.current = true;
      el.scrollLeft = startScroll.current - dx;
    };
    const onUp = () => {
      dragging.current = false;
      el.style.cursor  = 'grab';
      el.style.userSelect = '';
    };

    el.style.cursor = 'grab';
    el.addEventListener('mousedown',  onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      el.removeEventListener('mousedown',  onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [scrollRef]);

  // returns true if mouse was dragged (suppress click on child elements)
  return moved;
}

// ── Timeline side drawer — shown when a PO diamond is clicked ─────────────
function TimelineDrawer({ marker, buildStart, onClose, onDrillDown }) {
  const today   = new Date();
  const fmt     = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  const fmtFull = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const bsDays  = Math.round((+buildStart - +marker.date) / 86400000);

  const COL = '1fr 30px 62px 62px 86px 54px';

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 300 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 580, background: '#fff', borderLeft: '1px solid #e5e7eb', boxShadow: '-4px 0 20px rgba(0,0,0,0.08)', zIndex: 301, display: 'flex', flexDirection: 'column', animation: 'slideInRight 0.2s ease-out' }}>

        {/* Header */}
        <div style={{ padding: '18px 24px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#111', letterSpacing: '-0.01em' }}>{fmtFull(marker.date)}</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>
              {marker.items.length} PO{marker.items.length !== 1 ? 's' : ''}
              {' · '}
              {bsDays > 0 ? `${bsDays}d before build` : bsDays === 0 ? 'build starts today' : `${Math.abs(bsDays)}d past build`}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 18, lineHeight: 1, padding: '2px 4px' }}>✕</button>
        </div>

        {/* PO list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {marker.items.map((entry, ei) => {
            const po      = entry.po;
            const parts   = po?.parts || [];
            const poCls   = poReceiptClass(po, today);
            const isRcvd  = poCls === 'green';
            const isOver  = poCls === 'red';
            const isWarn  = poCls === 'yellow';
            const stColor = isRcvd ? '#16a34a' : isOver ? '#dc2626' : isWarn ? '#ca8a04' : '#6b7280';
            const stLabel = isRcvd ? 'Received' : isOver ? 'Overdue' : isWarn ? 'Partial' : 'On track';
            const poQty   = parts.reduce((s, p) => s + (p.qty || 0), 0);
            const poRcvd  = parts.reduce((s, p) => s + (p.received || 0), 0);

            return (
              <div key={ei} style={{ borderBottom: '1px solid #e5e7eb' }}>
                {/* PO row */}
                <div style={{ padding: '11px 24px 11px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: CLS[poCls].bg, borderBottom: '1px solid #e5e7eb', borderLeft: `3px solid ${CLS[poCls].color}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <VendorAvatar vendor={entry.supplier || 'Unknown'} size={28} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.supplier || 'Unknown'}</div>
                      <div className="mono" style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>PO #{po?.poId}{po?.poDate ? ` · ${fmt(po.poDate)}` : ''}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: stColor }}>{stLabel}</div>
                    <div className="mono" style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>{poRcvd}/{poQty}</div>
                  </div>
                </div>

                {/* Column labels — shown once per PO above its parts */}
                {parts.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: COL, gap: 8, padding: '6px 24px', background: '#1f2937' }}>
                    {['Part', 'Qty', 'Ordered', 'Expected', 'Received', 'Price'].map((h, i) => (
                      <span key={i} style={{ fontSize: 9.5, color: '#d1d5db', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', textAlign: i > 0 ? 'right' : 'left' }}>{h}</span>
                    ))}
                  </div>
                )}

                {/* Part rows */}
                {parts.map((p, pi) => {
                  const rcvd     = !!(p.receivedDate || (p.received || 0) >= (p.qty || 1) && (p.qty || 0) > 0);
                  const partial  = !rcvd && (p.received || 0) > 0;
                  const expDate  = p.expectedDate || po?.dueDate;
                  const overdue  = !rcvd && expDate && new Date(expDate) < today;
                  const rowBg    = rcvd    ? 'rgba(22,163,74,0.06)'
                                 : overdue ? 'rgba(220,38,38,0.06)'
                                 : partial ? 'rgba(202,138,4,0.06)'
                                 : 'transparent';
                  const rowBorder = rcvd    ? '#16a34a'
                                  : overdue ? '#dc2626'
                                  : partial ? '#ca8a04'
                                  : '#e5e7eb';
                  return (
                    <div key={pi} style={{ display: 'grid', gridTemplateColumns: COL, gap: 8, padding: '8px 24px 8px 20px', alignItems: 'center', borderBottom: pi < parts.length - 1 ? '1px solid #f3f4f6' : 'none', background: rowBg, borderLeft: `3px solid ${rowBorder}` }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="mono" style={{ fontSize: 11, fontWeight: 600, color: '#374151', wordBreak: 'break-all' }}>{p.partNumber || '—'}</div>
                        {p.partDesc && <div style={{ fontSize: 10, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{p.partDesc}</div>}
                      </div>
                      <span className="mono" style={{ fontSize: 11, color: '#374151', textAlign: 'right' }}>{p.qty}</span>
                      <span className="mono" style={{ fontSize: 10, color: '#9ca3af', textAlign: 'right' }}>{fmt(po?.poDate)}</span>
                      <span className="mono" style={{ fontSize: 10, color: '#9ca3af', textAlign: 'right' }}>{fmt(expDate)}</span>
                      <div style={{ textAlign: 'right' }}>
                        {rcvd
                          ? <span className="mono" style={{ fontSize: 10, color: '#16a34a', fontWeight: 600 }}>✓ {fmt(p.receivedDate)}</span>
                          : expDate
                            ? <span className="mono" style={{ fontSize: 10, color: overdue ? '#dc2626' : '#d97706' }}>Exp {fmt(expDate)}</span>
                            : <span style={{ fontSize: 10, color: '#d1d5db' }}>—</span>
                        }
                      </div>
                      <span className="mono" style={{ fontSize: 10, color: '#6b7280', textAlign: 'right' }}>
                        {p.price > 0 ? `$${Number(p.price).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          {onDrillDown && (
            <button onClick={() => { onClose(); onDrillDown(marker.items.map(e => e.po?.poId).filter(Boolean)); }}
              style={{ fontSize: 12, color: 'var(--sdc-blue)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              View in Procurement →
            </button>
          )}
          <button onClick={onClose} style={{ marginLeft: 'auto', padding: '6px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, color: '#374151', cursor: 'pointer' }}>Close</button>
        </div>
      </div>
    </>
  );
}

function TimelineRibbon({ job, poActions, onDrillDown }) {
  const [viewMode, setViewMode] = useState('ribbon'); // 'ribbon' or 'gantt'
  const [hoveredItem, setHoveredItem] = useState(null);
  const [drawerMarker, setDrawerMarker] = useState(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const scrollRef = useRef(null);
  const wasDragged = useTimelineDrag(scrollRef);

  const updateScrollBtns = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  };
  const today = new Date();
  const buildStart = job.buildStart ? new Date(job.buildStart) : new Date();
  const ship = job.shipDate ? new Date(job.shipDate) : null;

  const displayMilestones = useMemo(() => {
    return [
      { id: 'all',      label: 'All Parts',   color: 'ready',   offset: -20 },
      { id: 'panel',    label: 'Panel Build',  color: 'blue',    offset: -15 },
      { id: 'wiring',   label: 'Wiring',       color: 'pending', offset: 10  },
      { id: 'complete', label: 'Complete',     color: 'ready',   offset: 20  },
      { id: 'power',    label: 'Power Up',     color: 'ready',   offset: 25  },
    ].map(m => { const d = new Date(buildStart); d.setDate(d.getDate() + m.offset); return { ...m, actualDate: d }; });
  }, [buildStart]);

  // ── Classified markers (all POs grouped by due date) ──────────────────
  const classifiedMarkers = useMemo(() => {
    const now = new Date();
    const map = {};
    [...(poActions?.critical || []), ...(poActions?.warning || []), ...(poActions?.onTrack || []), ...(poActions?.delivered || [])].forEach(entry => {
      if (!entry.po?.dueDate) return;
      const d = new Date(entry.po.dueDate);
      const key = d.toISOString().split('T')[0];
      const cls = poReceiptClass(entry.po, now);
      if (!map[key]) map[key] = { date: d, items: [], cls };
      map[key].items.push(entry);
      if (CLS[cls].rank > CLS[map[key].cls].rank) map[key].cls = cls;
    });
    return Object.values(map);
  }, [poActions]);

  // ── Summary buckets (all POs across all categories) ───────────────────
  const summary = useMemo(() => {
    const now = new Date();
    const buckets = { red: [], yellow: [], lightGreen: [], green: [], unscheduled: [] };
    [...(poActions?.critical || []), ...(poActions?.warning || []), ...(poActions?.onTrack || []), ...(poActions?.delivered || [])].forEach(entry => {
      const cls = poReceiptClass(entry.po, now);
      if (cls === 'green') { buckets.green.push(entry); return; }
      if (!entry.po?.dueDate) { buckets.unscheduled.push(entry); return; }
      buckets[cls].push(entry);
    });
    return buckets;
  }, [poActions]);

  // ── Gantt tasks: derived from PO data ──────────────────────────────────
  const ganttTasks = useMemo(() => {
    const now = new Date();
    const allEntries = [
      ...(poActions?.critical || []),
      ...(poActions?.warning || []),
      ...(poActions?.onTrack || []),
      ...(poActions?.delivered || []),
    ];
    return allEntries
      .filter(e => e.po?.dueDate)
      .map(e => {
        const parts = (e.po.parts || []).filter(p => (p.qty || 0) > 0);
        const qty  = parts.reduce((s, p) => s + (p.qty  || 0), 0);
        const rcvd = parts.reduce((s, p) => s + (p.received || 0), 0);
        const cls  = poReceiptClass(e.po, now);
        // Fallback start: PO date, or 14 days before due if missing
        const dueD = new Date(e.po.dueDate);
        const startFallback = new Date(+dueD - 14 * 86400000).toISOString().split('T')[0];
        return {
          id:      e.po.poId,
          name:    `${e.supplier || 'Unknown'} — PO ${e.po.poId}`,
          start:   e.po.poDate || startFallback,
          finish:  e.po.dueDate,
          percent: qty > 0 ? rcvd / qty : 0,
          // 4-way health so colors stay distinct
          health:  cls === 'red' ? 'Red' : cls === 'yellow' ? 'Yellow' : cls === 'green' ? 'Received' : 'OnTrack',
        };
      })
      .sort((a, b) => new Date(a.finish) - new Date(b.finish));
  }, [poActions]);

  // ── Swimlane: group entries by vendor, worst-status first ─────────────
  const swimlaneVendors = useMemo(() => {
    const now = new Date();
    const vendorMap = {};
    [...(poActions?.critical || []), ...(poActions?.warning || []), ...(poActions?.onTrack || []), ...(poActions?.delivered || [])].forEach(entry => {
      const vendor = entry.supplier || 'Unknown';
      if (!vendorMap[vendor]) vendorMap[vendor] = [];
      vendorMap[vendor].push(entry);
    });
    return Object.entries(vendorMap)
      .map(([vendor, entries]) => {
        const worstCls = entries.reduce((worst, e) => {
          const cls = poReceiptClass(e.po, now);
          return CLS[cls].rank > CLS[worst].rank ? cls : worst;
        }, 'green');
        return { vendor, entries, worstCls };
      })
      .sort((a, b) => CLS[b.worstCls].rank - CLS[a.worstCls].rank);
  }, [poActions]);

  // ── View range ─────────────────────────────────────────────────────────
  const allDates = [
    new Date(+today - 30 * 86400000),
    ...classifiedMarkers.map(m => m.date),
    ...displayMilestones.filter(m => m.actualDate).map(m => m.actualDate),
    buildStart,
    ...(ship ? [ship] : []),
  ].filter(d => d instanceof Date && !isNaN(+d));   // drop any Invalid Date values
  const earliest = new Date(Math.min(...allDates.map(d => +d)));
  const latestKnown = new Date(Math.max(...allDates.map(d => +d)));
  const rangeEnd = ship ? new Date(+ship + 30 * 86400000) : new Date(+latestKnown + 60 * 86400000);
  const rangeStart = new Date(earliest);
  rangeStart.setDate(rangeStart.getDate() - rangeStart.getDay() - 21);

  const DAY_W = 22;
  const totalDays = Math.ceil((+rangeEnd - +rangeStart) / 86400000);
  const totalWidth = totalDays * DAY_W;
  const EDGE_PAD = 10;
  const dayToX = d => Math.max(EDGE_PAD, Math.min(totalWidth - EDGE_PAD, ((+new Date(d) - +rangeStart) / 86400000) * DAY_W));
  const todayX = dayToX(today);


  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayX - el.clientWidth * 0.3);
    setTimeout(updateScrollBtns, 50);
  }, []); // eslint-disable-line

  const weeks = [];
  { let w = new Date(rangeStart); while (+w <= +rangeEnd) { weeks.push(new Date(w)); w = new Date(+w + 7 * 86400000); } }

  const months = [];
  {
    let mc = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
    let idx = 0;
    while (+mc <= +rangeEnd) {
      const mEnd = new Date(mc.getFullYear(), mc.getMonth() + 1, 0);
      const start = +mc < +rangeStart ? rangeStart : mc;
      const end = +mEnd > +rangeEnd ? rangeEnd : mEnd;
      months.push({
        label: mc.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
        year: mc.getFullYear(),
        isYearStart: mc.getMonth() === 0, // January = year boundary
        startX: dayToX(start),
        width: Math.max(0, dayToX(end) - dayToX(start)),
        even: idx % 2 === 0,
      });
      mc = new Date(mc.getFullYear(), mc.getMonth() + 1, 1);
      idx++;
    }
  }

  // Build year spans for the year band above months
  const yearBands = [];
  {
    let curYear = null, bandStart = 0;
    months.forEach((m, i) => {
      if (m.year !== curYear) {
        if (curYear !== null) yearBands.push({ year: curYear, startX: bandStart, endX: m.startX });
        curYear = m.year;
        bandStart = m.startX;
      }
      if (i === months.length - 1) yearBands.push({ year: curYear, startX: bandStart, endX: m.startX + m.width });
    });
  }

  const fmt = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const fmtFull = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const bsDays = Math.round((+buildStart - +today) / 86400000);
  const M = { ready: 'var(--ready)', pending: 'var(--pending)', blue: 'var(--sdc-blue)', threat: 'var(--threat)' };

  const milestones = displayMilestones
    .filter(m => m.actualDate)
    .sort((a, b) => +a.actualDate - +b.actualDate)
    .map((m, i) => ({ ...m, row: i % 2 }));

  // ── Combined Gantt rows: milestone diamonds + PO bars ──────────────────
  const ganttRows = viewMode === 'gantt' ? [
    ...milestones.map(m => ({ type: 'milestone', id: m.id, label: m.label, date: m.actualDate, colorKey: m.color })),
    ...ganttTasks.map(t => ({ type: 'po', ...t })),
  ] : [];

  const TY = 160;
  const SWIM_MS_H  = 76;  // swimlane milestone lane height
  const SWIM_VH    = 38;  // swimlane per-vendor lane height
  const SCAT_MS_H  = 70;  // scatter milestone band height
  const SCAT_H     = 290; // scatter plot area height
  const totalPOs = Object.values(summary).reduce((s, arr) => s + arr.length, 0);

  // ── V2 header derived values ───────────────────────────────────────────
  const totalAsm     = Math.max(1, job.kpis.assemblies);
  const scorePct     = Math.round((job.kpis.ready / totalAsm) * 100);
  const healthStat   = scorePct >= 85 ? 'ON TRACK' : scorePct >= 60 ? 'AT RISK' : 'BEHIND';
  const hColor       = scorePct >= 85 ? '#16a34a' : scorePct >= 60 ? '#ca8a04' : '#dc2626';
  const hBg          = scorePct >= 85 ? 'rgba(22,163,74,0.1)' : scorePct >= 60 ? 'rgba(202,138,4,0.1)' : 'rgba(220,38,38,0.1)';
  const needAction   = summary.red.length + summary.yellow.length;
  const distTotal    = Math.max(1, job.kpis.ready + job.kpis.close + job.kpis.blocked);
  const distReadyPct = Math.round(job.kpis.ready  / distTotal * 100);
  const distClosePct = Math.round(job.kpis.close  / distTotal * 100);
  const distBlockPct = 100 - distReadyPct - distClosePct;
  const GS = 64, GR = GS / 2 - 4, GC = 2 * Math.PI * GR;
  const gaugeMax   = Math.max(30, bsDays + 5);
  const gaugeOff   = GC * (1 - Math.max(0, Math.min(1, bsDays / gaugeMax)));
  const gaugeColor = bsDays < 0 ? '#dc2626' : bsDays < 7 ? '#ca8a04' : 'var(--sdc-blue)';

  return (
    <div className="sdc-card" style={{ padding: '20px 24px 20px', marginBottom: 24, background: 'var(--bg-raised)' }}>

      {/* ── V2 Header: 3-column grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 24, paddingBottom: 14, borderBottom: '1px solid var(--border-subtle)' }}>

        {/* Left: score lockup */}
        <div>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--ink-4)', textTransform: 'uppercase', marginBottom: 4 }}>Schedule Health</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 38, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, color: hColor }}>{scorePct}%</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: hBg, color: hColor, borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: hColor, flexShrink: 0 }} />
              {healthStat}
            </span>
          </div>
        </div>

        {/* Center: KPI cards */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ minWidth: 120, padding: '9px 14px', border: `1px solid ${job.kpis.blocked > 0 ? 'rgba(220,38,38,0.3)' : 'var(--border-subtle)'}`, borderRadius: 6, background: job.kpis.blocked > 0 ? 'rgba(220,38,38,0.06)' : 'var(--bg-sunken)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4, color: job.kpis.blocked > 0 ? '#dc2626' : 'var(--ink-4)' }}>Risks</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, lineHeight: 1, color: job.kpis.blocked > 0 ? '#dc2626' : 'var(--ink)' }}>{job.kpis.blocked}</div>
            <div style={{ fontSize: 10.5, marginTop: 3, color: job.kpis.blocked > 0 ? 'rgba(220,38,38,0.7)' : 'var(--ink-4)' }}>blocked milestones</div>
          </div>
          <div style={{ minWidth: 120, padding: '9px 14px', border: `1px solid ${needAction > 0 ? 'rgba(202,138,4,0.35)' : 'var(--border-subtle)'}`, borderRadius: 6, background: needAction > 0 ? 'rgba(202,138,4,0.07)' : 'var(--bg-sunken)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4, color: needAction > 0 ? '#ca8a04' : 'var(--ink-4)' }}>Need Action</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, lineHeight: 1, color: needAction > 0 ? '#ca8a04' : 'var(--ink)' }}>{needAction}</div>
            <div style={{ fontSize: 10.5, marginTop: 3, color: needAction > 0 ? 'rgba(202,138,4,0.75)' : 'var(--ink-4)' }}>POs awaiting</div>
          </div>
          <div style={{ minWidth: 120, padding: '9px 14px', border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-sunken)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4, color: 'var(--ink-4)' }}>Open Parts</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, lineHeight: 1, color: 'var(--ink)' }}>{job.kpis.noPO}</div>
            <div style={{ fontSize: 10.5, marginTop: 3, color: 'var(--ink-4)' }}>no PO assigned</div>
          </div>
        </div>

        {/* Right: gauge + date stack */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: GS, height: GS, position: 'relative', flexShrink: 0 }}>
            <svg width={GS} height={GS}>
              <circle cx={GS/2} cy={GS/2} r={GR} fill="none" stroke="var(--border)" strokeWidth="3.5" />
              <circle cx={GS/2} cy={GS/2} r={GR} fill="none" stroke={gaugeColor} strokeWidth="3.5"
                strokeLinecap="round" strokeDasharray={GC} strokeDashoffset={gaugeOff}
                transform={`rotate(-90 ${GS/2} ${GS/2})`}
                style={{ transition: 'stroke-dashoffset 0.5s' }}
              />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, color: gaugeColor }}>{Math.abs(bsDays)}</span>
              <span style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--ink-4)', textTransform: 'uppercase', marginTop: 2 }}>{bsDays >= 0 ? 'TO BUILD' : 'PAST BUILD'}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 16, borderLeft: '1px solid var(--border-subtle)' }}>
            {[['Today', fmtFull(today), false], ['Build', fmtFull(buildStart), bsDays < 7], ['Ship', ship ? fmtFull(ship) : 'TBD', false]].map(([lbl, val, warn]) => (
              <div key={lbl} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-4)', width: 34, flexShrink: 0 }}>{lbl}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 12, color: warn ? '#dc2626' : val === 'TBD' ? 'var(--ink-4)' : 'var(--ink)' }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Distribution bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0 12px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 12 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-4)', whiteSpace: 'nowrap' }}>Distribution</span>
        <div style={{ flex: 1, height: 8, borderRadius: 4, display: 'flex', overflow: 'hidden' }}>
          {distReadyPct > 0 && <div style={{ width: `${distReadyPct}%`, background: '#16a34a' }} />}
          {distClosePct > 0 && <div style={{ width: `${distClosePct}%`, background: '#ca8a04' }} />}
          {distBlockPct > 0 && <div style={{ width: `${distBlockPct}%`, background: '#dc2626' }} />}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontSize: 11.5, color: 'var(--ink-2)', flexShrink: 0 }}>
          {[['#16a34a', job.kpis.ready, 'ready'], ['#ca8a04', job.kpis.close, 'close'], ['#dc2626', job.kpis.blocked, 'blocked']].map(([color, count, label]) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              {count} <span style={{ color: 'var(--ink-4)', fontFamily: 'inherit', fontWeight: 400 }}>{label}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ── Scrollable Calendar Strip ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>Schedule & PO Tracking</div>
        <div style={{ display: 'flex', gap: 3 }}>
          {[['ribbon','Timeline'],['swimlane','Swimlane'],['scatter','Scatter'],['gantt','Gantt']].map(([mode, label]) => (
            <button key={mode} onClick={() => setViewMode(mode)} style={{ padding: '4px 12px', background: viewMode === mode ? 'var(--sdc-blue)' : 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, fontWeight: 600, color: viewMode === mode ? '#fff' : 'var(--ink-2)', cursor: 'pointer' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-raised)' }}>
        {/* Left fixed pane (Gantt only) */}
        {viewMode === 'gantt' && ganttRows.length > 0 && (
          <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--border-strong)', background: 'var(--bg-raised)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 56, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-sunken)', padding: '0 14px', display: 'flex', alignItems: 'center', fontSize: 10, fontWeight: 700, color: 'var(--ink-4)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Schedule
            </div>
            <div style={{ paddingTop: 120 }}>
              {ganttRows.map((row, i) => {
                if (row.type === 'milestone') {
                  const c = M[row.colorKey] || '#6b7280';
                  return (
                    <div key={`lp-${i}`} style={{ height: 28, padding: '0 14px 0 ' + (14 + (row.indentLevel || 0) * 16) + 'px', display: 'flex', alignItems: 'center', gap: 7, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-sunken)', fontSize: 10.5, fontWeight: 700, color: 'var(--ink-1)' }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, background: c, transform: 'rotate(45deg)', borderRadius: 1, flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label || row.name}</span>
                    </div>
                  );
                }
                if (row.type === 'summary') {
                  return (
                    <div key={`lp-${i}`} style={{ height: 28, padding: '0 14px 0 ' + (14 + (row.indentLevel || 0) * 16) + 'px', display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', background: i % 2 === 0 ? 'rgba(37,99,235,0.04)' : 'rgba(37,99,235,0.07)', fontSize: 11, fontWeight: 700, color: 'var(--sdc-blue)', letterSpacing: '0.01em' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>▸ {row.name}</span>
                    </div>
                  );
                }
                // task or po
                const isRcvd = (row.health || '') === 'Received' || (row.percent || 0) >= 1;
                const isCrit = row.onCritical;
                return (
                  <div key={`lp-${i}`} style={{ height: 28, padding: '0 14px 0 ' + (14 + (row.indentLevel || 0) * 16) + 'px', display: 'flex', alignItems: 'center', gap: 5, borderBottom: '1px solid var(--border-subtle)', fontSize: 11, color: isRcvd ? 'var(--ink-4)' : isCrit ? '#dc2626' : 'var(--ink)', background: i % 2 === 0 ? 'var(--bg-raised)' : 'var(--bg-sunken)' }}>
                    {isCrit && !isRcvd && <span style={{ width: 3, height: 14, background: '#dc2626', borderRadius: 2, flexShrink: 0 }} />}
                    {isRcvd && <span style={{ color: '#16a34a', fontSize: 9, fontWeight: 800, flexShrink: 0 }}>✓</span>}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: isRcvd ? 'line-through' : 'none' }}>{row.name}</span>
                    {row.assignee && <span style={{ marginLeft: 'auto', fontSize: 8.5, color: 'var(--ink-4)', flexShrink: 0, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.assignee}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Swimlane left label pane */}
        {viewMode === 'swimlane' && (
          <div style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--border-strong)', background: 'var(--bg-raised)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
            {/* header spacer matching year+month+week bands = 56px */}
            <div style={{ height: 56, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-sunken)' }} />
            {/* Milestones lane label */}
            <div style={{ height: SWIM_MS_H, borderBottom: '2px solid var(--border)', background: 'var(--bg-sunken)', padding: '0 14px', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--ink-4)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Milestones</span>
            </div>
            {/* Vendor rows */}
            {swimlaneVendors.map(({ vendor, entries, worstCls }, vi) => (
              <div key={vi} style={{ height: SWIM_VH, flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', background: vi % 2 === 0 ? 'var(--bg-raised)' : 'var(--bg-sunken)', padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <VendorAvatar vendor={vendor} size={20} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vendor}</div>
                  <div style={{ fontSize: 9, color: 'var(--ink-4)' }}>{entries.length} PO{entries.length !== 1 ? 's' : ''}</div>
                </div>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: CLS[worstCls].color, flexShrink: 0 }} />
              </div>
            ))}
          </div>
        )}

        {/* Scatter left pane — Y-axis labels */}
        {viewMode === 'scatter' && (
          <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid var(--border-strong)', background: 'var(--bg-raised)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 56, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-sunken)' }} />
            <div style={{ height: SCAT_MS_H, borderBottom: '2px solid var(--border)', background: 'var(--bg-sunken)', padding: '0 14px', display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--ink-4)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Milestones</span>
            </div>
            {/* Y-axis label strip */}
            <div style={{ position: 'relative', height: SCAT_H, flexShrink: 0 }}>
              {/* Rotated axis title */}
              <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%) rotate(-90deg)', transformOrigin: 'center', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-5)', whiteSpace: 'nowrap' }}>% Parts Received</div>
              {/* Tick labels */}
              {[100, 75, 50, 25, 0].map(pct => (
                <div key={pct} style={{ position: 'absolute', right: 14, top: ((100 - pct) / 100) * SCAT_H, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', fontWeight: 600, color: pct === 100 ? '#16a34a' : pct === 0 ? '#dc2626' : 'var(--ink-4)' }}>{pct}%</span>
                  <div style={{ width: 6, height: 1, background: 'var(--border-subtle)' }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scrollable area */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {canScrollLeft && (
            <button onClick={() => { scrollRef.current.scrollBy({ left: -300, behavior: 'smooth' }); }} style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', zIndex: 40, width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: 'var(--ink-2)', pointerEvents: 'all' }}>‹</button>
          )}
          {canScrollRight && (
            <button onClick={() => { scrollRef.current.scrollBy({ left: 300, behavior: 'smooth' }); }} style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', zIndex: 40, width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-raised)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: 'var(--ink-2)', pointerEvents: 'all' }}>›</button>
          )}
        <div ref={scrollRef} onScroll={updateScrollBtns} style={{ overflowX: 'auto', overflowY: 'hidden', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'thin', scrollbarColor: 'var(--border) transparent' }}>
          <div style={{ width: totalWidth, position: 'relative' }}>

          {/* TODAY full-height line */}
          <div style={{ position: 'absolute', left: todayX, top: 0, bottom: 0, width: 2, transform: 'translateX(-50%)', background: 'var(--sdc-blue)', opacity: 0.65, zIndex: 30, pointerEvents: 'none' }} />

          {/* Year band */}
          <div style={{ position: 'relative', height: 18, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-sunken)' }}>
            {yearBands.map((yb, i) => (
              <div key={i} style={{ position: 'absolute', left: yb.startX, width: yb.endX - yb.startX, height: '100%', borderLeft: i > 0 ? '2px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', paddingLeft: 8, overflow: 'hidden' }}>
                <span style={{ fontSize: 9, fontWeight: 900, color: 'var(--ink-2)', letterSpacing: '0.12em', whiteSpace: 'nowrap' }}>{yb.year}</span>
              </div>
            ))}
          </div>

          {/* Month band */}
          <div style={{ position: 'relative', height: 20, borderBottom: '1px solid var(--border-subtle)' }}>
            {months.map((m, i) => (
              <div key={i} style={{ position: 'absolute', left: m.startX, width: m.width, height: '100%', background: m.even ? 'var(--bg-sunken)' : 'var(--bg)', borderLeft: i > 0 ? '1px solid var(--border-subtle)' : 'none', display: 'flex', alignItems: 'center', paddingLeft: 6, overflow: 'hidden' }}>
                <span style={{ fontSize: 8.5, fontWeight: 800, color: m.isYearStart ? 'var(--sdc-blue)' : 'var(--ink-3)', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>{m.label}</span>
              </div>
            ))}
          </div>

          {/* Week tick ruler */}
          <div style={{ position: 'relative', height: 18, borderBottom: '1px solid var(--border-subtle)' }}>
            {months.map((m, i) => m.even ? <div key={i} style={{ position: 'absolute', left: m.startX, width: m.width, height: '100%', background: 'var(--bg-sunken)' }} /> : null)}
            {months.slice(1).map((m, i) => <div key={i} style={{ position: 'absolute', left: m.startX, top: 0, bottom: 0, width: 1, background: 'var(--border-subtle)' }} />)}
            {weeks.map((week, i) => {
              const x = dayToX(week);
              if (x < 5 || x > totalWidth - 5) return null;
              const isThisWeek = +week <= +today && +today < +week + 7 * 86400000;
              const label = week.getDate() === 1 ? week.toLocaleDateString('en-US', { month: 'short' }) : week.getDate();
              return (
                <div key={i} style={{ position: 'absolute', left: x, top: 0, bottom: 0, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2, pointerEvents: 'none' }}>
                  <div style={{ width: 1, height: 4, background: isThisWeek ? 'var(--sdc-blue)' : 'var(--border)', marginBottom: 1 }} />
                  <span style={{ fontSize: 7.5, color: isThisWeek ? 'var(--sdc-blue)' : 'var(--ink-5)', fontWeight: isThisWeek ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>{label}</span>
                </div>
              );
            })}
          </div>

          {/* Track area */}
          <div style={{ position: 'relative', height: viewMode === 'gantt' && ganttRows.length > 0 ? TY + (ganttRows.length * 28) + 40 : viewMode === 'swimlane' ? SWIM_MS_H + (swimlaneVendors.length * SWIM_VH) + 20 : viewMode === 'scatter' ? SCAT_MS_H + SCAT_H + 30 : TY + 80, background: 'var(--bg-raised)' }}>
            {months.map((m, i) => m.even ? <div key={i} style={{ position: 'absolute', left: m.startX, width: m.width, top: 0, bottom: 0, background: 'rgba(0,0,0,0.012)' }} /> : null)}
            {months.slice(1).map((m, i) => <div key={i} style={{ position: 'absolute', left: m.startX, top: 0, bottom: 0, width: 1, background: 'var(--border-subtle)', opacity: 0.4 }} />)}

            {viewMode !== 'swimlane' && viewMode !== 'scatter' && <>
            <div style={{ position: 'absolute', left: 0, right: 0, top: TY, height: 5, background: 'var(--bg-sunken)', borderRadius: 3 }} />
            <div style={{ position: 'absolute', left: 0, width: dayToX(today), top: TY, height: 5, background: 'linear-gradient(90deg, var(--ready), var(--sdc-blue))', borderRadius: 3 }} />
            {summary.red.length + summary.yellow.length > 0 && dayToX(buildStart) > dayToX(today) && (
              <div style={{ position: 'absolute', left: dayToX(today), width: dayToX(buildStart) - dayToX(today), top: TY, height: 5, background: 'repeating-linear-gradient(45deg, rgba(220,38,38,0.12) 0 4px, rgba(220,38,38,0.45) 4px 5px)', borderRadius: 3 }} />
            )}
            </>}

            {(() => {
              const altMode  = viewMode === 'swimlane' || viewMode === 'scatter';
              const labelTop = viewMode === 'swimlane' ? SWIM_MS_H + 5 : viewMode === 'scatter' ? SCAT_MS_H + 8 : TY + 13;
              const todayTop = viewMode === 'swimlane' ? 6 : viewMode === 'scatter' ? 6 : TY - 22;
              return (<>
                <div style={{ position: 'absolute', left: dayToX(buildStart), top: altMode ? 0 : TY, bottom: 0, width: 1.5, background: 'var(--threat)', opacity: 0.45, transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 5 }} />
                {ship && <div style={{ position: 'absolute', left: dayToX(ship), top: altMode ? 0 : TY, bottom: 0, width: 1, background: 'var(--ink-4)', opacity: 0.25, transform: 'translateX(-50%)', pointerEvents: 'none' }} />}
                <div style={{ position: 'absolute', left: todayX, top: todayTop, transform: 'translateX(-50%)', background: 'var(--sdc-blue)', color: '#fff', fontSize: 7.5, fontWeight: 800, letterSpacing: '0.08em', padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', zIndex: 35, pointerEvents: 'none' }}>TODAY</div>
                <div style={{ position: 'absolute', left: dayToX(buildStart), top: labelTop, transform: 'translateX(-50%)', background: 'var(--threat)', color: '#fff', fontSize: 7, fontWeight: 800, letterSpacing: '0.06em', padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', zIndex: 20, pointerEvents: 'none' }}>BUILD START</div>
                {ship && <div style={{ position: 'absolute', left: dayToX(ship), top: labelTop, transform: 'translateX(-50%)', background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--ink-3)', fontSize: 7, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 5px', borderRadius: 3, whiteSpace: 'nowrap', zIndex: 15, pointerEvents: 'none' }}>SHIP</div>}
              </>);
            })()}

            {/* Milestone chips — ribbon mode only */}
            {viewMode === 'ribbon' && milestones.map(m => {
              const x = dayToX(m.actualDate);
              const c = M[m.color] || 'var(--ink-4)';

              const labelTop = m.row === 0 ? 15 : 85;
              const stemH = TY - 5 - (labelTop + 22);

              return (
                <div key={m.id} onMouseEnter={e => setHoveredItem({ type: 'milestone', data: m, date: m.actualDate, rect: e.currentTarget.getBoundingClientRect() })} onMouseLeave={() => setHoveredItem(null)} style={{ position: 'absolute', left: x, top: 0, bottom: 0, transform: 'translateX(-50%)', zIndex: 10, cursor: 'pointer' }}>
                  <div style={{ position: 'absolute', top: labelTop, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-raised)', border: `1.5px solid ${c}`, borderRadius: 4, padding: '2px 7px', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: c, textTransform: 'uppercase', whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(0,0,0,0.09)' }}>
                    {m.label}
                  </div>
                  {stemH > 2 && <div style={{ position: 'absolute', top: labelTop + 22, left: '50%', transform: 'translateX(-50%)', width: 1, height: stemH, background: c, opacity: 0.28 }} />}
                  <div style={{ position: 'absolute', top: TY + 2, left: '50%', transform: 'translate(-50%, -50%) rotate(45deg)', width: 9, height: 9, background: c, border: '2px solid var(--bg-raised)', borderRadius: 2, boxShadow: `0 0 0 1px ${c}`, zIndex: 12 }} />
                </div>
              );
            })}

            {/* Classified PO threat markers — ribbon mode only */}
            {viewMode === 'ribbon' && classifiedMarkers.map((m, i) => {
              const { color } = CLS[m.cls];
              const sz = 11;
              const isActive = drawerMarker === m;
              const count = m.items.length;
              const stackDepth = Math.min(count, 3);
              // Container grows upward to accommodate the stack
              const containerTop = TY + 7 - (stackDepth - 1) * 4;

              return (
                <div key={i}
                  data-timeline-diamond="1"
                  onMouseEnter={e => setHoveredItem({ type: 'threat', data: m, rect: e.currentTarget.getBoundingClientRect() })}
                  onMouseLeave={() => setHoveredItem(null)}
                  onClick={e => {
                    if (wasDragged.current) { wasDragged.current = false; return; }
                    e.stopPropagation();
                    setHoveredItem(null);
                    setDrawerMarker(m);
                  }}
                  style={{
                    position: 'absolute',
                    top: containerTop,
                    left: dayToX(m.date),
                    transform: 'translateX(-50%)',
                    width: sz + 10,
                    height: sz + (stackDepth - 1) * 4 + 4,
                    zIndex: isActive ? 20 : 15,
                    cursor: 'pointer',
                  }}
                >
                  {/* Stack layers: si=0 is furthest back (top of visual stack), si=stackDepth-1 is front */}
                  {Array.from({ length: stackDepth }).map((_, si) => {
                    const isFront = si === stackDepth - 1;
                    const yOffset = (stackDepth - 1 - si) * 4;
                    return (
                      <div key={si} style={{
                        position: 'absolute',
                        top: yOffset,
                        left: '50%',
                        transform: 'translateX(-50%) rotate(45deg)',
                        width: sz,
                        height: sz,
                        background: isFront ? color : 'var(--bg-raised)',
                        border: `${isFront && isActive ? '2px' : '1.5px'} solid ${color}`,
                        borderRadius: 1,
                        opacity: m.cls === 'green'
                          ? (isFront ? 0.5 : 0.18)
                          : (isFront ? 1 : 0.28 + si * 0.18),
                        boxShadow: isFront
                          ? (isActive ? `0 0 0 2px ${color}, 0 0 8px ${color}80` : `0 0 5px ${color}60`)
                          : 'none',
                        zIndex: si + 1,
                        transition: 'box-shadow 0.15s',
                      }} />
                    );
                  })}
                  {/* Count badge — only shown when more than 1 PO */}
                  {count > 1 && (
                    <div style={{
                      position: 'absolute',
                      top: 0,
                      right: -1,
                      background: color,
                      color: '#fff',
                      fontSize: 6.5,
                      fontWeight: 800,
                      minWidth: 13,
                      height: 13,
                      borderRadius: 7,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 2px',
                      border: '1.5px solid var(--bg-raised)',
                      zIndex: stackDepth + 2,
                      letterSpacing: '0.02em',
                      pointerEvents: 'none',
                    }}>{count}</div>
                  )}
                </div>
              );
            })}

            {/* ── Gantt view: rows (milestone diamonds, summary bars, task bars) ── */}
            {viewMode === 'gantt' && ganttRows.map((row, i) => {
              const rowTop = TY + (i * 28);
              const rowMid = rowTop + 14;
              const band = i % 2 === 1 ? (
                <div key={`band-${i}`} style={{ position: 'absolute', top: rowTop, left: 0, right: 0, height: 28, background: 'rgba(0,0,0,0.018)', pointerEvents: 'none' }} />
              ) : null;

              // ── MILESTONE row ──
              if (row.type === 'milestone') {
                const c = M[row.colorKey] || '#6b7280';
                const x = row.date ? dayToX(row.date) : null;
                if (!x) return band;
                return (
                  <React.Fragment key={`ms-${i}`}>
                    {band}
                    <div style={{ position: 'absolute', top: rowMid, left: 0, right: 0, height: 1, background: `${c}22`, pointerEvents: 'none', zIndex: 2 }} />
                    <div style={{ position: 'absolute', top: 56, left: x, width: 1, height: rowMid - 56, background: `${c}20`, transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 2 }} />
                    <div
                      onMouseEnter={e => setHoveredItem({ type: 'milestone', data: row, date: row.date, rect: e.currentTarget.getBoundingClientRect() })}
                      onMouseLeave={() => setHoveredItem(null)}
                      style={{ position: 'absolute', top: rowMid - 8, left: x, transform: 'translateX(-50%) rotate(45deg)', width: 16, height: 16, background: c, border: '2.5px solid var(--bg-raised)', borderRadius: 2, boxShadow: `0 0 0 1.5px ${c}, 0 2px 8px ${c}50`, zIndex: 15, cursor: 'pointer' }}
                    />
                    <div style={{ position: 'absolute', top: rowMid - 9, left: x + 14, fontSize: 8.5, fontWeight: 700, color: c, letterSpacing: '0.04em', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 16 }}>
                      {fmt(row.date)}
                    </div>
                  </React.Fragment>
                );
              }

              // ── SUMMARY row ──
              if (row.type === 'summary') {
                if (!row.start && !row.finish) return band;
                const sx = dayToX(row.start || row.finish);
                const fx = dayToX(row.finish || row.start);
                const w  = Math.max(8, fx - sx);
                return (
                  <React.Fragment key={`sum-${i}`}>
                    {band}
                    <div style={{ position: 'absolute', top: rowMid - 5, left: sx, width: w, height: 10, background: 'var(--sdc-blue)', borderRadius: 2, opacity: 0.35, zIndex: 9 }} />
                    <div style={{ position: 'absolute', top: rowMid - 5, left: sx, width: w, height: 10, background: 'transparent', border: '1.5px solid var(--sdc-blue)', borderRadius: 2, opacity: 0.6, zIndex: 10 }} />
                    {/* End caps */}
                    <div style={{ position: 'absolute', top: rowMid + 4, left: sx, width: 0, height: 0, borderLeft: '5px solid var(--sdc-blue)', borderTop: '5px solid transparent', opacity: 0.6, zIndex: 10 }} />
                    <div style={{ position: 'absolute', top: rowMid + 4, left: fx, width: 0, height: 0, borderRight: '5px solid var(--sdc-blue)', borderTop: '5px solid transparent', transform: 'translateX(-100%)', opacity: 0.6, zIndex: 10 }} />
                  </React.Fragment>
                );
              }

              // ── TASK / PO row ──
              const h = row.health || '';
              const isRed      = h.toLowerCase().includes('red');
              const isYellow   = h.toLowerCase().includes('yellow');
              const isReceived = h === 'Received' || (row.percent || 0) >= 1;
              const isCrit     = !!row.onCritical;
              const c = isRed ? '#dc2626' : isYellow ? '#ca8a04' : isReceived ? '#16a34a' : 'var(--sdc-blue)';
              const opacity    = isReceived ? 0.5 : 0.88;
              const pct        = Math.round((row.percent || 0) * 100);
              const startXPos  = dayToX(row.start || row.finish || buildStart);
              const finishXPos = dayToX(row.finish || row.start || today);
              const barWidth   = Math.max(4, finishXPos - startXPos - 10);

              return (
                <React.Fragment key={`task-${i}`}>
                  {band}
                  <div
                    title={`${row.name}${row.assignee ? ' · ' + row.assignee : ''} · ${pct}%${row.predecessorDisplay ? ' · Pred: ' + row.predecessorDisplay : ''}`}
                    style={{ position: 'absolute', top: rowTop + 7, left: startXPos, width: barWidth, height: 14, background: c, borderRadius: '3px 0 0 3px', opacity, cursor: 'default', zIndex: 10, overflow: 'hidden', boxShadow: isCrit ? `0 0 0 1.5px #dc2626, 0 0 0 2.5px #dc262630` : '0 1px 3px rgba(0,0,0,0.1)' }}
                  >
                    {pct > 0 && pct < 100 && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: 'rgba(255,255,255,0.28)', borderRadius: '3px 0 0 3px' }} />}
                    {barWidth > 40 && (
                      <span style={{ position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)', fontSize: 7.5, fontWeight: 700, color: '#fff', letterSpacing: '0.04em', pointerEvents: 'none' }}>
                        {isReceived ? '✓' : `${pct}%`}
                      </span>
                    )}
                  </div>
                  {/* Diamond at due date */}
                  <div
                    style={{ position: 'absolute', top: rowMid - 6, left: finishXPos, transform: 'translateX(-50%) rotate(45deg)', width: 12, height: 12, background: isReceived ? c : 'var(--bg-raised)', border: `2px solid ${c}`, borderRadius: 2, boxShadow: isCrit ? `0 0 0 1px #dc262670` : `0 0 0 1px ${c}50`, zIndex: 14, opacity }}
                  />
                </React.Fragment>
              );
            })}

            {/* ── Swimlane view ── */}
            {viewMode === 'swimlane' && (() => {
              const now = new Date();
              return (
                <>
                  {/* Milestone lane background */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: SWIM_MS_H, background: 'var(--bg-sunken)', pointerEvents: 'none', zIndex: 1 }} />
                  {/* Milestone / vendor separator */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: SWIM_MS_H, height: 2, background: 'var(--border)', pointerEvents: 'none', zIndex: 3 }} />
                  {/* Vendor lane alternating backgrounds + dividers */}
                  {swimlaneVendors.map((_v, vi) => (
                    <div key={`vb-${vi}`} style={{ position: 'absolute', left: 0, right: 0, top: SWIM_MS_H + vi * SWIM_VH, height: SWIM_VH, background: vi % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.018)', borderBottom: '1px solid var(--border-subtle)', pointerEvents: 'none', zIndex: 1 }} />
                  ))}

                  {/* Milestone chips */}
                  {milestones.map(m => {
                    const x = dayToX(m.actualDate);
                    const c = M[m.color] || 'var(--ink-4)';
                    const chipTop = m.row === 0 ? 7 : SWIM_MS_H / 2 + 2;
                    return (
                      <React.Fragment key={m.id}>
                        <div
                          onMouseEnter={e => setHoveredItem({ type: 'milestone', data: m, date: m.actualDate, rect: e.currentTarget.getBoundingClientRect() })}
                          onMouseLeave={() => setHoveredItem(null)}
                          style={{ position: 'absolute', left: x, top: chipTop, transform: 'translateX(-50%)', zIndex: 10, cursor: 'pointer' }}
                        >
                          <div style={{ background: 'var(--bg-raised)', border: `1.5px solid ${c}`, borderRadius: 4, padding: '2px 7px', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: c, textTransform: 'uppercase', whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(0,0,0,0.09)' }}>
                            {m.label}
                          </div>
                        </div>
                        {/* stem to bottom of milestone lane */}
                        <div style={{ position: 'absolute', left: x, top: chipTop + 18, transform: 'translateX(-50%)', width: 1, height: Math.max(0, SWIM_MS_H - chipTop - 26), background: c, opacity: 0.25, pointerEvents: 'none', zIndex: 4 }} />
                        {/* diamond at bottom edge of milestone lane */}
                        <div style={{ position: 'absolute', left: x, top: SWIM_MS_H - 10, transform: 'translate(-50%, -50%) rotate(45deg)', width: 8, height: 8, background: c, border: '2px solid var(--bg-raised)', borderRadius: 1, pointerEvents: 'none', zIndex: 12 }} />
                      </React.Fragment>
                    );
                  })}

                  {/* PO bars per vendor */}
                  {swimlaneVendors.map(({ entries }, vi) => {
                    const laneY = SWIM_MS_H + vi * SWIM_VH;
                    return entries.map((entry, ei) => {
                      if (!entry.po?.dueDate) return null;
                      const cls = poReceiptClass(entry.po, now);
                      const { color } = CLS[cls];
                      const startD = entry.po.poDate
                        ? new Date(entry.po.poDate)
                        : new Date(+new Date(entry.po.dueDate) - 21 * 86400000);
                      const sx = dayToX(startD);
                      const fx = dayToX(new Date(entry.po.dueDate));
                      const bw = Math.max(6, fx - sx);
                      const isRcvd = cls === 'green';
                      return (
                        <div
                          key={`sw-${vi}-${ei}`}
                          onMouseEnter={e => setHoveredItem({ type: 'threat', data: { date: new Date(entry.po.dueDate), items: [entry], cls }, rect: e.currentTarget.getBoundingClientRect() })}
                          onMouseLeave={() => setHoveredItem(null)}
                          onClick={e => {
                            if (wasDragged.current) { wasDragged.current = false; return; }
                            e.stopPropagation();
                            setHoveredItem(null);
                            setDrawerMarker({ date: new Date(entry.po.dueDate), items: [entry] });
                          }}
                          style={{
                            position: 'absolute',
                            left: sx,
                            top: laneY + 7,
                            width: bw,
                            height: SWIM_VH - 14,
                            background: `${color}${isRcvd ? '20' : '28'}`,
                            border: `1.5px solid ${color}${isRcvd ? '70' : 'bb'}`,
                            borderLeft: `3px solid ${color}`,
                            borderRadius: 3,
                            cursor: 'pointer',
                            overflow: 'hidden',
                            zIndex: 10,
                          }}
                        >
                          {bw > 32 && (
                            <span className="mono" style={{ position: 'absolute', left: 5, top: '50%', transform: 'translateY(-50%)', fontSize: 8.5, fontWeight: 700, color, whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: bw - 10 }}>
                              {entry.po.poId}
                            </span>
                          )}
                        </div>
                      );
                    });
                  })}
                </>
              );
            })()}

            {/* ── Scatter plot view ── */}
            {viewMode === 'scatter' && (() => {
              const now = new Date();
              const allEntries = [
                ...(poActions?.critical  || []),
                ...(poActions?.warning   || []),
                ...(poActions?.onTrack   || []),
                ...(poActions?.delivered || []),
              ];
              const bsX = dayToX(buildStart);

              return (
                <>
                  {/* Milestone band background */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: SCAT_MS_H, background: 'var(--bg-sunken)', pointerEvents: 'none', zIndex: 1 }} />
                  {/* Band separator */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: SCAT_MS_H, height: 2, background: 'var(--border)', pointerEvents: 'none', zIndex: 3 }} />

                  {/* Horizontal grid lines at 0 / 25 / 50 / 75 / 100 % */}
                  {[0, 0.25, 0.5, 0.75, 1].map(pct => (
                    <div key={pct} style={{ position: 'absolute', left: 0, right: 0, top: SCAT_MS_H + (1 - pct) * SCAT_H, height: 1, background: pct === 0 || pct === 1 ? 'var(--border)' : 'var(--border-subtle)', opacity: pct === 0 || pct === 1 ? 0.9 : 0.6, pointerEvents: 'none', zIndex: 2 }} />
                  ))}

                  {/* Danger zone — before build start, below 50% received */}
                  {bsX > 0 && (
                    <div style={{ position: 'absolute', left: 0, width: bsX, top: SCAT_MS_H + SCAT_H * 0.5, height: SCAT_H * 0.5, background: 'rgba(220,38,38,0.055)', pointerEvents: 'none', zIndex: 1 }}>
                      <span style={{ position: 'absolute', left: 10, bottom: 8, fontSize: 9, fontWeight: 700, color: '#dc262660', letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>⚠ Risk Zone</span>
                    </div>
                  )}

                  {/* 100% "safe" band — top strip */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: SCAT_MS_H, height: SCAT_H * 0.04, background: 'rgba(22,163,74,0.07)', pointerEvents: 'none', zIndex: 1 }} />

                  {/* Milestone chips in milestone band */}
                  {milestones.map(m => {
                    const x = dayToX(m.actualDate);
                    const c = M[m.color] || 'var(--ink-4)';
                    const chipTop = m.row === 0 ? 7 : SCAT_MS_H / 2 + 2;
                    return (
                      <React.Fragment key={m.id}>
                        <div
                          onMouseEnter={e => setHoveredItem({ type: 'milestone', data: m, date: m.actualDate, rect: e.currentTarget.getBoundingClientRect() })}
                          onMouseLeave={() => setHoveredItem(null)}
                          style={{ position: 'absolute', left: x, top: chipTop, transform: 'translateX(-50%)', zIndex: 10, cursor: 'pointer' }}
                        >
                          <div style={{ background: 'var(--bg-raised)', border: `1.5px solid ${c}`, borderRadius: 4, padding: '2px 7px', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', color: c, textTransform: 'uppercase', whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(0,0,0,0.09)' }}>{m.label}</div>
                        </div>
                        <div style={{ position: 'absolute', left: x, top: SCAT_MS_H - 10, transform: 'translate(-50%,-50%) rotate(45deg)', width: 8, height: 8, background: c, border: '2px solid var(--bg-raised)', borderRadius: 1, pointerEvents: 'none', zIndex: 12 }} />
                      </React.Fragment>
                    );
                  })}

                  {/* PO bubbles */}
                  {allEntries.map((entry, i) => {
                    if (!entry.po?.dueDate) return null;
                    const cls   = poReceiptClass(entry.po, now);
                    const { color } = CLS[cls];
                    const parts = (entry.po?.parts || []).filter(p => (p.qty || 0) > 0);
                    const qty   = parts.reduce((s, p) => s + (p.qty || 0), 0);
                    const rcvd  = parts.reduce((s, p) => s + (p.received || 0), 0);
                    const pct   = qty > 0 ? rcvd / qty : (cls === 'green' ? 1 : 0);
                    const r     = Math.max(7, Math.min(20, 5 + Math.sqrt(qty) * 1.6));
                    const cx    = dayToX(new Date(entry.po.dueDate));
                    const cy    = SCAT_MS_H + (1 - pct) * SCAT_H;
                    const isRcvd = cls === 'green';
                    return (
                      <div
                        key={`sc-${i}`}
                        onMouseEnter={e => setHoveredItem({ type: 'threat', data: { date: new Date(entry.po.dueDate), items: [entry], cls }, rect: e.currentTarget.getBoundingClientRect() })}
                        onMouseLeave={() => setHoveredItem(null)}
                        onClick={e => {
                          if (wasDragged.current) { wasDragged.current = false; return; }
                          e.stopPropagation();
                          setHoveredItem(null);
                          setDrawerMarker({ date: new Date(entry.po.dueDate), items: [entry] });
                        }}
                        style={{
                          position: 'absolute',
                          left: cx,
                          top: cy,
                          transform: 'translate(-50%, -50%)',
                          width: r * 2,
                          height: r * 2,
                          borderRadius: '50%',
                          background: `${color}${isRcvd ? '28' : '3a'}`,
                          border: `2px solid ${color}${isRcvd ? '90' : 'dd'}`,
                          cursor: 'pointer',
                          zIndex: 10,
                          boxShadow: `0 1px 4px ${color}40`,
                          transition: 'transform 0.12s, box-shadow 0.12s',
                        }}
                        onMouseOver={e => { e.currentTarget.style.transform = 'translate(-50%,-50%) scale(1.25)'; e.currentTarget.style.boxShadow = `0 2px 10px ${color}70`; }}
                        onMouseOut={e => { e.currentTarget.style.transform = 'translate(-50%,-50%) scale(1)'; e.currentTarget.style.boxShadow = `0 1px 4px ${color}40`; }}
                      >
                        {/* PO id label inside large bubbles */}
                        {r >= 14 && (
                          <span className="mono" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7.5, fontWeight: 800, color, pointerEvents: 'none' }}>
                            {entry.po.poId}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        </div>
      </div>
      </div>
      </div>


      {/* ── Legend ── */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 8, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>Timeline markers:</span>
        {Object.entries(CLS).map(([cls, cfg]) => (
          <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 7, height: 7, background: cfg.color, borderRadius: 1, transform: 'rotate(45deg)', flexShrink: 0 }} />
            <span style={{ fontSize: 8, color: 'var(--ink-4)' }}>{cfg.label}</span>
          </div>
        ))}
        {summary.unscheduled.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 7, height: 7, background: '#9ca3af', borderRadius: 1, transform: 'rotate(45deg)', flexShrink: 0 }} />
            <span style={{ fontSize: 8, color: 'var(--ink-4)' }}>Unscheduled ({summary.unscheduled.length})</span>
          </div>
        )}
        <span style={{ fontSize: 8, color: 'var(--ink-5)', marginLeft: 'auto' }}>{totalPOs} POs total across all categories</span>
      </div>

      {/* ── Hover tooltip — milestones only (diamonds open drawer on click) ── */}
      {hoveredItem && (() => {
        const { type, data, rect, date } = hoveredItem;
        const tipW = 260;
        const useBelow = rect.top < 200;
        const hPos = { left: Math.max(8, Math.min(window.innerWidth - tipW - 8, rect.left + rect.width / 2 - tipW / 2)) };
        const vPos = useBelow ? { top: rect.bottom + 10 } : { bottom: window.innerHeight - rect.top + 10 };
        const base = { position: 'fixed', ...hPos, ...vPos, width: tipW, zIndex: 1000, pointerEvents: 'none', borderRadius: 8, overflow: 'hidden', boxShadow: 'var(--shadow-lg)' };

        if (type === 'milestone') {
          const dft = Math.round((+date - +today) / 86400000);
          return (
            <div style={{ ...base, background: 'var(--bg-raised)', border: '1px solid var(--border)', padding: '11px 14px' }}>
              <div style={{ fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 5, display: 'flex', justifyContent: 'space-between' }}>
                <span>MILESTONE · {fmt(date)}</span>
                <span className={`badge badge-${data.color || 'neutral'}`}>{dft >= 0 ? 'ON TRACK' : 'DELAYED'}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{data.label}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 3 }}>
                {dft >= 0 ? `Target in ${dft} days` : `Delayed by ${Math.abs(dft)} days`}
              </div>
            </div>
          );
        }

        if (type === 'threat') {
          const cfg = CLS[data.cls] || CLS.lightGreen;
          const allP = data.items.flatMap(e => e.po?.parts || []);
          const qty  = allP.reduce((s, p) => s + (p.qty  || 0), 0);
          const rcvd = allP.reduce((s, p) => s + (p.received || 0), 0);
          const pct  = qty > 0 ? Math.round(rcvd / qty * 100) : 0;
          return (
            <div style={{ ...base, background: 'var(--bg-raised)', border: `1px solid ${cfg.color}30`, padding: '10px 13px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)', marginBottom: 3 }}>ETA · {fmt(data.date)}</div>
              <div style={{ fontSize: 10, color: 'var(--ink-4)', marginBottom: 7 }}>
                {data.items.length} PO{data.items.length !== 1 ? 's' : ''} · {data.items.length === 1 ? data.items[0].supplier : `${data.items.length} vendors`}
              </div>
              <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', marginBottom: 5 }}>
                <div style={{ height: '100%', width: `${pct}%`, background: cfg.color, borderRadius: 2 }} />
              </div>
              <div style={{ fontSize: 9.5, color: cfg.color, fontWeight: 700 }}>{pct}% received · click to open</div>
            </div>
          );
        }
        return null;
      })()}

      {/* ── Side drawer — opened by clicking a diamond ── */}
      {drawerMarker && (
        <TimelineDrawer
          marker={drawerMarker}
          buildStart={buildStart}
          onClose={() => setDrawerMarker(null)}
          onDrillDown={onDrillDown}
        />
      )}
    </div>
  );
}

export default TimelineRibbon;
