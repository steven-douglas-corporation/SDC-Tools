/**
 * MachineConfigEditor - Machine type, station layout, and SM association.
 * Features a visual representation (dial, linear, etc.) of the station layout.
 */

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useDiagramStore } from '../store/useDiagramStore.js';

// ── Mini SVG icons for machine type cards ───────────────────────────────────
function MiniDialIcon({ active }) {
  const c = '#1574C4';
  const bg = active ? '#dbeafe' : '#e0f2fe';
  return (
    <svg viewBox="0 0 48 48" width="40" height="40">
      <circle cx="24" cy="24" r="20" fill="none" stroke={bg} strokeWidth="2" />
      <circle cx="24" cy="24" r="5" fill={bg} stroke={c} strokeWidth="1" />
      {Array.from({ length: 10 }).map((_, i) => {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const x = 24 + 16 * Math.cos(a);
        const y = 24 + 16 * Math.sin(a);
        return <circle key={i} cx={x} cy={y} r="3" fill={c} opacity={0.8} />;
      })}
    </svg>
  );
}

function MiniLinearIcon({ active }) {
  const c = '#1574C4';
  const bg = active ? '#dbeafe' : '#e0f2fe';
  return (
    <svg viewBox="0 0 56 32" width="48" height="28">
      <line x1="4" y1="16" x2="52" y2="16" stroke={bg} strokeWidth="2.5" strokeLinecap="round" />
      <polygon points="52,16 48,12 48,20" fill={c} opacity={0.5} />
      {Array.from({ length: 5 }).map((_, i) => {
        const x = 6 + i * 10;
        return <rect key={i} x={x} y="9" width="8" height="14" rx="2" fill={c} opacity={0.8} />;
      })}
    </svg>
  );
}

function MiniRobotCellIcon({ active }) {
  const c = '#7c3aed';
  const bg = active ? '#ede9fe' : '#f5f3ff';
  return (
    <svg viewBox="0 0 48 48" width="40" height="40">
      {/* Base pedestal */}
      <rect x="10" y="38" width="16" height="6" rx="2" fill={c} opacity={0.7} />
      <rect x="14" y="34" width="8" height="5" rx="1" fill={c} opacity={0.5} />
      {/* Robot body / J1 */}
      <rect x="15" y="26" width="6" height="9" rx="2" fill={c} opacity={0.8} />
      {/* Upper arm / J2 */}
      <line x1="18" y1="26" x2="18" y2="14" stroke={c} strokeWidth="3" strokeLinecap="round" />
      {/* Elbow joint */}
      <circle cx="18" cy="14" r="2.5" fill={bg} stroke={c} strokeWidth="1.5" />
      {/* Forearm / J3 */}
      <line x1="18" y1="14" x2="32" y2="10" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      {/* Wrist joint */}
      <circle cx="32" cy="10" r="2" fill={bg} stroke={c} strokeWidth="1.5" />
      {/* End effector / gripper */}
      <line x1="32" y1="10" x2="38" y2="7" stroke={c} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="5" x2="38" y2="9" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
      {/* Peripheral stations */}
      {[[38, 22], [38, 34], [42, 42]].map(([x, y], i) => (
        <rect key={i} x={x - 3} y={y - 3} width="7" height="5" rx="1.5" fill={c} opacity={0.5} />
      ))}
    </svg>
  );
}

function MiniTestIcon({ active }) {
  const c = '#d97706';
  const bg = active ? '#fde68a' : '#fef3c7';
  return (
    <svg viewBox="0 0 48 48" width="40" height="40">
      {/* Camera mount arm */}
      <line x1="8" y1="40" x2="8" y2="18" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="8" y1="18" x2="22" y2="12" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      {/* Camera body */}
      <rect x="20" y="6" width="16" height="12" rx="2" fill={bg} stroke={c} strokeWidth="2" />
      {/* Camera lens */}
      <circle cx="28" cy="12" r="4" fill="none" stroke={c} strokeWidth="1.5" />
      <circle cx="28" cy="12" r="1.5" fill={c} opacity={0.6} />
      {/* LED ring */}
      <circle cx="28" cy="12" r="6" fill="none" stroke={c} strokeWidth="0.8" strokeDasharray="2 2" opacity={0.5} />
      {/* Light cone / FOV */}
      <path d="M22,18 L16,34 L40,34 L34,18" fill={c} opacity={0.1} stroke={c} strokeWidth="0.8" strokeDasharray="3 2" />
      {/* Part on conveyor */}
      <rect x="18" y="36" width="20" height="4" rx="1" fill={c} opacity={0.4} />
      <rect x="24" y="32" width="8" height="4" rx="1" fill={c} opacity={0.6} />
      {/* Mount base */}
      <rect x="4" y="40" width="8" height="4" rx="1" fill={c} opacity={0.6} />
    </svg>
  );
}

function MiniCustomIcon({ active }) {
  const c = '#64748b';
  return (
    <svg viewBox="0 0 48 48" width="40" height="40">
      {/* Gear */}
      <circle cx="24" cy="24" r="8" fill="none" stroke={c} strokeWidth="2" />
      <circle cx="24" cy="24" r="3" fill={c} opacity={0.4} />
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i / 8) * Math.PI * 2;
        const x1 = 24 + 10 * Math.cos(a);
        const y1 = 24 + 10 * Math.sin(a);
        const x2 = 24 + 14 * Math.cos(a);
        const y2 = 24 + 14 * Math.sin(a);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth="3" strokeLinecap="round" />;
      })}
    </svg>
  );
}

const MACHINE_TYPE_ICONS = {
  indexing: MiniDialIcon,
  linear: MiniLinearIcon,
  robotCell: MiniRobotCellIcon,
  testInspect: MiniTestIcon,
  custom: MiniCustomIcon,
};

const MACHINE_TYPES = [
  { id: 'indexing', label: 'Indexing Dial', description: 'Rotary indexing table with stations around the perimeter' },
  { id: 'linear', label: 'Linear Indexing', description: 'Parts move linearly from station to station' },
  { id: 'robotCell', label: 'Robot Cell', description: 'Robot-centric processing cell with peripheral stations' },
  { id: 'testInspect', label: 'Test & Inspection', description: 'Testing and inspection machine with verify stations' },
  { id: 'custom', label: 'Custom', description: 'Custom machine layout' },
];

const STATION_TYPES = [
  { id: 'load', label: 'Load', color: '#1574C4' },
  { id: 'process', label: 'Process', color: '#7B2D8E' },
  { id: 'verify', label: 'Verify', color: '#E8A317' },
  { id: 'reject', label: 'Reject', color: '#DC2626' },
  { id: 'unload', label: 'Unload', color: '#5BB0D8' },
  { id: 'empty', label: 'Empty', color: '#94a3b8' },
];

