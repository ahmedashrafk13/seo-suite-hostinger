// Runs the two sibling Python tools and turns their output into first-class
// data in this app: audit findings, linking CSVs, and tasks.
//
//   ../webtechstackdetector/main.py      → technical SEO audit
//   ../internal-linking-agent/internal_link_agent.py → internal linking audit
//
// Both are long-running crawls (minutes, not seconds), so a run is started in
// the background and the HTTP request returns immediately with a run id. The
// browser polls /status/:id. Progress lines are streamed into the run row so a
// page reload — or a server restart — still shows where the crawl got to,
// which the previous in-memory Map could not do.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const csvStore = require('./csvStore');
const tasksLib = require('./tasks');
const google = require('./google');
const pythonEnv = require('./pythonEnv');
const A = require('./analytics');

const WEBTECHSTACK_DIR = path.dirname(config.WEBTECHSTACK_DETECTOR_PATH);
const INTERNAL_LINKING_DIR = path.dirname(config.INTERNAL_LINK_AGENT_PATH);

// Live handles, purely so a running job can be cancelled. All durable state
// lives in SQLite.
const running = new Map();

// Which implementation of each crawler will actually run.
//
// Both tools ship twice: as the original Python programs under tools/, and as
// JavaScript ports under tools/node/ that need nothing but Node and packages
// already in package.json. That is not redundancy for its own sake — shared
// hosting has no guaranteed Python interpreter and no way to pip install
// httpx/numpy/lxml/python-docx into one, so without the ports the audit and
// internal-linking features would simply be dead on this host.
//
// Selection is per-tool, not global: a machine can have a Python that satisfies
// the audit's two dependencies but not the linking agent's six.
//
//   TOOL_RUNTIME=auto    Python when a proven interpreter exists, else Node
//   TOOL_RUNTIME=python  force Python (fails loudly if unusable)
//   TOOL_RUNTIME=node    force Node
const NODE_SCRIPTS = { audit: config.NODE_AUDIT_PATH, linking: config.NODE_LINKING_PATH };

function chooseRuntime(tool) {
  const mode = config.TOOL_RUNTIME;
  const nodeScript = NODE_SCRIPTS[tool];
  const nodeExists = fs.existsSync(nodeScript);
  const pyScript = tool === 'audit'
    ? config.WEBTECHSTACK_DETECTOR_PATH
    : config.INTERNAL_LINK_AGENT_PATH;
  const pyExists = fs.existsSync(pyScript);

  if (mode === 'node') {
    return { runtime: 'node', script: nodeScript, ok: nodeExists, reason: 'TOOL_RUNTIME=node' };
  }

  let env = { ok: false, error: 'python not checked' };
  if (pyExists) {
    try { env = pythonEnv.resolve(tool); } catch (e) { env = { ok: false, error: e.message }; }
  }

  if (mode === 'python') {
    return {
      runtime: 'python', script: pyScript, ok: pyExists && env.ok, env,
      reason: 'TOOL_RUNTIME=python',
    };
  }

  // auto
  if (pyExists && env.ok) {
    return { runtime: 'python', script: pyScript, ok: true, env, reason: 'a usable Python interpreter was found' };
  }
  return {
    runtime: 'node',
    script: nodeScript,
    ok: nodeExists,
    reason: pyExists
      ? `Python cannot run this tool (${env.error || 'missing packages'})`
      : 'the Python tool is not installed',
  };
}

function toolAvailability() {
  const auditChoice = chooseRuntime('audit');
  const linkingChoice = chooseRuntime('linking');
  return {
    audit: {
      script: auditChoice.script,
      exists: fs.existsSync(auditChoice.script),
      dir: auditChoice.runtime === 'python' ? WEBTECHSTACK_DIR : path.dirname(auditChoice.script),
      runtime: auditChoice.runtime,
      // Headless-browser rendering exists only in the Python implementation, and
      // only where Playwright and a Chromium build are installed. The forms
      // offer rendering as a deliberate choice, so they need to know: an option
      // that silently does nothing is worse than one that is visibly
      // unavailable.
      canRender: auditChoice.runtime === 'python',
      choice: auditChoice,
    },
    linking: {
      script: linkingChoice.script,
      exists: fs.existsSync(linkingChoice.script),
      dir: linkingChoice.runtime === 'python' ? INTERNAL_LINKING_DIR : path.dirname(linkingChoice.script),
      runtime: linkingChoice.runtime,
      canRender: linkingChoice.runtime === 'python',
      choice: linkingChoice,
    },
    python: config.PYTHON_BIN,
  };
}

