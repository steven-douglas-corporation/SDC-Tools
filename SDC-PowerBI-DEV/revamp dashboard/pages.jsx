/* ============================================================
   SDC — REVAMP pages
   Same data, same calculations as original.
   Improvements per page:
   Exec:   billing group breakdown in hero aside, donut chart
   Hours:  variance summary in hero, progress bars in table
   Util:   group tags, better breakdown layout
   Profit: diverging bars, cleaner zero-line treatment
   Parts:  quoted vs invoiced comparison bars
   Detail: progress bars, better two-row kpi layout
   ============================================================ */
const D = window.SDC;
const PC = D.C;

/* tone helpers — identical logic to original */
const hoursTone = (j)=> j.status==='Overrun' ? PC.yellow : PC.blue;
const plTone    = (d)=> d.value>=0 ? PC.green : PC.yellow;
const utilTone  = (d)=> d.value>=80 ? PC.green : d.value>=60 ? PC.yellow : PC.gray;

/* ============ PAGE 1 · EXECUTIVE SUMMARY ======================== */
function PageExec({ go, pick }){
  const variance = D.totalActual - D.totalQuoted;
  const pct = ((variance/D.totalQuoted)*100).toFixed(1);
  const totalPortfolio = D.statusTable.reduce((s,r)=>s+r.count,0);

  const donutSegs = [
    { label:'On Track', value:42, color:PC.green  },
    { label:'At Risk',  value:9,  color:PC.yellow },
    { label:'Overrun',  value:6,  color:'#E8B800' },
    { label:'Complete', value:18, color:PC.gray   },
  ];

  return (
    <div className="content">
      <QStrip q="How is SDC performing right now?" />
      <Hero
        label="Actual Hours vs Quoted — Project to Date"
        value={fmt(D.totalActual)}
        delta={<Delta pct={`+${pct}%`} dir="up" kind="over" />}
        sub={<>vs <b>{fmt(D.totalQuoted)}</b> quoted · <b>+{fmt(variance)}</b> hrs over plan</>}
        aside={<BillingGroupAside groups={D.billingGroups}/>}
      />
      <div className="kpis c4">
        <Kpi label="Active Jobs"  value="57"  accent={PC.blue}   foot="In progress now" />
        <Kpi label="At-Risk Jobs" value="9"   accent={PC.yellow} tone="warn" foot="Trending over quote" />
        <Kpi label="Employees"    value="31"  accent={PC.navy}   foot="Eng · Mfg · Shop" />
        <Kpi label="Utilization"  value="89%" accent={PC.green}  tone="good" foot="Company-wide" />
      </div>
      <div className="panel-grid" style={{gridTemplateColumns:'1.7fr 1fr'}}>
        <Panel title="Monthly Hours — Actual vs Quoted (12 mo)"
          legend={<><Lg c={PC.blue} t="Actual"/><Lg c={PC.navy} t="Quoted"/></>}>
          <LineTrend data={D.monthlyTrend}
            keys={[{k:'actual',color:PC.blue,label:'Actual'},{k:'quoted',color:PC.navy,label:'Quoted',dash:'6 4'}]}/>
        </Panel>
        <Panel title="Portfolio Status">
          <Donut
            segments={donutSegs}
            center={{top: totalPortfolio, bot:'total jobs'}}
          />
        </Panel>
      </div>
    </div>
  );
}

