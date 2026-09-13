/* ============================================================
   SDC Job Hours Report — app shell, routing, drill-through
   ============================================================ */
const { useState: uS, useEffect: uE } = React;

const TITLES = {
  exec:   ['Executive Summary',     'Company hours, jobs & people'],
  hours:  ['Job Hours',             'Actual hours by job'],
  util:   ['Employee Utilization',  'Workforce utilization & billable mix'],
  profit: ['Profitability',         'Job-level profit & loss'],
  parts:  ['Parts & Costs',         'Invoiced parts spend by job'],
  detail: ['Job Detail',            'Single-job deep dive'],
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "comfortable",
  "heroScale": 1,
  "showQuestion": true,
  "showDrillHints": true
}/*EDITMODE-END*/;

function App(){
  const [tw,setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [page,setPage] = uS(()=> (localStorage.getItem('sdc_page')||'exec'));
  const [jobId,setJobId] = uS(()=> (localStorage.getItem('sdc_job')||'1118'));

  uE(()=>{ localStorage.setItem('sdc_page',page); },[page]);
  uE(()=>{ localStorage.setItem('sdc_job',jobId); },[jobId]);

  uE(()=>{
    const c=document.getElementById('canvas');
    c.setAttribute('data-density', tw.density);
    c.style.setProperty('--hero-fs', (72*tw.heroScale)+'px');
    c.classList.toggle('hide-q', !tw.showQuestion);
    c.classList.toggle('hide-drill', !tw.showDrillHints);
  },[tw.density,tw.heroScale,tw.showQuestion,tw.showDrillHints]);

  const go = (p)=>setPage(p);
  const pick = (id)=>{ setJobId(id); setPage('detail'); };

  const [title,sub] = TITLES[page];
  const headerSub = page==='detail'
    ? 'Drill-through · single-job analysis'
    : `${sub} · Refreshed thru ${window.SDC.meta.refreshedThru}`;
  let body;
  if (page==='exec')   body=<PageExec   go={go} pick={pick}/>;
  else if (page==='hours')  body=<PageHours  go={go} pick={pick}/>;
  else if (page==='util')   body=<PageUtil   go={go} pick={pick}/>;
  else if (page==='profit') body=<PageProfit go={go} pick={pick}/>;
  else if (page==='parts')  body=<PageParts  go={go} pick={pick}/>;
  else body=<PageDetail go={go} jobId={jobId} setJob={setJobId}/>;

  return (
    <div className="shell">
      <Rail page={page} go={go}/>
      <Header title={title} sub={headerSub}/>
      {body}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={tw.density}
          options={['comfortable','compact']}
          onChange={(v)=>setTweak('density',v)} />
        <TweakSlider label="Hero number" value={tw.heroScale} min={0.8} max={1.2} step={0.05}
          onChange={(v)=>setTweak('heroScale',v)} />
        <TweakSection label="Show / hide" />
        <TweakToggle label={'\u201CThis page answers\u201D strip'} value={tw.showQuestion}
          onChange={(v)=>setTweak('showQuestion',v)} />
        <TweakToggle label="Drill-through hints" value={tw.showDrillHints}
          onChange={(v)=>setTweak('showDrillHints',v)} />
      </TweaksPanel>
    </div>
  );
}

/* ---- stage scaler ---- */
function fit(){
  const c=document.getElementById('canvas');
  const s=Math.min(window.innerWidth/1280, window.innerHeight/720);
  c.style.transform='translate(-50%,-50%) scale('+s+')';
}
window.addEventListener('resize', fit);

ReactDOM.createRoot(document.getElementById('canvas')).render(<App/>);
fit();
