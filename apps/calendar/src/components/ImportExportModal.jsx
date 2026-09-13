import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { generateICS, parseICS, downloadFile, fmtDateShort } from '../utils.js';
import { Icon } from '../constants.jsx';

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
            const hoursIdx = headers.findIndex(h => h.includes('hours'));
            const statusIdx = headers.findIndex(h => h.includes('status'));
            const descIdx = headers.findIndex(h => h.includes('description'));

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

export default ImportExportModal;