/* ============ PAGE 2 · JOB HOURS ================================ */
function PageHours({ go, pick }){
  const top = [...D.jobs].sort((a,b)=>b.hoursActual-a.hoursActual).slice(0,10)
    .map(j=>({ label:`${j.id} · ${j.name}`, value:j.hoursActual, id:j.id, status:j.status }));

  return (
    <div className="content">
      <div className="qstrip" style={{justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span className="q-eyebrow">This page answers</span>
          <span className="q-divider">·</span>
          <span className="q-text">"Which jobs are using the most hours?"</span>
        </div>
        <div className="slicers">
          <Slicer label="Job Status"  value="All" />
          <Slicer label="Date Range"  value="Project to date" />
          <Slicer label="Customer"    value="All customers" />
        </div>
      </div>
      <Hero
        label="Total Actual Hours — Project to Date"
        value={fmt(D.jobHours.totalActual)}
        sub={<>Logged across <b>57</b> active jobs · avg <b>{fmt(D.jobHours.avgPerJob)}</b> hrs / job</>}
        aside={
          <div style={{display:'flex',gap:22}}>
            {[
              ['Over Quoted','23',PC.yellow,'#9a7300'],
              ['Under Quoted','28',PC.green,'#3d6906'],
              ['No Quote','6',PC.gray,'#5a6470'],
            ].map(([l,v,bg,tc])=>(
              <div key={l} style={{textAlign:'center'}}>
                <div className="mont" style={{fontSize:30,fontWeight:800,color:tc,lineHeight:1}}>{v}</div>
                <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',
                  letterSpacing:'.08em',color:'#9AAFC4',marginTop:3}}>{l}</div>
              </div>
            ))}
          </div>
        }
      />
      <div className="kpis c4">
        <Kpi label="Over Quoted"   value="23" accent={PC.yellow} tone="warn" foot="Actual > quote" />
        <Kpi label="Under Quoted"  value="28" accent={PC.green}  foot="Actual < quote" />
        <Kpi label="No Quote"      value="6"  accent={PC.gray}   foot="Unquoted jobs" />
        <Kpi label="Avg Hrs / Job" value={fmt(D.jobHours.avgPerJob)} accent={PC.blue} foot="Mean actual hours" />
      </div>
      <Panel title="Top 10 Jobs by Actual Hours"
        legend={<><Lg c={PC.blue} t="On plan"/><Lg c={PC.yellow} t="Overrun"/><span className="drillhint">↳ click a bar for job detail</span></>}>
        <HBar data={top} colorFor={hoursTone} valueFmt={fmt} onPick={(id)=>pick(id)} />
      </Panel>
    </div>
  );
}

/* ============ PAGE 3 · EMPLOYEE UTILIZATION ===================== */
function PageUtil({ go, pick }){
  const data = [...D.employeeUtil].sort((a,b)=>b.util-a.util)
    .map(e=>({ label:e.name, value:e.util, id:e.name, group:e.group }));

  const groupAvg = (grp) => {
    const members = D.employeeUtil.filter(e=>e.group===grp);
    return Math.round(members.reduce((s,e)=>s+e.util,0)/members.length);
  };

  return (
    <div className="content">
      <QStrip q="Are our people utilized well?" />
      <Hero
        label="Company Utilization"
        value="89%"
        delta={<span className="delta good"><span className="delta-arrow">▲</span>on target</span>}
        sub={<>Target <b>≥ 80%</b> · 31 employees · threshold crossed in Sep 2025</>}
        aside={
          <div style={{display:'flex',gap:20,alignItems:'center'}}>
            {[['Engineering',groupAvg('Engineering'),PC.blue],
              ['Shop',groupAvg('Shop'),PC.navy],
              ['Manufacturing',groupAvg('Manufacturing'),PC.green]
            ].map(([g,v,c])=>(
              <div key={g} style={{textAlign:'center'}}>
                <div className="mont" style={{fontSize:28,fontWeight:800,color:PC.navy,lineHeight:1}}>{v}%</div>
                <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',
                  letterSpacing:'.07em',color:'#9AAFC4',marginTop:3}}>{g}</div>
                <div style={{marginTop:5,height:3,background:c,borderRadius:999}}></div>
              </div>
            ))}
          </div>
        }
      />
      <div className="kpis c4">
        <Kpi label="Total Employees" value="31"              accent={PC.navy}   foot="On the clock" />
        <Kpi label="Billable Hours"  value={fmt(D.util.billable)}  accent={PC.blue} foot="This month" />
        <Kpi label="Non-Billable"    value={fmt(D.util.nonBillable)} accent={PC.gray} foot="Warranty + indirect" />
        <Kpi label="Overtime Hours"  value={fmt(D.util.overtime)}   accent={PC.yellow} tone="warn" foot="Beyond standard" />
      </div>
      <Panel title="Utilization by Employee"
        legend={<><Lg c={PC.green} t="≥ 80% · on target"/><Lg c={PC.yellow} t="60–80% · watch"/><Lg c={PC.gray} t="< 60% · low"/></>}>
        <HBar data={data} colorFor={utilTone} valueFmt={(v)=>v+'%'} max={110} />
      </Panel>
    </div>
  );
}

