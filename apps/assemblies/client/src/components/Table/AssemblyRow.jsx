/**
 * AssemblyRow.jsx
 * Individual table row component for AssemblyTable.
 */
import { useMemo, useState, memo } from 'react';
import API_BASE from '../../utils/apiBase';
import ImageLightbox from '../ImageLightbox';

function Highlight({ text, search }) {
  const content = useMemo(() => {
    if (!text || !search?.trim()) return text || null;
    const tokens  = search.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return text;
    const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const splitRx = new RegExp(`(${escaped.join('|')})`, 'gi');
    const matchRx = new RegExp(`^(${escaped.join('|')})$`, 'i');
    const parts   = text.split(splitRx);
    return parts.map((part, i) =>
      part && matchRx.test(part)
        ? <mark key={i} className="hilite">{part}</mark>
        : <span key={i}>{part}</span>
    );
  }, [text, search]);
  return <>{content}</>;
}

// Some job_id values contain the full folder name, e.g. "023 GKN TAPPING MACHINE"
// because the L: drive scanner stores the raw folder name. These helpers split
// the numeric prefix from the descriptive name so each column shows correctly.
function splitJobId(jobId) {
  if (!jobId) return { num: null, name: null };
  const m = String(jobId).match(/^(\d+)([\s_](.+))?/);
  if (!m) return { num: null, name: jobId }; // no leading digits — treat as name only
  return { num: m[1], name: m[3] ? m[3].trim() : null };
}

function StandardBadge({ value }) {
  if (value === 'Yes') return <span className="std-badge std-yes">SDC STANDARD</span>;
  if (value === 'No')  return <span className="std-badge std-no">NO</span>;
  if (value === 'Preferred') return <span className="std-badge std-pref">PREFERRED</span>;
  return <span className="muted">---</span>;
}

function InlineThumbnail({ href }) {
  const [errored, setErrored] = useState(false);
  if (!href || errored) return <span className="muted">---</span>;
  const srcUrl = href.startsWith('/') ? `${API_BASE}${href}` : href;
  return (
    <img
      src={srcUrl}
      alt="thumbnail"
      onError={() => setErrored(true)}
      className="thumb-sm"
    />

  );
}

function openLink(href) {
  if (!href) return;
  // Local drive path (N:\... L:\...) OR UNC path (\\server\share\...)
  const isLocalPath = /^[a-zA-Z]:/.test(href) || /^[\\/]{2}/.test(href);
  if (isLocalPath) {
    if (window.electron?.openPath) {
      window.electron.openPath(href).then(res => {
        if (!res.success) console.error('Failed to open file:', res.error);
      });
    } else {
      fetch(`${API_BASE}/api/assemblies/open?path=${encodeURIComponent(href)}`)
        .then(r => { if (!r.ok) console.error('Server open failed:', r.status); })
        .catch(err => console.error('Open request failed:', err));
    }
    return;
  }
  // Server-relative path (e.g. /thumbnails/…) — absolutise with API_BASE first
  const url = href.startsWith('/') ? `${API_BASE}${href}` : href;
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

import { cleanValue, toTitleCase, formatTimeAgo, getCategoryColor } from '../../utils/formatters';

const STATUS_DOT_STYLES = {
  'Obsolete':     { background: '#FEE2E2', color: '#991B1B' },
  'Draft':        { background: '#FEF3C7', color: '#92400E' },
  'Under Review': { background: '#DBEAFE', color: '#1E40AF' },
};

function AssemblyRow({
  assembly,
  onEdit,
  selected,
  onToggle,
  highlighted,
  search,
  showCol
}) {
  const a = assembly;
  const categoryColor = getCategoryColor(a.category);
  const [lightbox, setLightbox] = useState(null);
  
  return (
    <tr
      className={selected ? 'row-selected' : highlighted ? 'row-preview' : ''}
      onClick={() => onEdit(a)}
    >
      <td style={{ width: 40 }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={e => { e.stopPropagation(); onToggle(a.partno, e.target.checked); }}
          onClick={e => e.stopPropagation()}
          style={{ accentColor: 'var(--sdc-blue)', cursor: 'pointer', width: 14, height: 14 }}
        />
      </td>
      <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cleanValue(a.partno)}>
        <span className="pn-cell" onClick={(e) => { e.stopPropagation(); onEdit(a); }}>{cleanValue(a.partno)}</span>
      </td>
      {showCol('file_name') && <td className="muted mono" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cleanValue(a.file_name)}>{cleanValue(a.file_name)}</td>}
      <td style={{ textAlign: 'center' }}><span className="muted mono" style={{ fontSize: 12 }}>{cleanValue(splitJobId(a.job_id).num || a.job_id)}</span></td>
      {showCol('job_name') && <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink-2)' }}>{cleanValue(a.job_name || splitJobId(a.job_id).name)}</td>}
      <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <Highlight text={cleanValue(a.description)} search={search} />
      </td>
      {showCol('category') && <td style={{ textAlign: 'center' }}>
        {a.category ? (
          <span className={`badge badge-${categoryColor}`} style={{ fontSize: 10 }}>
            {toTitleCase(a.category)}
          </span>
        ) : <span className="muted">---</span>}
      </td>}
      <td style={{ textAlign: 'center' }}>
        {a.model_link ? (
          <button
            className="cad-btn"
            onClick={e => { e.stopPropagation(); openLink(a.model_link); }}
            title="Open CAD model"
            style={{ margin: '0 auto' }}
          >
            <span className="dot" /> CAD
          </button>
        ) : <span className="muted">---</span>}
      </td>
      <td style={{ textAlign: 'center' }} className="thumb-cell">
        {a.picture_link ? (
          <div style={{ display: 'flex', justifyContent: 'center', position: 'relative' }}>
            <button
              onClick={e => { e.stopPropagation(); setLightbox(a.picture_link); }}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', position: 'relative' }}
              title="View image (click to open)"
            >
              <InlineThumbnail href={a.picture_link} />
            </button>
          </div>
        ) : <span className="muted">---</span>}
        {lightbox && <ImageLightbox href={lightbox} title={a.partno} onClose={() => setLightbox(null)} />}
      </td>
      {showCol('comments') && <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--ink-3)' }}>{cleanValue(a.comments)}</td>}
      {showCol('updated_at') && <td style={{ whiteSpace: 'nowrap', fontSize: 11.5, color: 'var(--ink-4)' }}>{formatTimeAgo(a.updated_at)}</td>}
      {showCol('updated_by') && <td style={{ whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'var(--ink-2)' }}>{cleanValue(a.updated_by)}</td>}
      <td style={{ textAlign: 'center' }}><StandardBadge value={a.sdc_standard} /></td>
      {a.status && a.status !== 'Active' && (
        <td style={{ textAlign: 'center' }}>
          <span style={{
            display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
            ...STATUS_DOT_STYLES[a.status],
          }}>{a.status}</span>
        </td>
      )}
      {(!a.status || a.status === 'Active') && <td />}
    </tr>
  );
}

export default memo(AssemblyRow);