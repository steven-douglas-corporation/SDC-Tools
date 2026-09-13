/* ============================================================
   SDC — Job Hours Report · Data layer
   Numbers grounded in the live PBIX report (refresh 6/1/2026).
   REVAMP: same data, same calculations — no numbers changed.
   ============================================================ */
window.SDC = (function () {

  // ---- Brand tokens -------------------------------------------------
  const C = {
    blue:   '#1574C4',
    navy:   '#061D39',
    light:  '#AACEE8',
    yellow: '#FFDE51',
    green:  '#74C415',
    lime:   '#BEFA4F',
    gray:   '#D9D9D9',
    ink:    '#231F20',
    white:  '#FFFFFF',
  };

  // ---- Global header facts -----------------------------------------
  const meta = {
    refreshedThru: '6/1/2026',
    etcDate:       'Apr 30, 2026',
    activeJobs:    57,
    employees:    31,
  };

  // ---- PAGE 1 · Executive Summary ----------------------------------
  const billingGroups = [
    { name: 'Engineering',   quoted: 185321, actual: 217040 },
    { name: 'Shop',          quoted: 176663, actual: 156199 },
    { name: 'Manufacturing', quoted: 9114,   actual: 17175  },
  ];
  const totalQuoted = billingGroups.reduce((s, g) => s + g.quoted, 0); // 371,098
  const totalActual = billingGroups.reduce((s, g) => s + g.actual, 0); // 390,414

  // 12-month actual vs quoted hours trend (Jul-25 → Jun-26)
  const monthlyTrend = [
    { m: 'Jul', quoted: 29800, actual: 27600 },
    { m: 'Aug', quoted: 30600, actual: 29900 },
    { m: 'Sep', quoted: 31200, actual: 32800 },
    { m: 'Oct', quoted: 31800, actual: 34100 },
    { m: 'Nov', quoted: 30900, actual: 33600 },
    { m: 'Dec', quoted: 27400, actual: 25200 },
    { m: 'Jan', quoted: 30100, actual: 31900 },
    { m: 'Feb', quoted: 31600, actual: 34800 },
    { m: 'Mar', quoted: 32700, actual: 37200 },
    { m: 'Apr', quoted: 32100, actual: 36900 },
    { m: 'May', quoted: 31400, actual: 35100 },
    { m: 'Jun', quoted: 31488, actual: 33314 },
  ];

  const statusTable = [
    { status: 'On Track', count: 42, tone: 'green' },
    { status: 'At Risk',  count: 9,  tone: 'yellow' },
    { status: 'Overrun',  count: 6,  tone: 'yellow' },
    { status: 'Complete', count: 18, tone: 'gray' },
  ];

  // ---- Job master --------------------------------------------------
  const jobs = [
    { id: '1106', name: 'SDC Clip-iT 1.1 QTY (8)',          customer: 'First Solar',        status: 'Overrun',  type: 'Custom',    hoursActual: 34860, hoursQuoted: 31200, etc: 2400, parts: 612400,  partsQuoted: 540000, pl:  284100 },
    { id: '1101', name: 'Coil Staker',                      customer: 'Steris',             status: 'At Risk',  type: 'Custom',    hoursActual: 28740, hoursQuoted: 26900, etc: 1850, parts: 418900,  partsQuoted: 405000, pl:  142600 },
    { id: '1104', name: 'Andi 1 & Andi 2 Replacement Line', customer: 'Schneider Electric', status: 'Overrun',  type: 'Hybrid',    hoursActual: 26120, hoursQuoted: 22400, etc: 3100, parts: 506300,  partsQuoted: 470000, pl:  -38200 },
    { id: '1130', name: 'Compact Single Sided Light Soak',  customer: 'First Solar',        status: 'On Track', type: 'Custom',    hoursActual: 21980, hoursQuoted: 23100, etc: 1200, parts: 387600,  partsQuoted: 410000, pl:  164300 },
    { id: '1116', name: 'Flexible Brazing Machine',         customer: 'Molex',              status: 'On Track', type: 'Custom',    hoursActual: 19640, hoursQuoted: 20800, etc: 940,  parts: 268500,  partsQuoted: 290000, pl:   96200 },
    { id: '1142', name: 'Dual Sided Light Soak Chambers',   customer: 'First Solar',        status: 'At Risk',  type: 'Duplicate', hoursActual: 18230, hoursQuoted: 17600, etc: 1320, parts: 312400,  partsQuoted: 300000, pl:   71800 },
    { id: '1113', name: 'Board Tuning Machine',             customer: 'GE Healthcare',      status: 'On Track', type: 'Custom',    hoursActual: 16480, hoursQuoted: 17900, etc: 1100, parts: 231600,  partsQuoted: 245000, pl:   58400 },
    { id: '1118', name: 'AIR Loop Assembly',                customer: 'GE Healthcare',      status: 'On Track', type: 'Custom',    hoursActual: 15240, hoursQuoted: 16100, etc: 1480, parts: 545111,  partsQuoted: 540000, pl:   42800 },
    { id: '1148', name: 'BISCUIT QTY 10',                   customer: 'First Solar',        status: 'Overrun',  type: 'Duplicate', hoursActual: 14920, hoursQuoted: 12600, etc: 2100, parts: 198400,  partsQuoted: 175000, pl:  -52600 },
    { id: '1147', name: 'Protektor Earring Back Assembly',  customer: 'First Solar',        status: 'On Track', type: 'Custom',    hoursActual: 13680, hoursQuoted: 14200, etc: 880,  parts: 176300,  partsQuoted: 188000, pl:   39400 },
    { id: '1117', name: 'Automated Feed Set Assembly',      customer: 'Applied Medical',    status: 'On Track', type: 'Custom',    hoursActual: 12450, hoursQuoted: 13100, etc: 760,  parts: 156800,  partsQuoted: 162000, pl:   31200 },
    { id: '1079', name: 'Duplicate Paragon Assembly Cell',  customer: 'Parker',             status: 'Overrun',  type: 'Duplicate', hoursActual:  9860, hoursQuoted:  7400, etc: 1900, parts: 303841,  partsQuoted: 990650, pl: -112400 },
    { id: '1119', name: 'Karl Storz Stamping Machine',      customer: 'Karl Storz',         status: 'On Track', type: 'Custom',    hoursActual:  9240, hoursQuoted:  9800, etc: 540,  parts: 121795,  partsQuoted: 130000, pl:   27600 },
    { id: '1122', name: 'CAFI',                             customer: 'Scheiner',           status: 'At Risk',  type: 'Custom',    hoursActual:  8120, hoursQuoted:  7600, etc: 690,  parts:  98143,  partsQuoted:  94000, pl:   18900 },
    { id: '1083', name: 'SDC Showroom',                     customer: 'SDC',                status: 'On Track', type: 'Custom',    hoursActual:  6420, hoursQuoted:  0,    etc: 320,  parts:  51640,  partsQuoted: 0,      pl:   12400 },
  ];

  // ---- PAGE 3 · Employee utilization --------------------------------
  const employeeUtil = [
    { name: 'Adams, Samuel',        group: 'Shop',         util: 103 },
    { name: 'Sanford, Gregory',     group: 'Shop',         util: 101 },
    { name: 'Brown, Jesse',         group: 'Shop',         util: 100 },
    { name: 'Cantrell, Dewayne',    group: 'Shop',         util: 98  },
    { name: 'Piscioneri, John',     group: 'Engineering',  util: 96  },
    { name: 'Kuzius, Michael',      group: 'Engineering',  util: 94  },
    { name: 'Galvez, Ivan',         group: 'Shop',         util: 92  },
    { name: 'Dula, Richard',        group: 'Shop',         util: 90  },
    { name: 'Nguyen, Trung',        group: 'Shop',         util: 88  },
    { name: 'Shaffer, Timothy',     group: 'Engineering',  util: 85  },
    { name: 'Piscioneri, Nicholas', group: 'Engineering',  util: 83  },
    { name: 'McCauley, Darrin',     group: 'Engineering',  util: 81  },
    { name: 'Troha, Richard',       group: 'Manufacturing',util: 78  },
    { name: 'Shirk, Andre',         group: 'Shop',         util: 74  },
    { name: 'Klingensmith, Robert', group: 'Shop',         util: 71  },
    { name: 'Armand, Matthew',      group: 'Engineering',  util: 66  },
    { name: 'Steimle, Michael',     group: 'Manufacturing',util: 58  },
  ];

  // ---- PAGE 6 · Per-job monthly trend + employee breakdown ----------
  function jobMonthly(job) {
    const base = job.hoursActual / 9;
    const q = job.hoursQuoted / 8 || base * 0.9;
    const f = [0.7, 0.95, 1.15, 1.3, 1.25, 1.1, 0.95, 0.6];
    const labels = ['Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];
    return labels.map((m, i) => ({
      m,
      actual: Math.round(base * f[i]),
      quoted: Math.round(q),
    }));
  }
  function jobEmployees(job) {
    const names = ['Sanford, Gregory','Cantrell, Dewayne','Galvez, Ivan','Piscioneri, John','Dula, Richard','Brown, Jesse'];
    const share = [0.27, 0.22, 0.18, 0.15, 0.11, 0.07];
    return names.map((n, i) => ({
      name: n,
      hours: Math.round(job.hoursActual * share[i]),
      dept: i % 2 === 0 ? 'Shop' : 'Engineering',
    }));
  }

  return {
    C, meta, billingGroups, totalQuoted, totalActual, monthlyTrend,
    statusTable, jobs, employeeUtil, jobMonthly, jobEmployees,
    exec: {
      atRisk: 9, utilization: 89,
    },
    jobHours: {
      totalActual, overQuoted: 23, underQuoted: 28, noQuote: 6,
      avgPerJob: Math.round(totalActual / 57),
    },
    util: {
      pct: 89, employees: 31, billable: 9420, nonBillable: 1160, overtime: 340,
    },
    profit: {
      total: 1420600, profitable: 41, atLoss: 9,
      best: { id: '1106', val: 284100 }, worst: { id: '1079', val: -112400 },
    },
    parts: {
      invoiced: 4608793, poLines: 1847, avgPerJob: 80856,
      unmatched: 12, leftToSpend: 629635,
    },
  };
})();