/* ============ PAGE 4 · PROFITABILITY ============================ */
function PageProfit({ go, pick }){
  /* top 6 profitable + bottom 4 loss jobs, deduped, sorted by P/L desc */
  const top = [...D.jobs].sort((a,b)=>b.pl-a.pl).slice(0,6)
    .concat([...D.jobs].sort((a,b)=>a.pl-b.pl).slice(0,4))
    .filter((v,i,a)=>a.findIndex(x=>x.id===v.id)===i)
    .sort((a,b)=>b.pl-a.pl)
    .map(j=>({ label:`${j.id} · ${j.name}`, value:j.pl, id:j.id }));

  return (
    <div className="content">
      <QStrip q="Are our jobs making money?" />
      <Hero
        label="Total Profit / Loss — Net"
        value={usdK(D.profit.total)}
        delta={<span className="delta good"><span className="delta-arrow">▲</span>profitable</span>}
        sub={<>Across active &amp; completed jobs · <b>margin % shown for completed jobs only</b></>}
        aside={
          <div style={{display:'flex',gap:24,alignItems:'center'}}>
            <div style={{textAlign:'center'}}>
              <div className="mont" style={{fontSize:30,fontWeight:800,color:'#3d6906',lineHeight:1}}>41</div>
              <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',
                letterSpacing:'.08em',color:'#9AAFC4',marginTop:3}}>Profitable</div>
            </div>
            <div style={{width:1,height:36,background:'#E0E6ED'}}></div>
            <div style={{textAlign:'center'}}>
              <div className="mont" style={{fontSize:30,fontWeight:800,color:'#9a7300',lineHeight:1}}>9</div>
              <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',
                letterSpacing:'.08em',color:'#9AAFC4',marginTop:3}}>At a Loss</div>
            </div>
          </div>
        }
      />
      <div className="kpis c4">
        <Kpi label="Jobs Profitable" value="41"     accent={PC.green}  tone="good" foot="Positive P/L" />
        <Kpi label="Jobs at Loss"    value="9"      accent={PC.yellow} tone="warn" foot="Negative P/L" />
        <Kpi label="Best Job"   value="+$284K" accent={PC.green}  foot="1106 · SDC Clip-iT 1.1" />
        <Kpi label="Worst Job"  value="–$112K" accent={PC.yellow} foot="1079 · Dup. Paragon Cell" />
      </div>
      <Panel title="Top Jobs by Profit / Loss ($) — rank by dollars, not margin %"
        legend={<><Lg c={PC.green} t="Profit"/><Lg c={PC.yellow} t="Loss"/><span className="drillhint">↳ click for job detail</span></>}>
        <HBar data={top} colorFor={plTone} valueFmt={usdK} onPick={(id)=>pick(id)} />
      </Panel>
    </div>
  );
}

