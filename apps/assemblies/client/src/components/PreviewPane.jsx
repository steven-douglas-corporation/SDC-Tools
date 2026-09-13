import { useState } from 'react';
import API_BASE from '../utils/apiBase';
import ImageLightbox from './ImageLightbox';

function openLink(href) {
  if (!href) return;
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
  const url = href.startsWith('/') ? `${API_BASE}${href}` : href;
  if (window.electron?.openExternal) window.electron.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function PropRow({ label, value, mono = false }) {
  const displayValue = (value === undefined || value === null || value === '') ? '---' : value;
  return (
    <div className="prop-row">
      <span className="k">{label}</span>
      <span className={`v${mono ? ' mono' : ''}`}>{displayValue}</span>
    </div>
  );
}


export default function PreviewPane({ assembly, onClose, onEdit }) {
  const [lightbox, setLightbox] = useState(false);

  if (!assembly) {
    return (
      <div className="empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--bg-alt)', color: 'var(--ink-4)', fontSize: 13, fontWeight: 500 }}>
        Select an assembly to view properties
      </div>
    );
  }

  const sdcBadge = assembly.sdc_standard === 'Yes'
    ? <span className="std-badge std-yes">SDC STANDARD</span>
    : <span className="std-badge std-no">NO</span>;

  return (
    <div className="right-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
      {/* Header */}
      <div className="detail-head">
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--sdc-blue)', letterSpacing: '0.02em' }}>{assembly.partno}</span>
            {sdcBadge}
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.2, letterSpacing: '-0.02em' }}>
            {assembly.description || 'Untitled Assembly'}
          </div>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (Esc)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="custom-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        <div
          className="big-preview"
          onClick={() => assembly.picture_link && setLightbox(true)}
          style={{ cursor: assembly.picture_link ? 'zoom-in' : 'default', marginBottom: 24, padding: 16, position: 'relative' }}
        >
          {assembly.picture_link ? (
            <>
              <img
                src={assembly.picture_link.startsWith('/') ? `${API_BASE}${assembly.picture_link}` : assembly.picture_link}
                alt={assembly.partno}
                style={{ maxWidth: '100%', maxHeight: '300px', objectFit: 'contain', display: 'block' }}
                onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
              />
              {/* Hidden error fallback */}
              <div style={{ display: 'none', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--ink-4)' }}>
                <svg width="48" height="48" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                  <path d="M3 7 12 2l9 5v10l-9 5-9-5Z"/><path d="M3 7l9 5 9-5M12 12v10"/>
                </svg>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em' }}>NO PREVIEW</span>
              </div>
              {/* Enlarge hint overlay */}
              <div style={{
                position: 'absolute', bottom: 20, right: 20,
                background: 'rgba(0,0,0,0.45)', color: '#fff',
                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                pointerEvents: 'none', opacity: 0.8,
              }}>
                🔍 Click to enlarge
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--ink-4)' }}>
              <svg width="48" height="48" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                <path d="M3 7 12 2l9 5v10l-9 5-9-5Z"/><path d="M3 7l9 5 9-5M12 12v10"/>
              </svg>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em' }}>NO PREVIEW</span>
            </div>
          )}
        </div>

        {lightbox && (
          <ImageLightbox
            href={assembly.picture_link}
            title={assembly.partno}
            onClose={() => setLightbox(false)}
          />
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 32 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1, height: 44, fontWeight: 700, gap: 10, fontSize: 14 }}
            onClick={(e) => { e.stopPropagation(); assembly.model_link && openLink(assembly.model_link); }}
            disabled={!assembly.model_link}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Open in SolidWorks
          </button>

          <button 
            className="btn btn-ghost" 
            style={{ height: 44, width: 44, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)' }} 
            onClick={() => onEdit && onEdit(assembly)} 
            title="Edit Record"
          >
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>

        <h4 className="section-title">Technical Specifications</h4>
        <div style={{ marginBottom: 32 }}>
          <PropRow label="Part Number" value={assembly.partno} mono />
          <PropRow label="Job ID" value={assembly.job_id} mono />
          <PropRow label="File Name" value={assembly.file_name} mono />
          <PropRow label="Description" value={assembly.description} />
          <PropRow label="Category" value={assembly.category} />
          <PropRow label="Comments" value={assembly.comments} />
          <PropRow label="Updated By" value={assembly.updated_by} />
          <PropRow label="Preference" value={assembly.preference} />
          <PropRow label="SDC Standard" value={assembly.sdc_standard} />
          <PropRow label="CAD Model Link" value={assembly.model_link} mono />
          <PropRow label="Image Link" value={assembly.picture_link} mono />
          <PropRow label="Last Updated" value={assembly.updated_at ? new Date(assembly.updated_at).toLocaleDateString() : null} />

        </div>

        {assembly.comments && (
          <div style={{ marginTop: 32 }}>
            <h4 className="section-title">Technical Comments</h4>
            <div className="comment" style={{ background: 'var(--bg-alt)', borderRadius: 10, padding: '16px', border: '1px solid var(--border)' }}>
              <div className="body">{assembly.comments}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