// Reported at boot so the choice is visible before someone starts a crawl and
// wonders why it behaved differently than on their laptop.
function runtimeStatus() {
  const avail = toolAvailability();
  return [
    {
      label: 'Technical audit crawler',
      using: avail.audit.runtime === 'python' ? 'Python' : 'Node (JavaScript port)',
      note: avail.audit.runtime === 'node' ? avail.audit.choice.reason : '',
    },
    {
      label: 'Internal linking agent',
      using: avail.linking.runtime === 'python' ? 'Python' : 'Node (JavaScript port)',
      note: avail.linking.runtime === 'node' ? avail.linking.choice.reason : '',
    },
  ];
}

// Keeps the last ~8 KB of output on the run row. Enough to show a progress tail
// and to diagnose a failure, without letting a chatty crawl bloat the database.
function makeLogger(table, runId) {
  let buffer = '';
  let lastFlush = 0;
  let pending = null;

  const flush = () => {
    pending = null;
    lastFlush = Date.now();
    try {
      db.prepare(`UPDATE ${table} SET log_tail=? WHERE id=?`).run(buffer.slice(-8000), runId);
    } catch { /* a locked db must never kill the crawl */ }
  };

  return {
    write(chunk) {
      buffer += chunk;
      // Throttle to at most one write per second.
      if (Date.now() - lastFlush > 1000) flush();
      else if (!pending) pending = setTimeout(flush, 1000);
    },
    finish() {
      if (pending) clearTimeout(pending);
      flush();
      return buffer;
    },
    get text() { return buffer; },
  };
}

// Spawns the vendored Python tool with an interpreter that has been PROVED to
// import its dependencies (see lib/pythonEnv). Trusting `python` on PATH was
// the cause of audits failing with "Install deps: pip install requests
// beautifulsoup4" on a machine where the packages were installed — just into a
// different one of its four Python installs.
// Spawns whichever implementation was selected for this tool.
//
// The Node ports take the same command-line arguments as the Python programs
// and write the same output (JSON on stdout for the audit, the same set of
// files in --out for the linking agent), so the caller does not branch: only
// the interpreter and the script path change.
function spawnTool(choice, args, cwd, { onData, onDone, tool = 'audit' }) {
  if (choice.runtime === 'node') {
    let child;
    try {
      // process.execPath rather than "node": under Passenger the app may be
      // started by a Node binary that is not the one on PATH, and mixing the
      // two would run the port under a different version than the app itself.
      child = spawn(process.execPath, [choice.script, ...args], { cwd, windowsHide: true });
    } catch (err) {
      onDone(err, { code: -1 });
      return null;
    }
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      onDone(err, { code: -1 });
    });
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      onDone(null, { code, signal });
    });
    return child;
  }
  return spawnPython(choice.script, args, cwd, { onData, onDone, tool });
}

function spawnPython(script, args, cwd, { onData, onDone, tool = 'audit' }) {
  const env = pythonEnv.resolve(tool);
  if (!env.ok) {
    const err = new Error(
      `${env.error} Install them with:  ${env.command}` +
      `\nTried: ${env.tried.map((t) => t.bin).join(', ')}`
    );
    err.pythonEnv = env;
    onDone(err, { code: -1 });
    return null;
  }

  const tryBin = (bin, binArgs) => {
    let child;
    try {
      child = spawn(bin, [...binArgs, '-u', script, ...args], { cwd, windowsHide: true });
    } catch (err) {
      onDone(err, { code: -1 });
      return null;
    }

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      onDone(err, { code: -1 });
    });

    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      onDone(null, { code, signal });
    });

    return child;
  };

  return tryBin(env.bin, env.args);
}