/* ============ PAGE 5 · PARTS & COSTS ============================ */
function PageParts({ go, pick }){
  const top = [...D.jobs].sort((a,b)=>b.parts-a.parts).slice(0,10)
    .map(j=>({ label:`${j.id} · ${j.name}`, value:j.parts, id:j.id,
               quoted:j.partsQuoted }));
  return (
    <div className="content">
      <div className="qstrip" style={{justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span className="q-eyebrow">This page answers</span>
          <span className="q-divider">·</span>
          <span className="q-text">"Where is parts spend going?"</span>
        </div>
        <div className="slicers">
          <Slicer label="Category"     value="All" />
          <Slicer label="Manufacturer" value="All" />
          <Slicer label="Invoiced Date" value="FYTD 2026" />
        </div>
      </div>
      <Hero
        label="Total Invoiced Parts Cost"
        value={usd(D.parts.invoiced)}
        sub={<>Across <b>{fmt(D.parts.poLines)}</b> PO lines · invoiced &amp; matched to jobs</>}
        aside={
          <div style={{display:'flex',gap:22}}>
            {[
              ['PO Lines', fmt(D.parts.poLines), PC.navy, '#061D39'],
              ['Left to Spend', usdK(D.parts.leftToSpend), PC.blue, '#1574C4'],
              ['Unmatched POs', '12', PC.yellow, '#9a7300'],
            ].map(([l,v,bg,tc])=>(
              <div key={l} style={{textAlign:'center'}}>
                <div className="mont" style={{fontSize:26,fontWeight:800,color:tc,lineHeight:1}}>{v}</div>
                <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',
                  letterSpacing:'.07em',color:'#9AAFC4',marginTop:3}}>{l}</div>
              </div>
            ))}
          </div>
        }
      />
      <div className="kpis c4">
        <Kpi label="PO Lines"       value={fmt(D.parts.poLines)}    accent={PC.navy} foot="Invoiced lines" />
        <Kpi label="Avg Cost / Job" value={usd(D.parts.avgPerJob)}  accent={PC.blue} foot="Mean per active job" />
        <Kpi label="Unmatched POs"  value="12" accent={PC.yellow} tone="warn" foot="Need a job link" />
        <Kpi label="Left to Spend"  value={usd(D.parts.leftToSpend)} accent={PC.blue} foot="Purchased, unpaid" />
      </div>
      <Panel title="Top 10 Jobs by Invoiced Parts Cost"
        legend={<><Lg c={PC.blue} t="Invoiced $"/><span className="drillhint">↳ click for job detail</span></>}>
        <HBar data={top} colorFor={()=>PC.blue} valueFmt={usdK} onPick={(id)=>pick(id)} />
      </Panel>
    </div>
  );
}

