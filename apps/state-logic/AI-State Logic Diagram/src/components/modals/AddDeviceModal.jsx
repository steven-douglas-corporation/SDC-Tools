/**
 * AddDeviceModal - Add or edit a device in the current state machine.
 * Adapts fields based on device type (cylinder, gripper, servo, etc.)
 */

import { useState, useEffect } from 'react';
import { DEVICE_TYPES, DEVICE_CATEGORIES } from '../../lib/deviceTypes.js';
import { useDiagramStore } from '../../store/useDiagramStore.js';

function PositionRow({ pos, index, onChange, onRemove }) {
  return (
    <div className="position-row">
      <input
        className="form-input"
        value={pos.name}
        onChange={e => onChange(index, 'name', e.target.value)}
        placeholder="PositionName (e.g. CutPosition)"
        style={{ flex: 2 }}
      />
      <input
        className="form-input"
        type="number"
        value={pos.defaultValue ?? 0}
        onChange={e => onChange(index, 'defaultValue', parseFloat(e.target.value))}
        placeholder="0.0"
        style={{ flex: 1, marginLeft: 6 }}
        title="Default position value (mm or degrees)"
      />
      <label className="form-checkbox-row" style={{ marginLeft: 6, marginBottom: 0, whiteSpace: 'nowrap' }}>
        <input
          type="checkbox"
          checked={pos.isRecipe ?? false}
          onChange={e => onChange(index, 'isRecipe', e.target.checked)}
        />
        <span>Recipe</span>
      </label>
      <button
        className="icon-btn icon-btn--sm icon-btn--danger"
        style={{ marginLeft: 6 }}
        onClick={() => onRemove(index)}
        title="Remove position"
      >✕</button>
    </div>
  );
}