function fail(table, runId, message) {
  db.prepare(`UPDATE ${table} SET status='error', error=?, finished_at=datetime('now') WHERE id=?`)
    .run(String(message).slice(-4000), runId);
}

// ==========================================================================
// Technical SEO audit
// ==========================================================================

function startAudit({ userId, brandId = null, domain, maxPages = 100, render = 'auto', createTasks = true }) {
  const avail = toolAvailability().audit;
  const insert = db.prepare(
    'INSERT INTO audit_runs (user_id, brand_id, domain, max_pages, status) VALUES (?,?,?,?,?)'
  ).run(userId, brandId, domain, maxPages, avail.exists ? 'running' : 'error');
  const runId = insert.lastInsertRowid;

  if (!avail.exists) {
    fail('audit_runs', runId,
      `Audit tool not found at ${avail.script} (${avail.runtime} implementation). `
      + 'Set WEBTECHSTACK_DETECTOR_PATH in .env, or check that tools/node/audit/ was deployed.');
    return runId;
  }

  fs.mkdirSync(config.REPORTS_DIR, { recursive: true });

  // NOTE on --json vs --doc: main.py writes its Word document only in the
  // `if not args.json:` branch, so the two flags are mutually exclusive — asking
  // for both silently yields no document. We take --json, because the structured
  // findings are what drive the on-screen report, severity grouping, task
  // generation and the audit alert types. The downloadable report is rendered
  // from that JSON by this app instead (see routes/audit.js "export"), which
  // avoids crawling the site twice just to obtain a second output format.
  const args = [
    domain,
    '--max-pages', String(maxPages),
    '--json',
    '--render', render,
  ];

  const log = makeLogger('audit_runs', runId);
  const child = spawnTool(avail.choice, args, avail.dir, {
    tool: 'audit',
    onData: (chunk) => log.write(chunk),
    onDone: (err, { code }) => {
      running.delete(`audit:${runId}`);
      const output = log.finish();

      if (err) {
        return fail('audit_runs', runId,
          `Could not start the audit tool (${avail.runtime} implementation): ${err.message}`);
      }

      // The tool prints progress to stdout as well as JSON, so take the JSON
      // object by locating the last balanced top-level braces rather than
      // assuming stdout is pure JSON.
      const parsed = extractJson(output);
      if (!parsed) {
        return fail('audit_runs', runId,
          code === 0
            ? `The audit finished but no JSON result could be parsed from its output.\n\nLast output:\n${output.slice(-2000)}`
            : `Audit exited with code ${code}.\n\nLast output:\n${output.slice(-2000)}`);
      }

      db.prepare(`UPDATE audit_runs SET status='completed', json_result=?,
        finished_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify(parsed), runId);

      if (createTasks) {
        try {
          const run = db.prepare('SELECT * FROM audit_runs WHERE id=?').get(runId);
          const brand = brandId ? db.prepare('SELECT * FROM brands WHERE id=?').get(brandId) : null;
          tasksLib.fromAuditRun(run, brand);
        } catch (e) {
          console.error(`[audit] task generation failed for run ${runId}: ${e.message}`);
        }
      }
    },
  });

  if (child && child.pid) {
    db.prepare('UPDATE audit_runs SET pid=? WHERE id=?').run(child.pid, runId);
    running.set(`audit:${runId}`, child);
  }
  return runId;
}

// Finds the JSON object in mixed stdout. Scans for the last '{' that opens a
// balanced object parsing as JSON, which is robust to progress text on either
// side of it.
function extractJson(text) {
  const starts = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '{') starts.push(i);
  // Try the earliest candidates first — the result object is the big one.
  for (const start of starts) {
    const candidate = text.slice(start);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && (parsed.findings || parsed.site_health != null)) return parsed;
    } catch { /* try the next candidate */ }
  }
  // Fall back to brace matching for the case where trailing text follows.
  for (const start of starts) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && (parsed.findings || parsed.site_health != null)) return parsed;
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  return null;
}

// ==========================================================================
// Internal linking audit
// ==========================================================================

// Writes the GSC page performance CSV the linking tool accepts via --gsc-csv,
// preferring the already-consolidated data over a fresh API call.
function writeGscCsv(brand, runId) {
  fs.mkdirSync(config.TMP_DIR, { recursive: true });
  const anchor = A.latestGscDate(brand.id);
  if (!anchor) return { path: null, rows: 0, reason: 'no consolidated Search Console data for this brand yet' };

  const w = A.windowFrom(anchor, 90);
  const rows = db.prepare(`SELECT page,
      SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_page_daily WHERE brand_id=? AND date BETWEEN ? AND ?
    GROUP BY page ORDER BY SUM(impressions) DESC`)
    .all(brand.id, w.startDate, w.endDate);
  if (!rows.length) return { path: null, rows: 0, reason: 'no page-level Search Console rows in the last 90 days' };

  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['url,clicks,impressions,position'];
  rows.forEach((r) => lines.push([
    esc(r.page), Math.round(r.clicks), Math.round(r.impressions),
    r.position == null ? '' : r.position.toFixed(2),
  ].join(',')));

  const csvPath = path.join(config.TMP_DIR, `gsc-brand${brand.id}-run${runId}.csv`);
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
  return { path: csvPath, rows: rows.length, window: w };
}

function startLinking({
  userId, brandId = null, siteUrl, maxPages = 200, useGsc = false,
  render = false, createTasks = true,
}) {
  const avail = toolAvailability().linking;
  const insert = db.prepare(
    'INSERT INTO linking_runs (user_id, brand_id, site_url, max_pages, used_gsc, status) VALUES (?,?,?,?,?,?)'
  ).run(userId, brandId, siteUrl, maxPages, useGsc ? 1 : 0, avail.exists ? 'running' : 'error');
  const runId = insert.lastInsertRowid;

  if (!avail.exists) {
    fail('linking_runs', runId,
      `Internal linking tool not found at ${avail.script} (${avail.runtime} implementation). `
      + 'Set INTERNAL_LINK_AGENT_PATH in .env, or check that tools/node/linking/ was deployed.');
    return runId;
  }

  // Write output inside this app so runs are self-contained and downloadable,
  // instead of scattered through the sibling tool's own reports/ folder.
  const hostSafe = siteUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_');
  const outDir = path.join(config.REPORTS_DIR, 'linking', `${hostSafe}-run${runId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const args = [siteUrl, '--max-pages', String(maxPages), '--out', outDir];
  if (render) args.push('--render');

  // Passes the brand's configured language down to the Python tool so its
  // anchor-generation/keyword-extraction word lists (and the Accept-Language
  // header it crawls with) match the site's actual language instead of
  // always assuming English. Brands without a locale configured (the vast
  // majority, historically) fall through to 'en', reproducing the original
  // English-only behaviour exactly.
  let brandForLocale = brandId ? db.prepare('SELECT * FROM brands WHERE id=?').get(brandId) : null;
  args.push('--locale', (brandForLocale && brandForLocale.locale) || 'en');

  let csvPath = null;
  if (useGsc && brandId) {
    const brand = brandForLocale || db.prepare('SELECT * FROM brands WHERE id=?').get(brandId);
    if (brand) {
      const csv = writeGscCsv(brand, runId);
      if (csv.path) {
        csvPath = csv.path;
        args.push('--gsc-csv', csvPath);
      } else {
        db.prepare('UPDATE linking_runs SET used_gsc=0, log_tail=? WHERE id=?')
          .run(`Note: Search Console blending was requested but skipped — ${csv.reason}.\n`, runId);
      }
    }
  }

  const log = makeLogger('linking_runs', runId);
  if (csvPath) log.write(`Blending Search Console page data from ${csvPath}\n`);

  const child = spawnTool(avail.choice, args, avail.dir, {
    tool: 'linking',
    onData: (chunk) => log.write(chunk),
    onDone: (err, { code }) => {
      running.delete(`linking:${runId}`);
      const output = log.finish();
      if (csvPath) { try { fs.unlinkSync(csvPath); } catch { /* leave the temp file */ } }

      if (err) {
        return fail('linking_runs', runId,
          `Could not start the internal linking tool (${avail.runtime} implementation): ${err.message}`);
      }

      const inv = csvStore.inventory(outDir);
      if (!inv.exists || !inv.files.length) {
        return fail('linking_runs', runId,
          `The crawl produced no CSV output in ${outDir}${code === 0 ? '' : ` (exit code ${code})`}.\n\nLast output:\n${output.slice(-2000)}`);
      }

      // Store the summary plus a bounded slice of each CSV, so the overview
      // and task generation work without touching disk. Full tables are read
      // from the CSVs on demand.
      const summary = csvStore.summary(outDir);
      const slice = (key, n) => {
        const t = csvStore.readTable(outDir, key, { page: 1, perPage: n });
        return t ? t.rows : [];
      };

      const result = {
        summary,
        outDir,
        counts: Object.fromEntries(inv.files.map((f) => [f.key, f.rowCount])),
        recommendations: slice('recommendations', 300),
        orphans: slice('orphans', 300),
        cannibalization: slice('cannibalization', 200),
        broken_links: slice('broken_links', 200),
        non_editorial_pages: slice('non_editorial_pages', 100),
      };

      db.prepare(`UPDATE linking_runs SET status='completed', out_dir=?, json_result=?, docx_path=?,
        finished_at=datetime('now') WHERE id=?`)
        .run(outDir, JSON.stringify(result), inv.docx, runId);

      if (createTasks) {
        try {
          const run = db.prepare('SELECT * FROM linking_runs WHERE id=?').get(runId);
          const brand = brandId ? db.prepare('SELECT * FROM brands WHERE id=?').get(brandId) : null;
          tasksLib.fromLinkingRun(run, brand);
        } catch (e) {
          console.error(`[linking] task generation failed for run ${runId}: ${e.message}`);
        }
      }
    },
  });

  if (child && child.pid) {
    db.prepare('UPDATE linking_runs SET pid=? WHERE id=?').run(child.pid, runId);
    running.set(`linking:${runId}`, child);
  }
  return runId;
}

// ==========================================================================
// Shared
// ==========================================================================

function cancel(kind, runId) {
  const child = running.get(`${kind}:${runId}`);
  const table = kind === 'audit' ? 'audit_runs' : 'linking_runs';
  if (child) {
    try { child.kill(); } catch { /* already gone */ }
    running.delete(`${kind}:${runId}`);
  }
  db.prepare(`UPDATE ${table} SET status='cancelled', finished_at=datetime('now') WHERE id=? AND status='running'`)
    .run(runId);
  return true;
}

// On boot, any run still marked "running" belongs to a process that died with
// the previous server. Marking them interrupted stops the UI showing a spinner
// forever for a job that will never report back.
function reconcileOnBoot() {
  ['audit_runs', 'linking_runs'].forEach((table) => {
    const stuck = db.prepare(`SELECT id FROM ${table} WHERE status='running'`).all();
    if (!stuck.length) return;
    db.prepare(`UPDATE ${table} SET status='interrupted',
      error=COALESCE(error,'') || 'The server restarted while this run was in progress, so its result was lost. Start a new run.',
      finished_at=datetime('now') WHERE status='running'`).run();
    console.log(`[tools] marked ${stuck.length} interrupted ${table} row(s) from a previous process.`);
  });
}

function isRunning(kind, runId) {
  return running.has(`${kind}:${runId}`);
}

module.exports = {
  startAudit, startLinking, cancel, reconcileOnBoot, isRunning,
  toolAvailability, runtimeStatus, chooseRuntime, extractJson, writeGscCsv,
  WEBTECHSTACK_DIR, INTERNAL_LINKING_DIR,
};