/* ============ PAGE 6 · JOB DETAIL (drill-through) =============== */
function PageDetail({ go, jobId, setJob }){
  const job = D.jobs.find(j=>j.id===jobId) || D.jobs[0];
  const [open,setOpen] = React.useState(false);
  const variance = job.hoursActual - job.hoursQuoted;
  const varPct = job.hoursQuoted ? ((variance/job.hoursQuoted)*100).toFixed(1) : '—';
  const profPct = job.status==='Complete'
    ? Math.round(job.pl/(job.hoursActual*120+job.parts)*100)
    : null;
  const months = D.jobMonthly(job);
  const emps   = D.jobEmployees(job);

  const statusCfg = {
    'Overrun': PC.yellow, 'At Risk': '#E8B800',
    'On Track': PC.green, 'Complete': PC.gray,
  };

  return (
    <div className="content">
      {/* top bar: question + job selector + back */}
      <div className="qstrip" style={{justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span className="q-eyebrow">This page answers</span>
          <span className="q-divider">·</span>
          <span className="q-text">"Everything about this one job"</span>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <div style={{position:'relative'}}>
            <div className="slicer-box active" style={{minWidth:248,maxWidth:248}}
              onClick={()=>setOpen(o=>!o)}>
              <span style={{fontWeight:700,whiteSpace:'nowrap',overflow:'hidden',
                textOverflow:'ellipsis'}}>{job.id} · {job.name}</span>
              <span className="chev">▼</span>
            </div>
            {open && (
              <div style={{position:'absolute',top:'calc(100% + 4px)',left:0,right:0,
                zIndex:30,background:'#fff',border:'1px solid var(--card-border)',
                borderRadius:8,boxShadow:'0 12px 30px rgba(6,29,57,.18)',
                maxHeight:280,overflowY:'auto'}}>
                {D.jobs.map(j=>(
                  <div key={j.id} onClick={()=>{setJob(j.id); setOpen(false);}}
                    style={{padding:'8px 11px',fontSize:11.5,
                      fontWeight:j.id===job.id?700:500,
                      cursor:'pointer',
                      background:j.id===job.id?'rgba(21,116,196,.08)':'#fff',
                      color:'var(--ink)',
                      borderBottom:'1px solid #F0F3F6'}}
                    onMouseEnter={e=>e.currentTarget.style.background='rgba(21,116,196,.05)'}
                    onMouseLeave={e=>e.currentTarget.style.background=j.id===job.id?'rgba(21,116,196,.08)':'#fff'}>
                    <span style={{color:'#9AAFC4',marginRight:6}}>{j.id}</span>{j.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="backbtn" onClick={()=>go('hours')}>← Back</div>
        </div>
      </div>

      {/* job sub-header */}
      <div className="subhdr">
        <div>
          <div style={{fontSize:9,fontWeight:700,letterSpacing:'.12em',
            textTransform:'uppercase',color:'#4A6680',marginBottom:3}}>Job</div>
          <div className="jb-name">{job.id} · {job.name}</div>
        </div>
        <div className="jb-divider"/>
        <div className="jb-meta">
          <div className="jb-field">
            <div className="jb-k">Customer</div>
            <div className="jb-v">{job.customer}</div>
          </div>
          <div className="jb-field">
            <div className="jb-k">Status</div>
            <div className="jb-v" style={{color:statusCfg[job.status]||'#fff'}}>{job.status}</div>
          </div>
          <div className="jb-field">
            <div className="jb-k">Type</div>
            <div className="jb-v">{job.type}</div>
          </div>
          <div className="jb-field">
            <div className="jb-k">Hours Progress</div>
            <div className="jb-v" style={{paddingTop:2}}>
              <ProgressBar actual={job.hoursActual} quoted={job.hoursQuoted} />
            </div>
          </div>
        </div>
      </div>

      {/* KPI row 1 — hours */}
      <div className="kpis c4">
        <Kpi label="Actual Hours"   value={fmt(job.hoursActual)}  accent={PC.blue} />
        <Kpi label="Quoted Hours"   value={job.hoursQuoted?fmt(job.hoursQuoted):'—'} accent={PC.navy} />
        <Kpi label="ETC Hours"      value={fmt(job.etc)} accent={PC.light} foot="Est. to complete" />
        <Kpi label="Hours Variance"
          value={(variance>0?'+':'')+fmt(variance)}
          accent={variance>0?PC.yellow:PC.green}
          tone={variance>0?'warn':'good'}
          foot={varPct==='—'?'no quote':`${variance>0?'+':''}${varPct}% vs quote`} />
      </div>

      {/* KPI row 2 — financials */}
      <div className="kpis c4">
        <Kpi label="Parts Invoiced" value={usd(job.parts)}  accent={PC.blue} />
        <Kpi label="Parts Quoted"   value={job.partsQuoted?usd(job.partsQuoted):'—'} accent={PC.navy} />
        <Kpi label="Profit / Loss"  value={usdK(job.pl)}
          accent={job.pl>=0?PC.green:PC.yellow}
          tone={job.pl>=0?'good':'warn'} />
        <Kpi label="Profitability %"
          value={profPct !== null ? profPct+'%' : '—'}
          accent={PC.gray}
          foot={profPct !== null ? 'fully booked' : 'completed jobs only'} />
      </div>

      {/* bottom panels */}
      <div className="panel-grid" style={{gridTemplateColumns:'1.55fr 1fr'}}>
        <Panel title="Monthly Hours — This Job"
          legend={<><Lg c={PC.blue} t="Actual"/><Lg c={PC.navy} t="Quoted"/></>}>
          <LineTrend data={months}
            keys={[{k:'actual',color:PC.blue,label:'Actual'},{k:'quoted',color:PC.navy,label:'Quoted',dash:'6 4'}]}/>
        </Panel>
        <Panel title="Employee Hours on This Job">
          <table className="tbl">
            <thead>
              <tr><th>Employee</th><th>Dept</th><th className="num">Hours</th></tr>
            </thead>
            <tbody>
              {emps.map(e=>(
                <tr key={e.name}>
                  <td style={{fontWeight:600}}>{e.name}</td>
                  <td><GroupTag group={e.dept}/></td>
                  <td className="num">{fmt(e.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

Object.assign(window, { PageExec, PageHours, PageUtil, PageProfit, PageParts, PageDetail });
