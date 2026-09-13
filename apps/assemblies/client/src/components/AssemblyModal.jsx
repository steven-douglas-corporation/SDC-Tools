import { useState, useEffect, useCallback, useMemo } from 'react';
import { PREDEFINED_CATEGORIES } from '../constants';
import DeleteConfirm from './Modal/DeleteConfirm';
import API_BASE from '../utils/apiBase';
import ImageLightbox from './ImageLightbox';

function FieldLabel({ children, required }) {
  return (
    <div className="field-label">
      {children}{required && <span className="req">*</span>}
    </div>
  );
}

const STATUS_STYLES = {
  'Active':       { background: '#D1FAE5', color: '#065F46' },
  'Obsolete':     { background: '#FEE2E2', color: '#991B1B' },
  'Draft':        { background: '#FEF3C7', color: '#92400E' },
  'Under Review': { background: '#DBEAFE', color: '#1E40AF' },
};

function StatusBadgeSelect({ value, onChange }) {
  const style = STATUS_STYLES[value] || STATUS_STYLES['Active'];
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        ...style,
        border: 'none', borderRadius: 6, padding: '4px 10px',
        fontSize: 11, fontWeight: 700, cursor: 'pointer',
        letterSpacing: '0.04em', outline: 'none',
      }}
    >
      {Object.keys(STATUS_STYLES).map(s => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

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
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export default function AssemblyModal({ assembly, onClose, onSave, onDelete, onArchive = null, allCategories = [] }) {
  const [category,    setCategory]    = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [showAdd,     setShowAdd]     = useState(false);
  const [description, setDescription] = useState('');
  const [comments,    setComments]    = useState('');
  const [updatedBy,   setUpdatedBy]   = useState('');
  const [modelLink,   setModelLink]   = useState('');
  const [pictureLink, setPictureLink] = useState('');
  const [preference,  setPreference]  = useState('');
  const [sdcStandard, setSdcStandard] = useState('');
  const [statusField, setStatusField] = useState('Active');
  const [saving,      setSaving]      = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isDirty,     setIsDirty]     = useState(false);
  const [auditLog,    setAuditLog]    = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [lightbox,    setLightbox]    = useState(false);

  const categoryOptions = useMemo(() => {
    const simplified = allCategories.map(c => typeof c === 'object' ? c.value : c);
    const combined = new Set([...PREDEFINED_CATEGORIES, ...simplified]);
    return [...combined].filter(Boolean).sort();
  }, [allCategories]);

  useEffect(() => {
    if (!assembly) return;
    setCategory(assembly.category    || '');
    setDescription(assembly.description || '');
    setComments(assembly.comments    || '');
    setUpdatedBy(assembly.updated_by || '');
    setModelLink(assembly.model_link || '');
    setPictureLink(assembly.picture_link || '');
    setPreference(assembly.preference || '');
    setSdcStandard(assembly.sdc_standard || '');
    setStatusField(assembly.status || 'Active');
    setShowAdd(false); setNewCategory('');
    setShowConfirmDelete(false);
    setIsDirty(false);
    setShowHistory(false);
    setAuditLog([]);
    // Fetch audit history
    if (assembly?.partno) {
      fetch(`${API_BASE}/api/assemblies/${encodeURIComponent(assembly.partno)}/history`)
        .then(r => r.ok ? r.json() : [])
        .then(d => setAuditLog(Array.isArray(d) ? d : []))
        .catch(() => setAuditLog([]));
    }
  }, [assembly]);

  const safeClose = useCallback(() => {
    if (isDirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    setIsDirty(false);
    onClose();
  }, [isDirty, onClose]);

  useEffect(() => {
    if (!assembly) return;
    const handler = e => { if (e.key === 'Escape') safeClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [assembly, safeClose]);

  const markDirty = useCallback(() => setIsDirty(true), []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const finalCategory = showAdd && newCategory.trim() ? newCategory.trim() : category;
      await onSave(assembly.partno, {
        category: finalCategory, description, comments,
        updated_by: updatedBy, model_link: modelLink,
        picture_link: pictureLink, preference, sdc_standard: sdcStandard,
        status: statusField,
      });
      setIsDirty(false);
      onClose();
    } finally {
      setSaving(false);
    }
  }, [assembly, category, newCategory, showAdd, description, comments, updatedBy, modelLink, pictureLink, preference, sdcStandard, onSave, onClose]);

  if (!assembly) return null;

  const fileNameDiffers = assembly.file_name && assembly.file_name !== assembly.partno;

  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) safeClose(); }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="modal-title">Assembly Record</div>
              <div className="modal-sub">Part Number: {assembly.partno}</div>
            </div>
            <StatusBadgeSelect value={statusField} onChange={v => { setStatusField(v); markDirty(); }} />
          </div>
          <button className="btn btn-ghost btn-icon" onClick={safeClose} title="Close (Esc)">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body custom-scrollbar">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div className="info-block" style={{ marginBottom: 0 }}>
              <div className="info-label">Part Number</div>
              <div className="info-value mono" style={{ color: 'var(--sdc-blue)' }}>{assembly.partno}</div>
            </div>
            <div className="info-block" style={{ marginBottom: 0 }}>
              <div className="info-label">Job ID</div>
              <div className="info-value mono">{assembly.job_id || '—'}</div>
            </div>
            {assembly.file_name && (
              <div className="info-block" style={{ gridColumn: '1 / -1', marginBottom: 0, background: fileNameDiffers ? 'rgba(245, 158, 11, 0.05)' : undefined, borderColor: fileNameDiffers ? 'rgba(245, 158, 11, 0.3)' : undefined }}>
                <div className="info-label" style={{ color: fileNameDiffers ? '#B45309' : undefined }}>
                  File Name{fileNameDiffers ? ' — DIFFERENT FROM PART NO' : ''}
                </div>
                <div className="info-value mono" style={{ fontSize: 12, color: fileNameDiffers ? '#B45309' : undefined }}>{assembly.file_name}</div>
              </div>
            )}
          </div>

          <div className="form-field">
            <FieldLabel>Description</FieldLabel>
            <textarea
              className="field-textarea"
              value={description}
              onChange={e => { setDescription(e.target.value); markDirty(); }}
              rows={2}
              placeholder="Assembly function and purpose..."
            />
          </div>

          <div className="form-field">
            <FieldLabel>Category</FieldLabel>
            {!showAdd ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="field-select" style={{ flex: 1 }} value={category} onChange={e => { setCategory(e.target.value); markDirty(); }}>
                  <option value="">None / Uncategorized</option>
                  {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button className="btn btn-ghost btn-sm" style={{ fontWeight: 700 }} onClick={() => setShowAdd(true)}>+ CUSTOM</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input autoFocus type="text" className="field-input" style={{ flex: 1 }} value={newCategory} onChange={e => { setNewCategory(e.target.value); markDirty(); }} placeholder="New category..." />
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', fontWeight: 700 }} onClick={() => setShowAdd(false)}>CANCEL</button>
              </div>
            )}
          </div>

          <div className="form-field">
            <FieldLabel>Comments</FieldLabel>
            <textarea
              className="field-textarea"
              value={comments}
              onChange={e => { setComments(e.target.value); markDirty(); }}
              rows={3}
              placeholder="Technical notes, revision history..."
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div className="form-field">
              <FieldLabel>Updated By</FieldLabel>
              <input type="text" className="field-input" value={updatedBy} onChange={e => { setUpdatedBy(e.target.value); markDirty(); }} placeholder="Lead Engineer" />
            </div>
            <div className="form-field">
              <FieldLabel>Preference</FieldLabel>
              <div className="toggle-group">
                {['Yes', 'No'].map(opt => (
                  <button key={opt} className={`toggle-btn${preference === opt ? ' on' : ''}`} onClick={() => { setPreference(preference === opt ? '' : opt); markDirty(); }}>{opt}</button>
                ))}
              </div>
            </div>
            <div className="form-field">
              <FieldLabel>SDC Standard</FieldLabel>
              <div className="toggle-group">
                {['Yes', 'No'].map(opt => (
                  <button key={opt} className={`toggle-btn${sdcStandard === opt ? ' on' : ''}`} onClick={() => { setSdcStandard(sdcStandard === opt ? '' : opt); markDirty(); }}>{opt}</button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="form-field">
              <FieldLabel>CAD Model Link</FieldLabel>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="text" className="field-input" style={{ flex: 1 }} value={modelLink} onChange={e => { setModelLink(e.target.value); markDirty(); }} placeholder="Path or URL..." />
                {modelLink && (
                  <button className="btn btn-ghost btn-icon" style={{ height: 38, width: 38 }} onClick={() => openLink(modelLink)} title="Open CAD">
                    <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <div className="form-field">
              <FieldLabel>Image Link</FieldLabel>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="text" className="field-input" style={{ flex: 1 }} value={pictureLink} onChange={e => { setPictureLink(e.target.value); markDirty(); }} placeholder="Path or URL..." />
                {pictureLink && (
                  <button
                    className="btn btn-ghost btn-icon"
                    style={{ height: 38, width: 38 }}
                    onClick={() => setLightbox(true)}
                    title="View image in app"
                  >
                    <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </button>
                )}
              </div>
              {/* Inline thumbnail preview inside the modal */}
              {pictureLink && (() => {
                const src = pictureLink.startsWith('/') ? `${API_BASE}${pictureLink}` : pictureLink;
                return (
                  <div
                    style={{ marginTop: 10, cursor: 'zoom-in', display: 'inline-block' }}
                    onClick={() => setLightbox(true)}
                    title="Click to enlarge"
                  >
                    <img
                      src={src}
                      alt="Assembly"
                      style={{
                        maxWidth: '100%', maxHeight: 180,
                        objectFit: 'contain', borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--surface-2)',
                        display: 'block',
                      }}
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                  </div>
                );
              })()}
            </div>
            {lightbox && (
              <ImageLightbox
                href={pictureLink}
                title={assembly?.partno}
                onClose={() => setLightbox(false)}
              />
            )}
          </div>

          {/* History / Audit Trail (#15) */}
          {auditLog.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontWeight: 600, color: 'var(--ink-3)', marginBottom: 8 }}
                onClick={() => setShowHistory(h => !h)}
              >
                {showHistory ? '▲ Hide' : '▼ Show'} History ({auditLog.length})
              </button>
              {showHistory && (
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  {auditLog.map((entry, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 6, alignItems: 'flex-start' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-4)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        {entry.changed_at ? new Date(entry.changed_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                      </span>
                      <span style={{ color: 'var(--ink-2)', fontWeight: 600, flexShrink: 0 }}>{entry.changed_by || 'System'}</span>
                      <span>
                        {entry.action === 'update' && entry.field ? (
                          <>changed <b>{entry.field}</b>{entry.old_value != null ? <> from &quot;{entry.old_value}&quot;</> : ''} to &quot;{entry.new_value}&quot;</>
                        ) : (
                          entry.action
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          {!showConfirmDelete ? (
            <button className="btn btn-ghost" style={{ color: 'var(--red)', fontWeight: 700 }} onClick={() => setShowConfirmDelete(true)}>DELETE RECORD</button>
          ) : (
            <DeleteConfirm
              onConfirm={(pw) => onDelete(assembly.partno, pw)}
              onCancel={() => setShowConfirmDelete(false)}
            />
          )}

          {onArchive && !assembly.deleted_at && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--amber)', fontWeight: 700, marginLeft: 8 }}
              onClick={() => onArchive(assembly.partno)}
            >Archive</button>
          )}
          {onArchive && assembly.deleted_at && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ color: 'var(--green)', fontWeight: 700, marginLeft: 8 }}
              onClick={() => onArchive(assembly.partno, true)}
            >Restore</button>
          )}

          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={() => { safeClose(); setShowConfirmDelete(false); }}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ height: 38, padding: '0 24px', fontWeight: 700 }}>
            {saving ? 'SAVING…' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </div>
  );
}