export function AddDeviceModal() {
  const store = useDiagramStore();
  const sm = store.getActiveSm();
  const isEdit = store.showEditDeviceModal;
  const editId = store.editDeviceId;
  const existingDevice = isEdit ? sm?.devices?.find(d => d.id === editId) : null;

  const [type, setType] = useState(existingDevice?.type ?? 'PneumaticLinearActuator');
  const [displayName, setDisplayName] = useState(existingDevice?.displayName ?? '');
  const [name, setName] = useState(existingDevice?.name ?? '');
  const [sensorArrangement, setSensorArrangement] = useState(
    existingDevice?.sensorArrangement ?? DEVICE_TYPES['PneumaticLinearActuator'].defaultSensorArrangement
  );
  const [axisNumber, setAxisNumber] = useState(existingDevice?.axisNumber ?? 1);
  const [positions, setPositions] = useState(existingDevice?.positions ?? []);
  const [extTimerMs, setExtTimerMs] = useState(existingDevice?.extTimerMs ?? 500);
  const [retTimerMs, setRetTimerMs] = useState(existingDevice?.retTimerMs ?? 500);
  const [engageTimerMs, setEngageTimerMs] = useState(existingDevice?.engageTimerMs ?? 300);
  const [disengageTimerMs, setDisengageTimerMs] = useState(existingDevice?.disengageTimerMs ?? 300);
  const [vacOnTimerMs, setVacOnTimerMs] = useState(existingDevice?.vacOnTimerMs ?? 300);
  const [hasEject, setHasEject] = useState(existingDevice?.hasEject ?? false);
  const [timerMs, setTimerMs] = useState(existingDevice?.timerMs ?? 1000);

  // Auto-generate PLC name from display name
  useEffect(() => {
    if (!isEdit || !existingDevice) {
      const generated = displayName.replace(/[^a-zA-Z0-9]/g, '');
      setName(generated);
    }
  }, [displayName]);

  function handleTypeChange(newType) {
    setType(newType);
    setSensorArrangement(DEVICE_TYPES[newType]?.defaultSensorArrangement ?? '');
    setPositions([]);
  }

  function addPosition() {
    setPositions(prev => [...prev, { name: '', defaultValue: 0, isRecipe: false }]);
  }

  function updatePosition(index, field, value) {
    setPositions(prev => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
  }

  function removePosition(index) {
    setPositions(prev => prev.filter((_, i) => i !== index));
  }

  function handleClose() {
    if (isEdit) store.closeEditDeviceModal();
    else store.closeAddDeviceModal();
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!displayName.trim() || !name.trim()) return;
    if (!sm) return;

    const deviceData = {
      type,
      displayName: displayName.trim(),
      name: name.trim(),
      sensorArrangement,
      axisNumber: Number(axisNumber) || 1,
      positions: type === 'ServoAxis' ? positions : undefined,
      extTimerMs: Number(extTimerMs),
      retTimerMs: Number(retTimerMs),
      engageTimerMs: Number(engageTimerMs),
      disengageTimerMs: Number(disengageTimerMs),
      vacOnTimerMs: Number(vacOnTimerMs),
      hasEject,
      timerMs: Number(timerMs),
    };

    if (isEdit && editId) {
      store.updateDevice(sm.id, editId, deviceData);
    } else {
      store.addDevice(sm.id, deviceData);
    }

    handleClose();
  }

  const typeInfo = DEVICE_TYPES[type];
  const sensorOptions = typeInfo?.sensorArrangements ?? [];
  const isServo = type === 'ServoAxis';
  const isPneumatic = ['PneumaticLinearActuator', 'PneumaticRotaryActuator'].includes(type);
  const isGripper = type === 'PneumaticGripper';
  const isVac = type === 'PneumaticVacGenerator';
  const isTimer = type === 'Timer';

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div className="modal" style={{ width: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="modal__header">
          <span>{isEdit ? 'Edit Device' : 'Add Device'}</span>
          <button className="icon-btn" onClick={handleClose}>✕</button>
        </div>

        <form className="modal__body" onSubmit={handleSubmit}>

          {/* Device Type */}
          {!isEdit && (
            <>
              <label className="form-label">Device Type *</label>
              <div className="device-type-grid">
                {Object.entries(DEVICE_TYPES).map(([key, info]) => (
                  <button
                    key={key}
                    type="button"
                    className={`device-type-card${type === key ? ' device-type-card--selected' : ''}`}
                    style={{ '--card-color': info.color }}
                    onClick={() => handleTypeChange(key)}
                  >
                    <span className="device-type-card__icon">{info.icon}</span>
                    <span className="device-type-card__label">{info.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {isEdit && (
            <div className="props-info-box">
              <div className="props-info-box__label">Type</div>
              <div className="props-info-box__value">
                {typeInfo?.icon} {typeInfo?.label}
              </div>
            </div>
          )}

          {/* Display Name */}
          <label className="form-label">Device Name *</label>
          <input
            className="form-input"
            autoFocus={!isEdit}
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={`e.g. Post Cutter Cylinder`}
          />
          <div className="form-hint">Plain English name as seen by the ME</div>

          {/* PLC Tag Name */}
          <label className="form-label">PLC Tag Stem *</label>
          <input
            className="form-input mono"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. PostCutterCylinder"
          />
          <div className="form-hint">PascalCase, no spaces — used in all generated tag names</div>

          {/* Sensor arrangement for pneumatics */}
          {sensorOptions.length > 0 && (
            <>
              <label className="form-label">Sensor Arrangement</label>
              <select
                className="form-select"
                value={sensorArrangement}
                onChange={e => setSensorArrangement(e.target.value)}
              >
                {sensorOptions.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </>
          )}

          {/* Timer presets for pneumatics */}
          {isPneumatic && (
            <div className="form-row-2">
              <div>
                <label className="form-label">Extend Verify Timer (ms)</label>
                <input className="form-input" type="number" min="0" step="100" value={extTimerMs}
                  onChange={e => setExtTimerMs(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Retract Verify Timer (ms)</label>
                <input className="form-input" type="number" min="0" step="100" value={retTimerMs}
                  onChange={e => setRetTimerMs(e.target.value)} />
              </div>
            </div>
          )}

          {isGripper && (
            <div className="form-row-2">
              <div>
                <label className="form-label">Engage Timer (ms)</label>
                <input className="form-input" type="number" min="0" step="100" value={engageTimerMs}
                  onChange={e => setEngageTimerMs(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Disengage Timer (ms)</label>
                <input className="form-input" type="number" min="0" step="100" value={disengageTimerMs}
                  onChange={e => setDisengageTimerMs(e.target.value)} />
              </div>
            </div>
          )}

          {isVac && (
            <>
              <label className="form-label">Vac On Verify Timer (ms)</label>
              <input className="form-input" type="number" min="0" step="100" value={vacOnTimerMs}
                onChange={e => setVacOnTimerMs(e.target.value)} />
              <label className="form-checkbox-row">
                <input type="checkbox" checked={hasEject}
                  onChange={e => setHasEject(e.target.checked)} />
                <span>Has Eject (VacOnEject) solenoid</span>
              </label>
            </>
          )}

          {isTimer && (
            <>
              <label className="form-label">Default Delay (ms)</label>
              <input className="form-input" type="number" min="0" step="100" value={timerMs}
                onChange={e => setTimerMs(e.target.value)} />
            </>
          )}

          {/* Servo: axis number + positions */}
          {isServo && (
            <>
              <label className="form-label">Axis Number (for a{'{nn}'}_ prefix)</label>
              <input
                className="form-input"
                type="number"
                min="1"
                max="99"
                value={axisNumber}
                onChange={e => setAxisNumber(e.target.value)}
                placeholder="1"
              />

              <div className="props-actions-header" style={{ marginTop: 12 }}>
                <span className="form-label" style={{ marginBottom: 0 }}>Positions</span>
                <button type="button" className="btn btn--xs btn--primary" onClick={addPosition}>
                  + Add Position
                </button>
              </div>
              <div className="form-hint">Define all reachable positions for this axis</div>

              {positions.length === 0 && (
                <div className="props-empty">No positions yet. Click + Add Position.</div>
              )}
              {positions.map((pos, i) => (
                <PositionRow
                  key={i}
                  pos={pos}
                  index={i}
                  onChange={updatePosition}
                  onRemove={removePosition}
                />
              ))}
              <div className="form-hint" style={{ marginTop: 4 }}>
                "Recipe" positions appear as <span className="mono">p_</span> tags (HMI/recipe visible)
              </div>
            </>
          )}

          {/* Tag preview */}
          {name && (
            <div className="props-info-box" style={{ marginTop: 12 }}>
              <div className="props-info-box__label">Sample Generated Tags</div>
              <div className="props-info-box__value mono" style={{ fontSize: 11, lineHeight: 1.8 }}>
                {isPneumatic && (
                  <>
                    i_{name}Ext<br />
                    i_{name}Ret<br />
                    q_Ext{name}<br />
                    q_Ret{name}<br />
                    {name}ExtDelay (TIMER)<br />
                  </>
                )}
                {isGripper && (
                  <>
                    i_{name}Engage<br />
                    q_Engage{name}<br />
                    q_Disengage{name}<br />
                  </>
                )}
                {isVac && (
                  <>
                    i_{name}VacOn<br />
                    q_VacOn{name}<br />
                    q_VacOff{name}<br />
                  </>
                )}
                {isServo && (
                  <>
                    a{String(axisNumber).padStart(2,'0')}_{name} (AXIS_CIP_DRIVE)<br />
                    {positions.map(p => p.name ? `p_${name}${p.name}${p.isRecipe ? ' [recipe]' : ''}\n` : null)}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="modal__footer">
            <button type="button" className="btn btn--secondary" onClick={handleClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={!displayName.trim() || !name.trim()}>
              {isEdit ? 'Save Changes' : 'Add Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
