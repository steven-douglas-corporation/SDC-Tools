// PO Action List — Parts view + Vendor lens
import React, { useState, useMemo, useEffect } from 'react';
import { AssemblyList } from './tab-readiness.jsx';
import {
  IconSearch, IconX, IconCaretRight, IconMail, IconCopy,
  VendorAvatar, StatusBadge,
} from '../primitives.jsx';

// Recursively collect every leaf part from a node tree, tagging each part with
// the nearest assembly's PN and desc so the "Assembly / Source" column is accurate.
function collectAllParts(node, assemblyPN, assemblyDesc) {
  if (!node) return [];
  const own = (node.parts || []).map(p => ({
    ...p,
    parentPN: assemblyPN || node.pn,
    parentDesc: assemblyDesc || node.desc,
  }));
  const nested = (node.children || []).flatMap(child =>
    collectAllParts(child, child.pn, child.desc)
  );
  return [...own, ...nested];
}

function useColResize(initial) {
  const [widths, setWidths] = useState(initial);
  const drag = React.useRef(null);
  const startDrag = (idx, e) => {
    e.preventDefault();
    drag.current = { idx, x: e.clientX, w: widths[idx] };
    const onMove = ev => {
      if (!drag.current) return;
      const { idx, x, w } = drag.current;
      setWidths(prev => { const n = [...prev]; n[idx] = Math.max(40, w + (ev.clientX - x)); return n; });
    };
    const onUp = () => {
      drag.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const template = widths.map(w => `${w}px`).join(' ');
  return { template, startDrag };
}

const ColHandleDark = ({ onMouseDown }) => (
  <div
    onMouseDown={onMouseDown}
    style={{ position: 'absolute', right: 0, top: '15%', bottom: '15%', width: 3, cursor: 'col-resize', zIndex: 1, background: 'rgba(255,255,255,0.3)', opacity: 0.5, borderRadius: 2, transition: 'opacity 0.15s' }}
    onMouseEnter={e => e.currentTarget.style.opacity = '1'}
    onMouseLeave={e => e.currentTarget.style.opacity = '0.5'}
  />
);

function PoTab({ data, highlightPoIds = [], onClearHighlight }) {
  const [view, setView] = useState('assemblies_split');
  const [query, setQuery] = useState('');

  // Vendors have moved to Build Readiness tab — no sub-tab switch needed.
  useEffect(() => {}, [highlightPoIds]);

  const lateCount = (data.poActions?.critical?.length || 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, height: '100%', overflow: 'hidden' }}>
      {/* Header section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--fg-0)', margin: 0, letterSpacing: '-0.02em' }}>Procurement</h1>
          <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 4 }}>
            Proactive procurement view · {data.procurement?.available ? data.procurement.risk.noPo.partCount : data.nopo.length} parts with no PO · {lateCount} POs running late
          </div>
        </div>
        <div className="search" style={{ width: 240, height: 32 }}>
          <IconSearch size={14}/>
          <input
            style={{ fontSize: 12 }}
            placeholder="Search POs, parts, vendors..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--fg-3)', display: 'flex', alignItems: 'center' }}
            >
              <IconX size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 32, borderBottom: '1px solid var(--border-soft)', paddingBottom: 0 }}>
        {[
          { id: 'assemblies_split', label: 'Assemblies',    count: data.job.kpis.assemblies },
          { id: 'parts',            label: 'Parts List',     count: data.readiness.reduce((s, spec) => s + (spec.lines || 0), 0) },
          { id: 'emails',           label: 'Vendor Emails',  count: data.emails?.length || 0 },
        ].map(v => (
          <button key={v.id} onClick={() => setView(v.id)} style={{
            padding: '12px 4px', fontSize: 13, fontWeight: view === v.id ? 600 : 500,
            color: view === v.id ? 'var(--sdc-blue)' : 'var(--fg-2)',
            border: 0, borderBottom: `2px solid ${view === v.id ? 'var(--sdc-blue)' : 'transparent'}`,
            background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
            transition: 'all 0.2s', marginBottom: -1
          }}>
            {v.label} <span style={{
              fontSize: 10,
              background: view === v.id ? (v.alert ? 'rgba(220,38,38,0.12)' : 'var(--sdc-blue-soft)') : (v.alert ? 'rgba(220,38,38,0.08)' : 'var(--bg-3)'),
              color: view === v.id ? (v.alert ? '#dc2626' : 'var(--sdc-blue)') : (v.alert ? '#dc2626' : 'var(--fg-3)'),
              padding: '1px 6px', borderRadius: 4, fontWeight: 600
            }}>{v.count}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--fg-3)', fontStyle: 'italic' }}>Click any part number to copy</span>
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div className="panel" style={{ height: '100%', overflow: 'auto', background: 'var(--bg-1)', border: '1px solid var(--border-soft)' }}>
          {view === 'parts'   && <PartsFlatView parts={data.readiness.flatMap(s => s.assemblies.flatMap(a => collectAllParts(a.node, a.code || a.pn, a.desc)))} query={query} job={data.job}/>}
          {view === 'emails'  && <EmailsPanel emails={data.emails || []} job={data.job}/>}
          {view === 'assemblies_split' && <AssemblyList data={data} query={query} setQuery={setQuery} />}
        </div>
      </div>
    </div>
  );
}

function PartsFlatView({ parts, query, job }) {
  const [copiedPn, setCopiedPn] = React.useState(null);
  const col = useColResize([120, 220, 155, 45, 55, 130, 75, 75, 75, 82]);

  const HDRS = ['Part Number', 'Description', 'Assembly / Source', 'Qty', 'Unit $', 'Manufacturer', 'PO #', 'Order Date', 'Exp Date', 'Status'];
  const RIGHT_COLS = new Set([3, 4, 9]);

  const copyPn = (pn) => {
    navigator.clipboard?.writeText(pn).catch(() => {});
    setCopiedPn(pn);
    setTimeout(() => setCopiedPn(null), 1500);
  };

  const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

  const filtered = parts.filter(p => {
    if (!query) return true;
    const q = query.toLowerCase();
    const poNum = p.pos?.[0]?.poId || '';
    return String(p.pn || p.id).toLowerCase().includes(q) ||
           (p.desc || '').toLowerCase().includes(q) ||
           String(poNum).toLowerCase().includes(q) ||
           (p.parentPN || '').toLowerCase().includes(q) ||
           (p.parentDesc || '').toLowerCase().includes(q);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        display: 'grid', gridTemplateColumns: col.template,
        padding: '6px 10px', gap: 8,
        background: 'var(--ink)', color: '#fff',
        borderBottom: '1px solid var(--border-soft)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        {HDRS.map((lbl, i) => (
          <div key={i} className="eyebrow" style={{ position: 'relative', overflow: 'hidden', fontSize: 9, color: 'rgba(255,255,255,0.7)', textAlign: RIGHT_COLS.has(i) ? 'right' : 'left' }}>
            {lbl}
            <ColHandleDark onMouseDown={e => col.startDrag(i, e)} />
          </div>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.map((p, i) => {
          const today = new Date();
          const reqDateStr = p.requiredDate || (job && job.buildStart);
          const req = reqDateStr ? new Date(reqDateStr) : null;
          const diff = req ? Math.ceil((req - today) / 86400000) : null;

          let urgency = 'long';
          if (diff !== null) {
            if (diff < 0) urgency = 'overdue';
            else if (diff <= 14) urgency = 'soon';
          }

          const u = {
            overdue: { cls: 'threat',   label: 'OVERDUE',  sub: diff !== null ? `${Math.abs(diff)}d Late` : 'Past Due' },
            soon:    { cls: 'pending',  label: 'DUE SOON', sub: `In ${diff}d` },
            long:    { cls: 'blue',     label: 'FUTURE',   sub: diff !== null ? (p.requiredDate ? `In ${diff}d` : `Est In ${diff}d`) : 'TBD' },
          }[urgency];

          const unitPrice = p.unitPrice || 0;
          const po0 = p.pos?.[0];

          return (
            <div key={i} className="row-hover" style={{
              display: 'grid', gridTemplateColumns: col.template,
              padding: '2px 10px', gap: 8, alignItems: 'center',
              borderBottom: '1px solid var(--border-subtle)',
              background: urgency === 'overdue' && p.status !== 'received' ? 'var(--threat-soft)' : 'transparent',
            }}>
              <span className="mono" title="Click to copy" onClick={() => copyPn(p.pn || p.id)}
                style={{ fontSize: 10, fontWeight: 800, color: copiedPn === (p.pn || p.id) ? 'var(--ready-ink)' : 'var(--sdc-blue)', cursor: 'pointer', transition: 'color 0.2s', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {copiedPn === (p.pn || p.id) ? '✓ Copied' : (p.pn || p.id)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--fg-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.desc}</span>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.1 }}>{p.parentPN || 'LOOSE'}</span>
                <span style={{ fontSize: 9, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.1 }}>{p.parentDesc || p.assemblyDesc || 'Loose Parts'}</span>
              </div>
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-1)', textAlign: 'right' }}>{p.qty}</span>
              <span className="mono tnum" style={{ fontSize: 10, textAlign: 'right', color: unitPrice > 0 ? 'var(--fg-1)' : 'var(--fg-4)' }}>
                {unitPrice > 0 ? `$${unitPrice >= 1000 ? (unitPrice / 1000).toFixed(1) + 'K' : unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                <VendorAvatar vendor={p.manufacturer || 'SDC'} size={14} />
                <span style={{ fontSize: 10, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.manufacturer === 'SDC' ? 'In-house (SDC)' : (p.manufacturer || 'SDC')}
                </span>
              </div>
              <span className="mono" style={{ fontSize: 10, color: po0?.poId ? 'var(--sdc-blue)' : 'var(--fg-4)', fontWeight: po0?.poId ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {po0?.poId || 'NO PO'}
              </span>
              <span className="mono" style={{ fontSize: 10, color: po0?.poDate ? 'var(--fg-2)' : 'var(--fg-4)', whiteSpace: 'nowrap' }}>
                {fmtDate(po0?.poDate)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: po0?.dueDate ? (new Date(po0.dueDate) < today && p.status !== 'received' ? 'var(--threat)' : 'var(--fg-2)') : 'var(--fg-4)', fontWeight: po0?.dueDate ? 600 : 400, whiteSpace: 'nowrap' }}>
                {fmtDate(po0?.dueDate)}
              </span>
              <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                <span className={`badge badge-${p.status === 'received' ? 'ready' : u.cls}`} style={{ fontSize: 7, padding: '1px 3px', lineHeight: 1 }}>{p.status === 'received' ? 'RECEIVED' : u.label}</span>
                <span style={{ fontSize: 8, color: 'var(--fg-3)', fontWeight: 600, lineHeight: 1 }}>
                  {p.status === 'received' ? (p.receivedDate ? new Date(p.receivedDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Delivered') : u.sub}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PoDrawer({ po, supplier, onClose }) {
  const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const poRcvd = po.parts.filter(p => p.received >= p.qty).length;
  const poLines = po.parts.length;
  const pct = poLines > 0 ? Math.round((poRcvd / poLines) * 100) : 0;
  const poStatus = poRcvd === poLines ? 'RECEIVED' : (po.worstDays < 0 ? 'PAST DUE' : po.worstDays <= 14 ? 'LATE/EXP' : 'OPEN');
  const dueDate = po.worstDays != null ? new Date(Date.now() + po.worstDays * 86400000) : null;
  const totalValue = po.parts.reduce((s, p) => s + (p.price > 0 ? p.price * p.qty : 0), 0);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, backdropFilter: 'blur(2px)' }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 580,
        background: 'var(--bg-raised)', boxShadow: '-8px 0 48px rgba(0,0,0,0.22)',
        zIndex: 301, display: 'flex', flexDirection: 'column',
        animation: 'slideInRight 0.22s cubic-bezier(0.4,0,0.2,1)',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-raised)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <VendorAvatar vendor={supplier} size={40} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{supplier}</div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>PO #{po.poId}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <StatusBadge status={poStatus} />
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 4, display: 'flex', alignItems: 'center', borderRadius: 4 }}>
                <IconX size={18} />
              </button>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: 'flex', gap: 24, alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 9, color: 'var(--fg-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Ordered</div>
              <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-1)' }}>{fmtDate(po.poDate)}</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--fg-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Due</div>
              <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: po.worstDays < 0 ? 'var(--threat)' : 'var(--fg-1)' }}>
                {dueDate ? dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
              </div>
            </div>
            {totalValue > 0 && (
              <div>
                <div style={{ fontSize: 9, color: 'var(--fg-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>PO Value</div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-1)' }}>
                  ${totalValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </div>
              </div>
            )}
            <div style={{ marginLeft: 'auto', minWidth: 120 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>{poRcvd}/{poLines} received</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-1)' }}>{pct}%</span>
              </div>
              <div className="bar-track" style={{ height: 6 }}>
                <div className="bar-fill" style={{ width: `${pct}%`, background: pct === 100 ? 'var(--ready)' : (po.worstDays < 0 ? 'var(--threat)' : 'var(--sdc-blue)') }} />
              </div>
            </div>
          </div>
        </div>

        {/* Parts table */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 36px 76px 76px 100px 58px',
            padding: '8px 24px', gap: 10,
            background: 'var(--ink)', color: '#fff',
            position: 'sticky', top: 0, zIndex: 2,
          }}>
            {['Part', 'Qty', 'Ordered', 'Expected', 'Received', 'Price'].map((h, i) => (
              <span key={i} className="eyebrow" style={{ fontSize: 9, color: 'rgba(255,255,255,0.65)', textAlign: i > 0 ? 'right' : 'left' }}>{h}</span>
            ))}
          </div>

          {po.parts.map((p, i) => {
            const isRcvd = !!(p.receivedDate || p.received >= p.qty);
            const expectedDate = p.expectedDate || p.dueDate;
            return (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr 36px 76px 76px 100px 58px',
                padding: '10px 24px', gap: 10, alignItems: 'center',
                borderBottom: '1px solid var(--border-subtle)',
                background: isRcvd ? 'rgba(22,163,74,0.04)' : 'transparent',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg-0)', wordBreak: 'break-all' }}>{p.partNumber || '—'}</div>
                  {p.partDesc && <div style={{ fontSize: 10, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{p.partDesc}</div>}
                </div>
                <span className="mono" style={{ fontSize: 12, color: 'var(--fg-1)', textAlign: 'right' }}>{p.qty}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right' }}>{fmtDate(po.poDate)}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right' }}>{fmtDate(expectedDate)}</span>
                {/* Received: actual date if yes, expected date in amber if not yet */}
                <div style={{ textAlign: 'right' }}>
                  {isRcvd ? (
                    <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ready-ink)' }}>✓ {fmtDate(p.receivedDate)}</span>
                  ) : expectedDate ? (
                    <span className="mono" style={{ fontSize: 10, color: '#b45309', fontWeight: 600 }}>Exp {fmtDate(expectedDate)}</span>
                  ) : (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>—</span>
                  )}
                </div>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', textAlign: 'right' }}>
                  {p.price > 0 ? `$${Number(p.price).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', background: 'var(--bg)', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button className="sdc-btn sdc-btn--secondary" onClick={onClose} style={{ fontSize: 13, padding: '7px 18px' }}>Close</button>
        </div>
      </div>
    </>
  );
}

function VendorCard({ v, highlightPoIds, onPoClick, isHighlighted }) {
  const totalPOs = v.pos.length;
  const totalLines = v.pos.reduce((sum, po) => sum + po.parts.length, 0);
  const rcvdLines = v.pos.reduce((sum, po) => sum + po.parts.filter(p => p.received >= p.qty).length, 0);
  const pct = totalLines > 0 ? Math.round((rcvdLines / totalLines) * 100) : 0;
  const status = rcvdLines === totalLines ? 'RECEIVED' : (v.worstDays < 0 ? 'PAST DUE' : v.worstDays <= 14 ? 'LATE/EXP' : 'OPEN');

  return (
    <div className={`vendor-card fade-in ${isHighlighted ? 'highlighted' : ''}`}>
      <div className="vendor-card-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <VendorAvatar vendor={v.supplier} size={28} />
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, margin: 0, color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.supplier}</h3>
              <div style={{ fontSize: 10, color: 'var(--fg-3)', display: 'flex', gap: 6, marginTop: 1 }}>
                <span>{totalPOs} PO{totalPOs !== 1 ? 's' : ''}</span>
                <span>•</span>
                <span>{totalLines} Items</span>
              </div>
            </div>
          </div>
          <StatusBadge status={status} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="bar-track" style={{ flex: 1, height: 6 }}>
            <div className="bar-fill" style={{ width: `${pct}%`, background: pct === 100 ? 'var(--ready)' : (v.worstDays < 0 ? 'var(--threat)' : 'var(--sdc-blue)') }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg-1)', minWidth: 32 }}>{pct}%</span>
        </div>
      </div>

      <div className="vendor-card-body">
        {v.pos.map((po, pi) => {
          const poRcvd = po.parts.filter(p => p.received >= p.qty).length;
          const poLines = po.parts.length;
          const poStatus = poRcvd === poLines ? 'RECEIVED' : (po.worstDays < 0 ? 'PAST DUE' : po.worstDays <= 14 ? 'LATE/EXP' : 'OPEN');
          const poHighlight = highlightPoIds.includes(po.poId);

          return (
            <div
              key={pi}
              onClick={() => onPoClick(po)}
              className="po-item"
              style={{ borderLeft: poHighlight ? '3px solid var(--sdc-blue)' : 'none', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconCaretRight size={10} style={{ color: 'var(--fg-4)' }} />
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: poHighlight ? 'var(--sdc-blue)' : 'var(--fg-1)' }}>{po.poId}</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--fg-3)', fontWeight: 500 }}>{poRcvd}/{poLines} rcvd</div>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: poStatus === 'RECEIVED' ? 'var(--ready)' : (poStatus === 'PAST DUE' ? 'var(--threat)' : 'var(--pending)') }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PoTracker({ poActions, query, highlightPoIds = [], onClearHighlight }) {
  const [drawerData, setDrawerData] = useState(null); // { po, supplier }

  const allPos = useMemo(() => {
    const list = [
      ...(poActions?.critical || []),
      ...(poActions?.warning || []),
      ...(poActions?.onTrack || []),
      ...(poActions?.delivered || [])
    ];
    return list.filter(entry => {
      if (!query) return true;
      const q = query.toLowerCase();
      return String(entry.supplier || '').toLowerCase().includes(q) ||
             String(entry.po?.poId || '').toLowerCase().includes(q) ||
             (entry.po?.parts || []).some(p => String(p.partNumber || '').toLowerCase().includes(q) || String(p.partDesc || '').toLowerCase().includes(q));
    });
  }, [poActions, query]);

  const vendorGroups = useMemo(() => {
    const vMap = {};
    allPos.forEach(entry => {
      if (!vMap[entry.supplier]) {
        vMap[entry.supplier] = {
          supplier: entry.supplier,
          email: entry.email,
          worstDays: entry.worstDays,
          pos: []
        };
      }
      vMap[entry.supplier].pos.push({ ...entry.po, worstDays: entry.worstDays });
      if (entry.worstDays < vMap[entry.supplier].worstDays) {
        vMap[entry.supplier].worstDays = entry.worstDays;
      }
    });
    const priority = (v) => {
      const total = v.pos.reduce((s, po) => s + po.parts.length, 0);
      const rcvd  = v.pos.reduce((s, po) => s + po.parts.filter(p => p.received >= p.qty).length, 0);
      if (rcvd === total) return 3;   // RECEIVED
      if (v.worstDays < 0) return 0;  // PAST DUE
      if (v.worstDays <= 14) return 1; // LATE/EXP
      return 2;                        // OPEN
    };
    return Object.values(vMap).sort((a, b) => {
      const pa = priority(a), pb = priority(b);
      if (pa !== pb) return pa - pb;
      if (pa === 3) return a.supplier.localeCompare(b.supplier); // received: A-Z
      return a.worstDays - b.worstDays; // others: most overdue first
    });
  }, [allPos]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-sunken)' }}>
      {drawerData && (
        <PoDrawer po={drawerData.po} supplier={drawerData.supplier} onClose={() => setDrawerData(null)} />
      )}
      {highlightPoIds.length > 0 && (
        <div style={{ padding: '8px 20px', background: 'var(--sdc-blue-soft)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--sdc-blue-ink)' }}>
            Showing {highlightPoIds.length} PO{highlightPoIds.length !== 1 ? 's' : ''} from Schedule Health timeline
          </span>
          <button onClick={() => { onClearHighlight && onClearHighlight(); }} style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--sdc-blue-ink)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
            Clear filter ×
          </button>
        </div>
      )}

      <div className="vendor-grid">
        {vendorGroups.map((v, vi) => (
          <VendorCard
            key={vi}
            v={v}
            highlightPoIds={highlightPoIds}
            onPoClick={po => setDrawerData({ po, supplier: v.supplier })}
            isHighlighted={v.pos.some(po => highlightPoIds.includes(po.poId))}
          />
        ))}
        {vendorGroups.length === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: 80, textAlign: 'center', color: 'var(--fg-3)' }}>
            No vendors found matching "{query}"
          </div>
        )}
      </div>
    </div>
  );
}


// ── Email helpers ────────────────────────────────────────────────────────────
function buildEmailBody(e, job) {
  return `Subject: SDC Job ${job?.id || ''} — Expedite Request\n\n${e.vendor} Procurement Team,\n\nReference: SDC Job ${job?.id || ''} (${job?.name || ''})\nBuild Start (firm baseline): ${job?.buildStart || ''}\n\nWe have ${e.pos} open purchase order${e.pos > 1 ? 's' : ''} with promised dates that conflict with our firm build start. Please confirm whether expedite is achievable, and provide updated promise dates within 48 hours.\n\nIf expedite is not feasible, please propose alternates. We can split-ship partial qtys against the build start date.\n\nRegards,\n${job?.buyer || 'Procurement'}\nProcurement, Stevens Design & Controls`;
}

function copyToClipboard(text, onDone) {
  navigator.clipboard.writeText(text).then(() => { if (onDone) onDone(); });
}

function EmailRow({ e, job, open, onToggle }) {
  const [copied, setCopied] = useState(false);
  const body = buildEmailBody(e, job);
  const onCopy = ev => { ev.stopPropagation(); copyToClipboard(body, () => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  return (
    <div style={{ borderBottom: '1px solid var(--border-soft)' }}>
      <div className="row-hover" onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: '3px 40px 1.5fr 1fr auto auto', gap: 16, padding: '12px 20px', alignItems: 'center', cursor: 'pointer' }}>
        <div style={{ width: 3, height: 40, borderRadius: 1.5, background: e.overdue ? 'var(--threat)' : 'var(--sdc-blue)' }}/>
        <VendorAvatar vendor={e.vendor} size={30} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-0)' }}>{e.vendor}</span>
            {e.overdue && <StatusBadge status="OVERDUE" />}
          </div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>{e.pos} PO{e.pos > 1 ? 's' : ''}</span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: e.contacts?.length ? 'var(--fg-3)' : 'var(--threat)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {e.contacts?.length ? e.contacts.join(', ') : 'No contact email in ERP'}
        </span>
        <button className="sdc-btn sdc-btn--secondary" onClick={ev => { ev.stopPropagation(); onToggle(); }} style={{ padding: '4px 10px', fontSize: 11, gap: 4 }}>
          <IconMail size={12} /> {open ? 'Close' : 'Preview'}
        </button>
        <button className="sdc-btn sdc-btn--secondary" onClick={onCopy} style={{ padding: '4px 10px', fontSize: 11, gap: 4 }}>
          <IconCopy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {open && (
        <div style={{ padding: '0 20px 20px 59px', display: 'grid', gap: 12 }} className="fade-in">
          <div style={{ background: 'var(--bg-3)', border: '1px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-1)', fontSize: 11, fontWeight: 600, color: 'var(--fg-2)', display: 'flex', justifyContent: 'space-between' }}>
              <span>Email Draft</span>
              <span className="mono" style={{ fontWeight: 400 }}>Expedite Request — Job {job?.id}</span>
            </div>
            <pre className="mono" style={{ margin: 0, padding: 16, fontSize: 12, lineHeight: 1.6, color: 'var(--fg-1)', whiteSpace: 'pre-wrap', background: 'transparent' }}>{body}</pre>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="sdc-btn sdc-btn--secondary" onClick={onCopy}><IconCopy size={14} /> {copied ? 'Copied to Clipboard' : 'Copy Email Body'}</button>
            <a href={`mailto:${(e.contacts || []).join(',')}?subject=${encodeURIComponent(`SDC Job ${job?.id || ''} — Expedite Request`)}&body=${encodeURIComponent(body)}`}
               className="sdc-btn sdc-btn--primary" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', fontSize: 13, borderRadius: 6 }}
               onClick={ev => ev.stopPropagation()}>
              <IconMail size={14} stroke="white" /> Open in Mail Client
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function EmailsPanel({ emails, job }) {
  const [open, setOpen] = useState(null);
  const [copied, setCopied] = useState(null);
  const overdueCount = emails.filter(e => e.overdue).length;
  const onCopyAll = () => {
    const all = emails.map(e => buildEmailBody(e, job)).join('\n\n' + '─'.repeat(60) + '\n\n');
    copyToClipboard(all, () => { setCopied('all'); setTimeout(() => setCopied(null), 2000); });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 20px', background: 'var(--bg-2)', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-2)', flex: 1 }}>
          {emails.length} supplier follow-ups ready · <span style={{ color: 'var(--threat-ink)', fontWeight: 600 }}>{overdueCount} overdue</span> · auto-drafted from open POs
        </span>
        <button className="sdc-btn sdc-btn--secondary" onClick={onCopyAll} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', fontSize: 12 }}>
          <IconCopy size={13}/> {copied === 'all' ? 'Copied' : 'Copy All'}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {emails.map((e, i) => (
          <EmailRow key={i} e={e} job={job} open={open === i} onToggle={() => setOpen(open === i ? null : i)}/>
        ))}
        {emails.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>No vendor emails to draft.</div>}
      </div>
    </div>
  );
}

export { PoTracker, VendorCard };
export default PoTab;