// ── Visual Dial Layout (zoomable + pannable) ───────────────────────────────
function DialVisual({ stations, selectedId, onSelectStation, sms }) {
  const count = stations.length;

  // Scale radius so stations never overlap
  const stationR = 28;
  const minGap = 14;
  const minCircumference = count * (stationR * 2 + minGap);
  const r = Math.max(120, minCircumference / (2 * Math.PI));
  const fullSize = (r + stationR + 20) * 2;
  const cx = fullSize / 2, cy = fullSize / 2;

  // ── Zoom + Pan via viewBox ────────────────────────────────────────────────
  // viewBox = (vbX, vbY, vbW, vbH) — zoom changes vbW/vbH, pan changes vbX/vbY
  const containerRef = useRef(null);
  const [vb, setVb] = useState({ x: 0, y: 0, w: fullSize, h: fullSize });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, origVb: null });
  const [focused, setFocused] = useState(false); // only capture scroll when clicked inside

  // Keep viewBox in sync when station count changes dial size
  const prevSize = useRef(fullSize);
  useEffect(() => {
    if (prevSize.current !== fullSize) {
      setVb({ x: 0, y: 0, w: fullSize, h: fullSize });
      prevSize.current = fullSize;
    }
  }, [fullSize]);

  function getZoomPct() { return Math.round((fullSize / vb.w) * 100); }

  const fullSizeRef = useRef(fullSize);
  fullSizeRef.current = fullSize;

  const zoomBy = useCallback((factor) => {
    setVb(v => {
      const fs = fullSizeRef.current;
      const newW = Math.max(fs * 0.05, Math.min(fs * 3, v.w / factor));
      const newH = newW; // keep square
      // Zoom toward center of current view
      const cx2 = v.x + v.w / 2;
      const cy2 = v.y + v.h / 2;
      return { x: cx2 - newW / 2, y: cy2 - newH / 2, w: newW, h: newH };
    });
  }, []);

  const fitToView = useCallback(() => {
    setVb({ x: 0, y: 0, w: fullSizeRef.current, h: fullSizeRef.current });
  }, []);

  function handleMouseDown(e) {
    if (e.target.closest('.station-click') || e.target.closest('.dial-zoom-btn')) return;
    e.preventDefault();
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, origVb: { ...vb } };
    // Listen on document so release always fires even if pointer leaves the container
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }
  function handleMouseMove(e) {
    const d = dragRef.current;
    if (!d.active) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Convert pixel drag distance to SVG coordinate distance (separate X/Y scales)
    const scaleX = d.origVb.w / rect.width;
    const scaleY = d.origVb.h / rect.height;
    const dx = (e.clientX - d.startX) * scaleX;
    const dy = (e.clientY - d.startY) * scaleY;
    setVb({ ...d.origVb, x: d.origVb.x - dx, y: d.origVb.y - dy });
  }
  function handleMouseUp() {
    dragRef.current.active = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }

  // Wheel zoom — only active when user has clicked inside the dial area
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => {
      if (!focusedRef.current) return; // let page scroll normally
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const rect = el.getBoundingClientRect();
      setVb(v => {
        const fs = fullSizeRef.current;
        const newW = Math.max(fs * 0.05, Math.min(fs * 3, v.w / factor));
        const newH = newW;
        const mx = (e.clientX - rect.left) / rect.width;
        const my = (e.clientY - rect.top) / rect.height;
        const svgX = v.x + v.w * mx;
        const svgY = v.y + v.h * my;
        return { x: svgX - newW * mx, y: svgY - newH * my, w: newW, h: newH };
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // Click inside → focus (enable scroll-zoom); click outside → blur
  useEffect(() => {
    function handleDocClick(e) {
      const el = containerRef.current;
      if (!el) return;
      setFocused(el.contains(e.target));
    }
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, []);

  // Every hook above must run on every render (0 -> 1 stations previously threw
  // "Rendered more hooks than during the previous render"); bail out only now.
  if (count === 0) return <div className="machine-visual__empty">Add stations to see dial layout</div>;

  const btnStyle = { width: 32, height: 32, borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 18, fontWeight: 700, color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center' };

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', userSelect: 'none', cursor: dragRef.current.active ? 'grabbing' : 'grab', outline: focused ? '2px solid #1574C4' : 'none', borderRadius: 8 }}
      onMouseDown={handleMouseDown}
    >
      {/* Zoom controls */}
      <div className="dial-zoom-btn" style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 5 }}>
        <button onClick={(e) => { e.stopPropagation(); zoomBy(1.4); }} style={btnStyle}>+</button>
        <button onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.4); }} style={btnStyle}>−</button>
        <button onClick={(e) => { e.stopPropagation(); fitToView(); }} title="Fit to view"
          style={{ ...btnStyle, fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>⊙</button>
      </div>
      <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 11, color: '#94a3b8', zIndex: 5, pointerEvents: 'none' }}>
        {getZoomPct()}% — scroll to zoom, drag to pan
      </div>
      <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} className="machine-visual__svg machine-visual__svg--dial"
        preserveAspectRatio="xMidYMid meet">
        {/* Dial ring */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="6 4" />
        <circle cx={cx} cy={cy} r={28} fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.5" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fill="#64748b" fontWeight="600">INDEX</text>

        {/* Direction arrow */}
        <path d={`M ${cx + r + 12} ${cy - 20} A ${r + 12} ${r + 12} 0 0 1 ${cx + r + 12} ${cy + 20}`}
          fill="none" stroke="#94a3b8" strokeWidth="1.5" markerEnd="url(#arrowhead)" />
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto">
            <polygon points="0 0, 6 2.5, 0 5" fill="#94a3b8" />
          </marker>
        </defs>

        {stations.map((st, i) => {
          const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
          const x = cx + r * Math.cos(angle);
          const y = cy + r * Math.sin(angle);
          const stType = STATION_TYPES.find(t => t.id === st.type) ?? STATION_TYPES[0];
          const isSelected = st.id === selectedId;
          const linkedSms = (st.smIds ?? []).map(id => sms.find(s => s.id === id)).filter(Boolean);

          return (
            <g key={st.id} className="station-click" onClick={(e) => { e.stopPropagation(); onSelectStation(st.id); }} style={{ cursor: 'pointer' }}>
              <circle
                cx={x} cy={y} r={stationR}
                fill={isSelected ? stType.color : stType.color + '30'}
                stroke={stType.color}
                strokeWidth={isSelected ? 3 : 2}
              />
              <text x={x} y={y - 4} textAnchor="middle" fontSize="11" fontWeight="700"
                fill={isSelected ? '#fff' : '#1e293b'}>
                S{String(st.number).padStart(2, '0')}
              </text>
              <text x={x} y={y + 8} textAnchor="middle" fontSize="7"
                fill={isSelected ? '#fff' : '#475569'}>
                {(st.name ?? '').substring(0, 10)}
              </text>
              {linkedSms.length > 0 && (
                <circle cx={x + stationR - 4} cy={y - stationR + 4} r={7} fill="#befa4f" stroke="#1574C4" strokeWidth="1" />
              )}
              {linkedSms.length > 0 && (
                <text x={x + stationR - 4} y={y - stationR + 7} textAnchor="middle" fontSize="8" fontWeight="700" fill="#1574C4">
                  {linkedSms.length}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Visual Linear Layout ────────────────────────────────────────────────────
function LinearVisual({ stations, selectedId, onSelectStation, sms }) {
  const count = stations.length;
  if (count === 0) return <div className="machine-visual__empty">Add stations to see linear layout</div>;

  return (
    <div className="linear-visual">
      <div className="linear-visual__track">
        <div className="linear-visual__line" />
        <div className="linear-visual__arrow" />
      </div>
      <div className="linear-visual__stations" style={{ '--station-count': count }}>
        {stations.map((st) => {
          const stType = STATION_TYPES.find(t => t.id === st.type) ?? STATION_TYPES[0];
          const isSelected = st.id === selectedId;
          const linkedSms = (st.smIds ?? []).map(id => sms.find(s => s.id === id)).filter(Boolean);

          return (
            <div
              key={st.id}
              className={`linear-visual__station${isSelected ? ' linear-visual__station--selected' : ''}`}
              style={{
                borderColor: stType.color,
                background: isSelected ? stType.color : '#fff',
                color: isSelected ? '#fff' : stType.color,
              }}
              onClick={() => onSelectStation(st.id)}
            >
              <span className="linear-visual__station-id">
                S{String(st.number).padStart(2, '0')}
              </span>
              <span className="linear-visual__station-name" style={{ color: isSelected ? '#fff' : '#64748b' }}>
                {(st.name ?? '').substring(0, 14)}
              </span>
              {linkedSms.length > 0 && (
                <span className="linear-visual__sm-badge">{linkedSms.length}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Robot Cell Layout ───────────────────────────────────────────────────────
function RobotCellVisual({ stations, selectedId, onSelectStation, sms }) {
  const count = stations.length;
  if (count === 0) return <div className="machine-visual__empty">Add stations to see cell layout</div>;

  const cx = 200, cy = 200, r = 140;

  return (
    <svg viewBox="0 0 400 400" className="machine-visual__svg">
      {/* Cell boundary */}
      <rect x={30} y={30} width={340} height={340} rx={16} fill="none" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="8 4" />
      {/* Robot in center */}
      <circle cx={cx} cy={cy} r={36} fill="#f5f3ff" stroke="#7c3aed" strokeWidth="2" />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="10" fill="#7c3aed" fontWeight="600">ROBOT</text>
      <text x={cx} y={cy + 10} textAnchor="middle" fontSize="8" fill="#a78bfa">CELL</text>

      {stations.map((st, i) => {
        const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        const stType = STATION_TYPES.find(t => t.id === st.type) ?? STATION_TYPES[0];
        const isSelected = st.id === selectedId;
        const linkedSms = (st.smIds ?? []).map(id => sms.find(s => s.id === id)).filter(Boolean);

        return (
          <g key={st.id} className="station-click" onClick={() => onSelectStation(st.id)} style={{ cursor: 'pointer' }}>
            <rect x={x - 36} y={y - 24} width={72} height={48} rx={6}
              fill={isSelected ? stType.color : '#fff'}
              stroke={stType.color} strokeWidth={isSelected ? 3 : 1.5} />
            <text x={x} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="700"
              fill={isSelected ? '#fff' : stType.color}>
              S{String(st.number).padStart(2, '0')}
            </text>
            <text x={x} y={y + 8} textAnchor="middle" fontSize="7"
              fill={isSelected ? '#fff' : '#64748b'}>
              {(st.name ?? '').substring(0, 10)}
            </text>
            {linkedSms.length > 0 && (
              <>
                <circle cx={x + 30} cy={y - 18} r={7} fill="#befa4f" stroke="#1574C4" strokeWidth="1" />
                <text x={x + 30} y={y - 15} textAnchor="middle" fontSize="8" fontWeight="700" fill="#1574C4">
                  {linkedSms.length}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Station Detail Panel ────────────────────────────────────────────────────
function StationDetail({ station, sms, onUpdate, onLinkSm, onUnlinkSm, onPrev, onNext, hasPrev, hasNext, totalStations }) {
  const [smDropdownOpen, setSmDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown when station changes
  useEffect(() => { setSmDropdownOpen(false); }, [station?.id]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!smDropdownOpen) return;
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setSmDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [smDropdownOpen]);

  if (!station) return (
    <div className="station-detail__empty">
      Select a station on the visual to edit its properties
    </div>
  );

  const linkedSms = (station.smIds ?? []).map(id => sms.find(s => s.id === id)).filter(Boolean);
  const availableSms = sms.filter(s => !(station.smIds ?? []).includes(s.id));
  const stType = STATION_TYPES.find(t => t.id === station.type) ?? STATION_TYPES[0];

  return (
    <div className="station-detail">
      <div className="station-detail__header" style={{ borderLeftColor: stType.color }}>
        <span className="station-detail__number">S{String(station.number).padStart(2, '0')}</span>
        <input
          className="station-detail__name-input"
          value={station.name}
          onChange={e => onUpdate(station.id, { name: e.target.value })}
          placeholder="Station name"
        />
      </div>
      <div className="station-detail__nav-row">
        <button
          className={`station-detail__nav-pill${!hasPrev ? ' station-detail__nav-pill--disabled' : ''}`}
          onClick={onPrev}
          disabled={!hasPrev}
          title="Previous station"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M8 1L3 6l5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Prev
        </button>
        <span className="station-detail__nav-label">{station.number} / {totalStations}</span>
        <button
          className={`station-detail__nav-pill${!hasNext ? ' station-detail__nav-pill--disabled' : ''}`}
          onClick={onNext}
          disabled={!hasNext}
          title="Next station"
        >
          Next
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1l5 5-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      <div className="station-detail__field">
        <label>Station Type</label>
        <div className="station-detail__type-grid">
          {STATION_TYPES.map(t => (
            <button
              key={t.id}
              className={`station-detail__type-btn${station.type === t.id ? ' station-detail__type-btn--active' : ''}`}
              style={{ '--type-color': t.color }}
              onClick={() => {
                const updates = { type: t.id };
                if (t.id === 'empty') updates.name = 'Empty';
                onUpdate(station.id, updates);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Linked State Machines */}
      <div className="station-detail__field">
        <label>Linked State Machines</label>
        {linkedSms.length > 0 ? (
          <div className="station-detail__sm-list">
            {linkedSms.map(sm => (
              <div key={sm.id} className="station-detail__sm-item">
                <span className="station-detail__sm-badge">S{String(sm.stationNumber).padStart(2, '0')}</span>
                <span>{sm.displayName ?? sm.name}</span>
                <button
                  className="station-detail__sm-remove"
                  onClick={() => onUnlinkSm(station.id, sm.id)}
                  title="Unlink"
                >×</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="station-detail__hint">No state machines linked to this station</p>
        )}
        {availableSms.length > 0 && (
          <div ref={dropdownRef} style={{ position: 'relative' }} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
            <button
              className="station-detail__sm-add-btn"
              onClick={() => setSmDropdownOpen(o => !o)}
              style={{ width: '100%', padding: '6px 10px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', textAlign: 'left', fontSize: 13, color: '#64748b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span>+ Link State Machine...</span>
              <span style={{ fontSize: 10 }}>{smDropdownOpen ? '▲' : '▼'}</span>
            </button>
            {smDropdownOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 20, maxHeight: 200, overflowY: 'auto', marginTop: 2 }}>
                {availableSms.map(sm => (
                  <button
                    key={sm.id}
                    onClick={() => { onLinkSm(station.id, sm.id); }}
                    style={{ display: 'block', width: '100%', padding: '8px 12px', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 13, color: '#1e293b' }}
                    onMouseEnter={e => e.target.style.background = '#f1f5f9'}
                    onMouseLeave={e => e.target.style.background = 'none'}
                  >
                    <span style={{ color: '#1574C4', fontWeight: 700, marginRight: 6 }}>S{String(sm.stationNumber).padStart(2, '0')}</span>
                    {sm.displayName ?? sm.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Verify station options */}
      {station.type === 'verify' && (
        <div className="station-detail__field">
          <label>
            <input
              type="checkbox"
              checked={station.bypass ?? false}
              onChange={e => onUpdate(station.id, { bypass: e.target.checked })}
            />
            Bypass capable
          </label>
          <label style={{ marginTop: 4, display: 'block' }}>
            <input
              type="checkbox"
              checked={station.lockout ?? false}
              onChange={e => onUpdate(station.id, { lockout: e.target.checked })}
            />
            Lockout capable
          </label>
        </div>
      )}
    </div>
  );
}

// ── SM Generator Panel ─────────────────────────────────────────────────────
// Subject types offered as axes in the station configurator. Covers the full
// DEVICE_TYPES list so you can add any subject (e.g. vision, robot, timer,
// analog probe) from the Setup screen without a separate round-trip to the
// Subject Library. Only types that make sense as a stand-alone axis row are
// included (Parameter/Custom are excluded — those are configured specially).
const AXIS_TYPES = [
  { id: 'pneumatic', label: 'Pneumatic' },
  { id: 'rotary',    label: 'Rotary Pneu' },
  { id: 'servo',     label: 'Servo' },
  { id: 'gripper',   label: 'Gripper' },
  { id: 'vacuum',    label: 'Vacuum' },
  { id: 'sensor',    label: 'Dig Sensor' },
  { id: 'analog',    label: 'Analog Probe' },
  { id: 'vision',    label: 'Vision' },
  { id: 'robot',     label: 'Robot' },
  { id: 'conveyor',  label: 'Conveyor' },
  { id: 'timer',     label: 'Timer' },
];
const AXIS_LABELS = ['X', 'Z', 'A3', 'A4', 'A5', 'A6']; // auto-assigned labels
const DEFAULT_LOAD_AXES = [
  { label: 'X', type: 'pneumatic' },
  { label: 'Z', type: 'pneumatic' },
  { label: 'Grip', type: 'gripper' },
];
const DEFAULT_UNLOAD_AXES = [
  { label: 'X', type: 'pneumatic' },
  { label: 'Z', type: 'pneumatic' },
  { label: 'Grip', type: 'gripper' },
];
const VERIFY_TYPES = ['vision', 'sensor', 'mechanical'];

function SmGeneratorPanel({ stations, sms }) {
  const batchGenerateStateMachines = useDiagramStore(s => s.batchGenerateStateMachines);
  const [showGenerator, setShowGenerator] = useState(false);

  // Non-empty stations
  const nonEmpty = useMemo(() => stations.filter(s => s.type !== 'empty'), [stations]);
  // Stations that already have linked SMs (locked / grayed out)
  // Validate that linked SM IDs actually exist — ignore stale/dead references
  const smIdSet = useMemo(() => new Set(sms.map(s => s.id)), [sms]);
  const hasSmSet = useMemo(() => {
    const s = new Set();
    for (const st of nonEmpty) {
      const validSmIds = (st.smIds ?? []).filter(id => smIdSet.has(id));
      if (validSmIds.length > 0) s.add(st.id);
    }
    return s;
  }, [nonEmpty, smIdSet]);
  // Only stations without SMs are eligible
  const eligible = useMemo(() => nonEmpty.filter(s => !hasSmSet.has(s.id)), [nonEmpty, hasSmSet]);

  // Build default axes for a station type
  const defaultAxes = (type) => {
    if (type === 'load') return DEFAULT_LOAD_AXES.map(a => ({ ...a }));
    if (type === 'unload') return DEFAULT_UNLOAD_AXES.map(a => ({ ...a }));
    return [];
  };

  // Per-station config keyed by stationId (only eligible stations)
  const [genConfigs, setGenConfigs] = useState(() => {
    const cfgs = {};
    for (const st of eligible) {
      cfgs[st.id] = {
        checked: true,
        stationType: st.type ?? 'process',
        copyFromSmId: null,
        axes: defaultAxes(st.type),
        verifyType: st.type === 'verify' ? 'vision' : null,
        // Per-station: generate full sequence scaffolding vs. devices only
        generateSequence: true,
      };
    }
    return cfgs;
  });

  // Sync configs when stations change
  useEffect(() => {
    setGenConfigs(prev => {
      const next = { ...prev };
      for (const st of eligible) {
        if (!next[st.id]) {
          next[st.id] = {
            checked: true,
            stationType: st.type ?? 'process',
            copyFromSmId: null,
            axes: defaultAxes(st.type),
            verifyType: st.type === 'verify' ? 'vision' : null,
            generateSequence: true,
          };
        }
      }
      for (const key of Object.keys(next)) {
        if (!eligible.find(s => s.id === key)) delete next[key];
      }
      return next;
    });
  }, [eligible]);

  const updateCfg = useCallback((stId, patch) => {
    setGenConfigs(prev => ({ ...prev, [stId]: { ...prev[stId], ...patch } }));
  }, []);

  const checkedCount = useMemo(() => eligible.filter(s => genConfigs[s.id]?.checked).length, [eligible, genConfigs]);

  const handleCheckAll = useCallback((val) => {
    setGenConfigs(prev => {
      const next = { ...prev };
      for (const st of eligible) { if (next[st.id]) next[st.id] = { ...next[st.id], checked: val }; }
      return next;
    });
  }, [eligible]);

  const handleGenerate = useCallback(() => {
    const configs = eligible
      .filter(st => genConfigs[st.id]?.checked)
      .map(st => {
        const c = genConfigs[st.id];
        return {
          stationId: st.id,
          stationNumber: st.number,
          stationName: st.name,
          stationType: c.stationType,
          copyFromSmId: c.copyFromSmId ?? null,
          axes: c.axes ?? [],
          verifyType: c.stationType === 'verify' ? (c.verifyType ?? 'vision') : null,
          // Per-station toggle — when false, only devices and the Home +
          // Cycle Complete nodes are produced. The user builds the sequence
          // manually. Copy-from-SM is unaffected (always copies full graph).
          generateSequence: c.generateSequence !== false,
        };
      });
    if (configs.length === 0) return;
    batchGenerateStateMachines(configs);
    setShowGenerator(false);
  }, [eligible, genConfigs, batchGenerateStateMachines]);

  if (nonEmpty.length === 0) return null;

  return (
    <div className="sm-gen-panel">
      <button
        className={`sm-gen-panel__toggle${showGenerator ? ' sm-gen-panel__toggle--open' : ''}`}
        onClick={() => setShowGenerator(v => !v)}
      >
        <span className="sm-gen-panel__toggle-icon">{showGenerator ? '\u25BC' : '\u25B6'}</span>
        Generate State Machines
        {!showGenerator && eligible.length > 0 && (
          <span className="sm-gen-panel__badge">{eligible.length} to generate</span>
        )}
        {!showGenerator && eligible.length === 0 && nonEmpty.length > 0 && (
          <span className="sm-gen-panel__badge sm-gen-panel__badge--done">All generated</span>
        )}
      </button>

      {showGenerator && (
        <div className="sm-gen-panel__body">
          {/* Toolbar: check/uncheck + generate */}
          <div className="sm-gen-panel__toolbar">
            <button className="sm-gen-panel__tool-btn" onClick={() => handleCheckAll(true)} title="Check all">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="#475569" strokeWidth="1.5"/><path d="M4.5 8.5L7 11L11.5 5.5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button className="sm-gen-panel__tool-btn" onClick={() => handleCheckAll(false)} title="Uncheck all">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="#475569" strokeWidth="1.5"/></svg>
            </button>
            <div style={{ flex: 1 }} />
            <span className="sm-gen-panel__count">{checkedCount} of {eligible.length} selected</span>
            <button
              className="sm-gen-panel__generate-btn"
              onClick={handleGenerate}
              disabled={checkedCount === 0}
            >
              Generate {checkedCount} State Machine{checkedCount !== 1 ? 's' : ''}
            </button>
          </div>


          {/* ── Existing SMs section ─────────────────────────── */}
          {nonEmpty.filter(st => hasSmSet.has(st.id)).length > 0 && (
            <div className="sm-gen-existing">
              <div className="sm-gen-existing__header">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z" stroke="#16a34a" strokeWidth="1.5"/><path d="M5.5 8.5L7 10l3.5-4" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span>{nonEmpty.filter(st => hasSmSet.has(st.id)).length} stations already have state machines</span>
              </div>
              <div className="sm-gen-existing__list">
                {nonEmpty.filter(st => hasSmSet.has(st.id)).map(st => {
                  const stType = STATION_TYPES.find(t => t.id === st.type);
                  const linkedSms = (st.smIds ?? []).map(id => sms.find(s => s.id === id)).filter(Boolean);
                  return (
                    <div key={st.id} className="sm-gen-existing__item">
                      <span className="sm-gen-existing__station">S{String(st.number).padStart(2, '0')}</span>
                      <span className="sm-gen-existing__name">{st.name}</span>
                      <span className="sm-gen-table__pill" style={{ background: stType?.color ?? '#94a3b8', fontSize: 10, padding: '1px 6px' }}>
                        {stType?.label ?? st.type}
                      </span>
                      <span className="sm-gen-existing__sms">
                        {linkedSms.map(sm => (
                          <span key={sm.id} className="sm-gen-table__sm-tag">
                            S{String(sm.stationNumber).padStart(2, '0')} {sm.displayName ?? sm.name}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── To Generate section ───────────────────────────── */}
          <table className="sm-gen-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th style={{ width: 44 }}>#</th>
                <th>Name</th>
                <th style={{ width: 90 }}>Type</th>
                <th>Config</th>
                <th style={{ width: 200 }}>Mode</th>
                <th style={{ width: 160 }}>Copy From</th>
              </tr>
            </thead>
            <tbody>
              {eligible.map(st => {
                const cfg = genConfigs[st.id] ?? {};
                const stType = STATION_TYPES.find(t => t.id === st.type);

                return (
                  <tr key={st.id} className={cfg.checked ? '' : 'sm-gen-table__row--disabled'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!!cfg.checked}
                        onChange={e => updateCfg(st.id, { checked: e.target.checked })}
                      />
                    </td>
                    <td className="sm-gen-table__num">S{String(st.number).padStart(2, '0')}</td>
                    <td className="sm-gen-table__name">{st.name}</td>
                    <td>
                      <span className="sm-gen-table__pill" style={{ background: stType?.color ?? '#94a3b8' }}>
                        {stType?.label ?? st.type}
                      </span>
                    </td>
                    <td>
                      {cfg.checked && !cfg.copyFromSmId && (cfg.stationType === 'load' || cfg.stationType === 'unload' || cfg.stationType === 'process' || cfg.stationType === 'reject') && (
                        <div className="sm-gen-axes">
                          {(cfg.axes ?? []).map((axis, ai) => (
                            <div key={ai} className="sm-gen-axes__row">
                              <input
                                className="sm-gen-axes__label-input"
                                value={axis.label}
                                onChange={e => {
                                  const newAxes = [...(cfg.axes ?? [])];
                                  newAxes[ai] = { ...newAxes[ai], label: e.target.value };
                                  updateCfg(st.id, { axes: newAxes });
                                }}
                                placeholder="Label"
                              />
                              {AXIS_TYPES.map(at => (
                                <button
                                  key={at.id}
                                  className={`sm-gen-axes__btn${axis.type === at.id ? ' sm-gen-axes__btn--active' : ''}`}
                                  onClick={() => {
                                    const newAxes = [...(cfg.axes ?? [])];
                                    newAxes[ai] = { ...newAxes[ai], type: at.id };
                                    updateCfg(st.id, { axes: newAxes });
                                  }}
                                >{at.label}</button>
                              ))}
                              <button
                                className="sm-gen-axes__remove"
                                onClick={() => {
                                  const newAxes = (cfg.axes ?? []).filter((_, i) => i !== ai);
                                  updateCfg(st.id, { axes: newAxes });
                                }}
                                title="Remove axis"
                              >&times;</button>
                            </div>
                          ))}
                          <button
                            className="sm-gen-axes__add"
                            onClick={() => {
                              const nextLabel = AXIS_LABELS[(cfg.axes ?? []).length] ?? `A${(cfg.axes ?? []).length + 1}`;
                              updateCfg(st.id, { axes: [...(cfg.axes ?? []), { label: nextLabel, type: 'pneumatic' }] });
                            }}
                          >+ Add Device</button>
                        </div>
                      )}
                      {cfg.checked && !cfg.copyFromSmId && cfg.stationType === 'verify' && (
                        <div className="sm-gen-verify">
                          {VERIFY_TYPES.map(vt => (
                            <button
                              key={vt}
                              className={`sm-gen-verify__btn${cfg.verifyType === vt ? ' sm-gen-verify__btn--active' : ''}`}
                              onClick={() => updateCfg(st.id, { verifyType: vt })}
                            >
                              {vt.charAt(0).toUpperCase() + vt.slice(1)}
                            </button>
                          ))}
                        </div>
                      )}
                      {cfg.checked && cfg.copyFromSmId && (
                        <span className="sm-gen-table__manual">Copying</span>
                      )}
                    </td>
                    <td>
                      {/* Per-station mode: disabled when copying (full graph is cloned) */}
                      <div className={`sm-gen-mode-toggle${cfg.copyFromSmId ? ' sm-gen-mode-toggle--disabled' : ''}`}>
                        <button
                          type="button"
                          className={`sm-gen-mode-toggle__btn${cfg.generateSequence !== false ? ' sm-gen-mode-toggle__btn--active' : ''}`}
                          onClick={() => updateCfg(st.id, { generateSequence: true })}
                          disabled={!cfg.checked || !!cfg.copyFromSmId}
                          title="Scaffold a full PnP-style state sequence"
                        >Seq + Devices</button>
                        <button
                          type="button"
                          className={`sm-gen-mode-toggle__btn${cfg.generateSequence === false ? ' sm-gen-mode-toggle__btn--active' : ''}`}
                          onClick={() => updateCfg(st.id, { generateSequence: false })}
                          disabled={!cfg.checked || !!cfg.copyFromSmId}
                          title="Only create the subjects — you'll build the sequence yourself"
                        >Devices Only</button>
                      </div>
                    </td>
                    <td>
                      <select
                        className="sm-gen-table__select"
                        value={cfg.copyFromSmId ?? ''}
                        onChange={e => updateCfg(st.id, { copyFromSmId: e.target.value || null })}
                        disabled={!cfg.checked}
                      >
                        <option value="">-- New --</option>
                        {sms.map(sm => (
                          <option key={sm.id} value={sm.id}>
                            S{String(sm.stationNumber).padStart(2, '0')} {sm.displayName ?? sm.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Bottom generate button too for visibility */}
          {eligible.length > 8 && (
            <div className="sm-gen-panel__footer">
              <button
                className="sm-gen-panel__generate-btn"
                onClick={handleGenerate}
                disabled={checkedCount === 0}
              >
                Generate {checkedCount} State Machine{checkedCount !== 1 ? 's' : ''}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────
export function MachineConfigEditor() {
  const mc = useDiagramStore(s => s.project.machineConfig ?? {});
  const sms = useDiagramStore(s => s.project.stateMachines ?? []);
  const updateMachineConfig = useDiagramStore(s => s.updateMachineConfig);
  const setMachineStationCount = useDiagramStore(s => s.setMachineStationCount);
  const autoGenerateIndexerSM = useDiagramStore(s => s.autoGenerateIndexerSM);
  const updateStation = useDiagramStore(s => s.updateStation);
  const linkSmToStation = useDiagramStore(s => s.linkSmToStation);
  const unlinkSmFromStation = useDiagramStore(s => s.unlinkSmFromStation);

  // Auto-generate indexer SM if indexing machine is active but no indexer exists
  useEffect(() => {
    const mt = mc.machineType ?? 'indexing';
    if ((mt === 'indexing' || mt === 'linear') && sms.length > 0) {
      const hasIndexer = sms.some(sm => sm.name === 'Dial_Indexer' || sm.name === 'DialIndexer' || sm.name === 'Indexer');
      if (!hasIndexer) autoGenerateIndexerSM();
    }
  }, []); // only on mount

  const [selectedStationId, setSelectedStationId] = useState(null);
  const [expandedTypes, setExpandedTypes] = useState({ load: true, process: true, verify: true, unload: true });
  const selectedStation = (mc.stations ?? []).find(s => s.id === selectedStationId) ?? null;

  const machineType = mc.machineType ?? 'indexing';
  const stations = mc.stations ?? [];

  const VisualComponent = useMemo(() => {
    switch (machineType) {
      case 'indexing': return DialVisual;
      case 'linear': return LinearVisual;
      case 'robotCell': return RobotCellVisual;
      case 'testInspect': return LinearVisual;
      default: return LinearVisual;
    }
  }, [machineType]);

  // Click anywhere outside a station or its detail panel → deselect
  const handleBackgroundClick = useCallback((e) => {
    // Don't deselect if clicking inside station detail or a station element
    if (e.target.closest('.machine-config__station-detail')) return;
    if (e.target.closest('.station-detail')) return;
    if (e.target.closest('.station-detail__sm-add-btn')) return;
    if (e.target.closest('.machine-config__station-table tbody tr')) return;
    if (e.target.closest('.linear-visual__station')) return;
    if (e.target.closest('.station-click')) return;
    if (e.target.closest('.mu-station-list__row')) return;
    if (e.target.closest('.mu-detail')) return;
    if (e.target.closest('.mu-type-group__station')) return;
    setSelectedStationId(null);
  }, []);

  return (
    <div className="machine-config" onClick={handleBackgroundClick}>
      <div className="machine-config__header">
        <h2 className="machine-config__title">Machine Configuration</h2>
        <p className="machine-config__subtitle">
          Define your machine layout, name stations, and link them to state machines.
        </p>
      </div>

      {/* Top form row */}
      <div className="machine-config__form-row">
        <div className="machine-config__field">
          <label>Machine Name</label>
          <input
            type="text"
            value={mc.machineName ?? ''}
            onChange={e => updateMachineConfig({ machineName: e.target.value })}
            placeholder="e.g. Stamper PNP Assembly"
          />
        </div>
        <div className="machine-config__field">
          <label>Customer</label>
          <input
            type="text"
            value={mc.customerName ?? ''}
            onChange={e => updateMachineConfig({ customerName: e.target.value })}
            placeholder="e.g. Acme Corp"
          />
        </div>
        <div className="machine-config__field">
          <label>Project Number</label>
          <input
            type="text"
            value={mc.projectNumber ?? ''}
            onChange={e => updateMachineConfig({ projectNumber: e.target.value })}
            placeholder="e.g. 1103"
          />
        </div>
        <div className="machine-config__field">
          <label>Target Cycle Time (s)</label>
          <input
            type="number"
            value={mc.targetCycleTime ?? 0}
            onChange={e => updateMachineConfig({ targetCycleTime: Number(e.target.value) })}
            min="0"
            step="0.1"
          />
        </div>
      </div>

      {/* PLC Settings row */}
      <div className="machine-config__form-row">
        <div className="machine-config__field">
          <label>Studio 5000 Version</label>
          <select
            value={mc.softwareRevision ?? '35.00'}
            onChange={e => updateMachineConfig({ softwareRevision: e.target.value })}
          >
            <option value="32.00">v32</option>
            <option value="33.00">v33</option>
            <option value="34.00">v34</option>
            <option value="35.00">v35</option>
            <option value="36.00">v36</option>
            <option value="37.00">v37</option>
          </select>
        </div>
        <div className="machine-config__field">
          <label>Processor Type</label>
          <select
            value={mc.processorType ?? '1756-L83E'}
            onChange={e => updateMachineConfig({ processorType: e.target.value })}
          >
            <option value="1756-L71">1756-L71 (ControlLogix)</option>
            <option value="1756-L73">1756-L73 (ControlLogix)</option>
            <option value="1756-L75">1756-L75 (ControlLogix)</option>
            <option value="1756-L81E">1756-L81E (ControlLogix)</option>
            <option value="1756-L83E">1756-L83E (ControlLogix)</option>
            <option value="1756-L85E">1756-L85E (ControlLogix)</option>
            <option value="5069-L306ER">5069-L306ER (CompactLogix)</option>
            <option value="5069-L310ER">5069-L310ER (CompactLogix)</option>
            <option value="5069-L320ER">5069-L320ER (CompactLogix)</option>
            <option value="5069-L330ER">5069-L330ER (CompactLogix)</option>
            <option value="5069-L340ER">5069-L340ER (CompactLogix)</option>
            <option value="5069-L350ER">5069-L350ER (CompactLogix)</option>
            <option value="5069-L306ERM">5069-L306ERM (CompactLogix Motion)</option>
            <option value="5069-L310ERM">5069-L310ERM (CompactLogix Motion)</option>
            <option value="5069-L320ERM">5069-L320ERM (CompactLogix Motion)</option>
            <option value="5069-L330ERM">5069-L330ERM (CompactLogix Motion)</option>
            <option value="5069-L340ERM">5069-L340ERM (CompactLogix Motion)</option>
            <option value="5069-L350ERM">5069-L350ERM (CompactLogix Motion)</option>
          </select>
        </div>
        <div className="machine-config__field">
          <label>Controller Name</label>
          <input
            type="text"
            value={mc.controllerName ?? 'SDCController'}
            onChange={e => updateMachineConfig({ controllerName: e.target.value })}
            placeholder="SDCController"
          />
        </div>
      </div>

      {/* Machine type selector */}
      <div className="machine-config__type-selector">
        <label>Machine Type</label>
        <div className="machine-config__type-grid">
          {MACHINE_TYPES.map(mt => {
            const IconComp = MACHINE_TYPE_ICONS[mt.id];
            const isActive = machineType === mt.id;
            return (
              <button
                key={mt.id}
                className={`machine-config__type-card${isActive ? ' machine-config__type-card--active' : ''}`}
                onClick={() => {
                  updateMachineConfig({ machineType: mt.id });
                  // Auto-generate Indexer SM for indexing machines
                  if (mt.id === 'indexing' || mt.id === 'linear') {
                    setTimeout(() => autoGenerateIndexerSM(), 50);
                  }
                }}
              >
                <span className="machine-config__type-icon">{IconComp && <IconComp active={isActive} />}</span>
                <span className="machine-config__type-label">{mt.label}</span>
                <span className="machine-config__type-desc">{mt.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Station / Nest count */}
      <div className="machine-config__form-row">
        {machineType === 'indexing' ? (
          <>
            <div className="machine-config__field">
              <label>Number of Nests / Heads</label>
              <input
                type="number"
                value={mc.nestCount ?? stations.length ?? 0}
                onChange={e => {
                  const count = Math.max(0, Math.min(200, Number(e.target.value) || 0));
                  updateMachineConfig({ nestCount: count });
                  setMachineStationCount(count);
                }}
                min="0"
                max="200"
                step="1"
              />
              <span className="machine-config__hint">Total positions on the dial — each becomes a station slot to classify</span>
            </div>
            <div className="machine-config__field">
              <label>Stations</label>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1574C4', padding: '6px 0' }}>
                {stations.filter(s => s.type !== 'empty').length}
                <span style={{ fontSize: 13, fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>
                  active / {stations.length} total
                </span>
              </div>
              <span className="machine-config__hint">Classify each nest below — empty nests don't get SMs</span>
            </div>
          </>
        ) : (
          <div className="machine-config__field">
            <label>Number of Stations</label>
            <input
              type="number"
              value={stations.length}
              onChange={e => setMachineStationCount(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
              min="0"
              max="200"
              step="1"
            />
            <span className="machine-config__hint">Process positions on the machine</span>
          </div>
        )}
      </div>

      {/* Unified machine view: breakdown | visual | station list + detail */}
      {stations.length > 0 && (() => {
        const typeCounts = {};
        const typeStations = {};
        for (const st of stations) {
          const t = st.type ?? 'load';
          typeCounts[t] = (typeCounts[t] ?? 0) + 1;
          if (!typeStations[t]) typeStations[t] = [];
          typeStations[t].push(st);
        }
        const total = stations.length;

        // SVG donut — bigger
        const size = 150, sw = 20;
        const r = (size - sw) / 2;
        const circ = 2 * Math.PI * r;
        let cum = 0;
        const typeData = STATION_TYPES.map(t => ({ id: t.id, value: typeCounts[t.id] ?? 0, color: t.color, label: t.label })).filter(d => d.value > 0);

        return (
          <div className="machine-unified">
            {/* Left: donut + expandable type breakdown */}
            <div className="mu-sidebar">
              <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', margin: '0 auto 10px' }}>
                <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={sw} />
                {(() => {
                  let c2 = 0;
                  return typeData.map((d, i) => {
                    const pct = d.value / total;
                    const dashLen = pct * circ;
                    const dashGap = circ - dashLen;
                    const offset = -c2 * circ + circ * 0.25;
                    // Midpoint angle for label
                    const midFrac = c2 + pct / 2;
                    const midAngle = midFrac * 2 * Math.PI - Math.PI / 2;
                    const lx = size / 2 + r * Math.cos(midAngle);
                    const ly = size / 2 + r * Math.sin(midAngle);
                    const pctRound = Math.round(pct * 100);
                    c2 += pct;
                    return (
                      <g key={i}>
                        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={d.color}
                          strokeWidth={sw} strokeDasharray={`${dashLen} ${dashGap}`}
                          strokeDashoffset={offset} strokeLinecap="butt" />
                        {pctRound >= 5 && (
                          <text x={lx} y={ly + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
                            {pctRound}%
                          </text>
                        )}
                      </g>
                    );
                  });
                })()}
                <text x={size/2} y={size/2 - 5} textAnchor="middle" fontSize="28" fontWeight="700" fill="#1e293b">{total}</text>
                <text x={size/2} y={size/2 + 14} textAnchor="middle" fontSize="11" fill="#94a3b8">stations</text>
              </svg>

              {/* Expandable type list */}
              <div className="mu-sidebar__types">
                {typeData.map(d => {
                  const isExpanded = expandedTypes[d.id] ?? false;
                  const stList = typeStations[d.id] ?? [];
                  const pct = Math.round((d.value / total) * 100);
                  return (
                    <div key={d.id} className="mu-type-group">
                      <button
                        className="mu-type-group__header"
                        onClick={() => setExpandedTypes(prev => ({ ...prev, [d.id]: !prev[d.id] }))}
                      >
                        <span className="mu-type-group__dot" style={{ background: d.color }} />
                        <span className="mu-type-group__count">{d.value}</span>
                        <span className="mu-type-group__label">{d.label}</span>
                        <span className="mu-type-group__pct">{pct}%</span>
                        <span className={`mu-type-group__chevron${isExpanded ? ' mu-type-group__chevron--open' : ''}`}>&#9656;</span>
                      </button>
                      {/* Percentage bar */}
                      <div className="mu-type-group__bar">
                        <div className="mu-type-group__bar-fill" style={{ width: `${pct}%`, background: d.color }} />
                      </div>
                      {isExpanded && (
                        <div className="mu-type-group__list">
                          {stList.map(st => (
                            <div
                              key={st.id}
                              className={`mu-type-group__station${st.id === selectedStationId ? ' mu-type-group__station--active' : ''}`}
                              onClick={() => setSelectedStationId(st.id)}
                            >
                              <span className="mu-type-group__snum">S{String(st.number).padStart(2, '0')}</span>
                              <span className="mu-type-group__sname">{st.name}</span>
                              {(st.smIds ?? []).length > 0 && <span className="mu-type-group__linked" title="Has linked SMs">&#9679;</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Center: dial / linear visual */}
            <div className={`mu-visual${machineType === 'indexing' ? ' mu-visual--dial' : ''}`}>
              <VisualComponent
                stations={stations}
                selectedId={selectedStationId}
                onSelectStation={setSelectedStationId}
                sms={sms}
              />
            </div>

            {/* Right: full station list + detail when selected */}
            <div className="mu-right">
              {/* Station list — scrollable, shrinks when detail visible */}
              <div className="mu-station-list" style={selectedStation ? { maxHeight: 'calc(100% - 290px)' } : undefined}>
                <div className="mu-station-list__header">All Stations</div>
                <div className="mu-station-list__scroll">
                  {stations.map(st => {
                    const stType = STATION_TYPES.find(t => t.id === st.type) ?? STATION_TYPES[0];
                    const isActive = st.id === selectedStationId;
                    return (
                      <div
                        key={st.id}
                        className={`mu-station-list__row${isActive ? ' mu-station-list__row--active' : ''}`}
                        onClick={() => setSelectedStationId(st.id)}
                        ref={isActive ? (el) => { if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } : undefined}
                      >
                        <span className="mu-station-list__num">S{String(st.number).padStart(2, '0')}</span>
                        <span className="mu-station-list__name">{st.name}</span>
                        <span className="mu-station-list__pill" style={{ background: stType.color }}>{stType.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Detail panel — shows when a station is selected */}
              {selectedStation && (
                <div className="mu-detail" style={{ height: 280, minHeight: 280 }}>
                  <StationDetail
                    station={selectedStation}
                    sms={sms}
                    onUpdate={updateStation}
                    onLinkSm={linkSmToStation}
                    onUnlinkSm={unlinkSmFromStation}
                    hasPrev={stations.indexOf(selectedStation) > 0}
                    hasNext={stations.indexOf(selectedStation) < stations.length - 1}
                    onPrev={() => {
                      const idx = stations.indexOf(selectedStation);
                      if (idx > 0) setSelectedStationId(stations[idx - 1].id);
                    }}
                    onNext={() => {
                      const idx = stations.indexOf(selectedStation);
                      if (idx < stations.length - 1) setSelectedStationId(stations[idx + 1].id);
                    }}
                    totalStations={stations.length}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── SM Generator Panel ──────────────────────────────────────────── */}
      {stations.filter(s => s.type !== 'empty').length > 0 && (
        <SmGeneratorPanel stations={stations} sms={sms} />
      )}
    </div>
  );
}
