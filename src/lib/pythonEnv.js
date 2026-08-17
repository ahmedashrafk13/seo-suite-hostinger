// Choosing a Python interpreter that can actually run the vendored tools.
//
// WHY THIS EXISTS
// "python" is not one program. This machine has four (3.10, 3.11, 3.12, 3.14)
// and only one has the crawler's dependencies installed. Which one `python`
// resolves to depends on the PATH of whichever shell happened to launch the
// server — so the audit worked from one terminal and failed from another with
// "Install deps: pip install requests beautifulsoup4", which reads like a bug
// in the tool rather than the environment problem it is.
//
// So the interpreter is not trusted to be correct: every candidate is probed
// for the modules the tool actually imports, and the first one that satisfies
// them is used. The result is cached, and the reason for a failure is reported
// precisely (which interpreters were tried, what was missing, the exact pip
// command to fix it) instead of surfacing a raw exit code.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('../config');

// Import names, not package names — these are what the scripts `import`.
const REQUIREMENTS = {
  audit: {
    modules: ['requests', 'bs4'],
    pip: 'requests beautifulsoup4',
    label: 'Technical audit crawler',
  },
  linking: {
    modules: ['httpx', 'numpy', 'bs4', 'lxml', 'docx', 'openpyxl'],
    pip: 'httpx numpy beautifulsoup4 lxml python-docx openpyxl',
    label: 'Internal linking agent',
  },
};

function uniq(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Ordered best-guess list. A venv inside the repo wins if present, then the
// configured binary, then whatever is on PATH, then every interpreter found in
// the usual install locations — because on Windows the one on PATH is
// frequently not the one with the packages.
function candidates() {
  const out = [];
  const repoVenvs = ['.venv', 'venv', '.venv-gpu'];
  repoVenvs.forEach((v) => {
    const win = path.join(__dirname, '..', '..', v, 'Scripts', 'python.exe');
    const nix = path.join(__dirname, '..', '..', v, 'bin', 'python');
    if (fs.existsSync(win)) out.push({ bin: win, args: [] });
    if (fs.existsSync(nix)) out.push({ bin: nix, args: [] });
  });

  if (config.PYTHON_BIN) out.push({ bin: config.PYTHON_BIN, args: [] });
  out.push({ bin: 'python', args: [] });
  out.push({ bin: 'python3', args: [] });

  if (process.platform === 'win32') {
    const roots = [
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'),
      'C:\\',
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
    ];
    roots.forEach((root) => {
      let entries = [];
      try { entries = fs.readdirSync(root); } catch { return; }
      entries
        .filter((e) => /^Python\d+/i.test(e))
        // Newest first is the wrong default here: a fresh 3.14 is the least
        // likely to have had packages installed into it. Older-but-established
        // installs are tried first, and the probe decides regardless.
        .sort()
        .forEach((e) => {
          const p = path.join(root, e, 'python.exe');
          if (fs.existsSync(p)) out.push({ bin: p, args: [] });
        });
    });
    // The py launcher last: it points at the newest install, which is usually
    // the emptiest one.
    out.push({ bin: 'py', args: ['-3'] });
  }

  return uniq(out);
}

// Returns the modules a given interpreter cannot import.
function missingModules(candidate, modules) {
  const probe = modules.map((m) => `import ${m}`).join('; ');
  try {
    execFileSync(candidate.bin, [...candidate.args, '-c', probe], {
      stdio: 'pipe', timeout: 15_000, windowsHide: true,
    });
    return [];
  } catch (err) {
    const text = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    const named = [...text.matchAll(/No module named '([^']+)'/g)].map((m) => m[1]);
    if (named.length) return uniq(named);
    // Interpreter missing entirely, or something else went wrong: treat every
    // module as unsatisfied so this candidate is skipped.
    return modules.slice();
  }
}

const cache = new Map();

// Resolves an interpreter for one tool. `force` re-probes after the user has
// installed something, so a fix takes effect without restarting the server.
function resolve(toolKey, { force = false } = {}) {
  const req = REQUIREMENTS[toolKey];
  if (!req) return { ok: false, error: `Unknown tool "${toolKey}".` };
  if (!force && cache.has(toolKey)) return cache.get(toolKey);

  const tried = [];
  let result = null;
  for (const c of candidates()) {
    const missing = missingModules(c, req.modules);
    tried.push({ bin: c.bin, args: c.args, missing });
    if (!missing.length) {
      result = { ok: true, bin: c.bin, args: c.args, tried, tool: toolKey };
      break;
    }
  }

  if (!result) {
    // Report against the interpreter that came closest, so the pip command
    // names only what is actually absent.
    const best = tried.filter((t) => t.missing.length < req.modules.length)
      .sort((a, b) => a.missing.length - b.missing.length)[0] || tried[0] || null;
    result = {
      ok: false,
      tried,
      tool: toolKey,
      missing: best ? best.missing : req.modules.slice(),
      suggestedBin: best ? best.bin : 'python',
      command: best
        ? `"${best.bin}" -m pip install ${req.pip}`
        : `pip install ${req.pip}`,
      error: `${req.label}: no Python interpreter has ${(best ? best.missing : req.modules).join(', ')}.`,
    };
  }
  cache.set(toolKey, result);
  return result;
}

// Installs the missing packages into the best candidate. Explicitly invoked —
// never automatic — because it changes the machine's Python environment.
function install(toolKey) {
  const req = REQUIREMENTS[toolKey];
  if (!req) return { ok: false, error: `Unknown tool "${toolKey}".` };
  const current = resolve(toolKey, { force: true });
  if (current.ok) return { ok: true, alreadySatisfied: true, bin: current.bin };

  const target = current.suggestedBin;
  try {
    const out = execFileSync(target, ['-m', 'pip', 'install', ...req.pip.split(' ')], {
      stdio: 'pipe', timeout: 300_000, windowsHide: true,
    }).toString();
    const after = resolve(toolKey, { force: true });
    return after.ok
      ? { ok: true, bin: after.bin, output: out.slice(-1500) }
      : { ok: false, error: `Install ran but ${after.missing.join(', ')} still missing.`, output: out.slice(-1500) };
  } catch (err) {
    return {
      ok: false,
      error: `pip failed: ${String(err.stderr || err.message).slice(0, 400)}`,
    };
  }
}

function status() {
  return Object.keys(REQUIREMENTS).map((k) => {
    const r = resolve(k);
    return {
      tool: k,
      label: REQUIREMENTS[k].label,
      ok: r.ok,
      bin: r.ok ? r.bin : null,
      missing: r.ok ? [] : r.missing,
      command: r.ok ? null : r.command,
    };
  });
}

module.exports = { REQUIREMENTS, resolve, install, status, candidates };
