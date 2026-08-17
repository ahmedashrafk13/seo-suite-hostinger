// The process-map and automation-backlog deliverable, rendered in-app.
const express = require('express');
const wf = require('../lib/workflowMap');
const tasksLib = require('../lib/tasks');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('workflow', {
    title: 'SEO workflow & automation backlog',
    active: 'workflow',
    pageTitle: 'Workflow map & automation backlog',
    tasks: wf.TASKS,
    backlog: wf.BACKLOG,
    approvalBoundary: wf.APPROVAL_BOUNDARY,
    frequencies: wf.FREQUENCIES,
    summary: wf.summary(),
    approvalRules: tasksLib.APPROVAL_RULES,
  });
});

// Markdown export, so the deliverable can be handed over outside the app.
router.get('/export.md', (req, res) => {
  const s = wf.summary();
  const L = [];
  L.push('# SEO Workflow Map & Automation Backlog', '');
  L.push(`_Generated ${new Date().toISOString().slice(0, 10)} by the SEO Automation Suite._`, '');
  L.push('## Summary', '');
  L.push(`- Processes mapped: **${s.totalTasks}**`);
  L.push(`- Fully automated: **${s.automated}**`);
  L.push(`- Automated analysis, human decision: **${s.assisted}**`);
  L.push(`- Still manual: **${s.manual}**`);
  L.push(`- Estimated manual effort before automation: **~${s.estimatedManualHoursPerMonthPerBrand} hours per month per brand**`);
  L.push(`- Estimated effort removed so far: **~${s.hoursSavedPerMonthPerBrand} hours per month per brand**`, '');

  L.push('## 1. Current process map', '');
  wf.TASKS.forEach((t) => {
    L.push(`### ${t.task}`, '');
    L.push(t.description, '');
    L.push(`| | |`, `|---|---|`);
    L.push(`| Frequency | ${wf.FREQUENCIES[t.frequency] || t.frequency} |`);
    L.push(`| Time per run | ${t.timePerRun} |`);
    L.push(`| People | ${t.people.join(', ')} |`);
    L.push(`| Tools | ${t.tools.join(', ')} |`);
    L.push(`| Inputs | ${t.inputs.join('; ')} |`);
    L.push(`| Outputs | ${t.outputs.join('; ')} |`);
    L.push(`| Status | **${t.status.replace('_', ' ')}** |`);
    L.push('');
    if (t.automatedBy) L.push(`**Automated by:** ${t.automatedBy}`, '');
    if (t.backlogNote) L.push(`**Backlog note:** ${t.backlogNote}`, '');
  });

  L.push('## 2. Approval boundary', '');
  L.push('The automation identifies, analyses, recommends, reports and creates tasks. The following changes remain subject to SEO-team approval and are enforced in code — a task touching any of them cannot be marked done until it is explicitly approved.', '');
  L.push('| Change | Why it stays manual |', '|---|---|');
  wf.APPROVAL_BOUNDARY.forEach((a) => L.push(`| ${a.action} | ${a.why} |`));
  L.push('');

  L.push('## 3. Prioritised automation backlog', '');
  L.push('| # | Item | Value | Effort | Status |', '|---|---|---|---|---|');
  wf.BACKLOG.forEach((b) => L.push(`| ${b.rank} | ${b.item} | ${b.value} | ${b.effort} | ${b.status} |`));
  L.push('');
  wf.BACKLOG.forEach((b) => {
    L.push(`### ${b.rank}. ${b.item}`, '');
    L.push(`**Status:** ${b.status} · **Value:** ${b.value} · **Effort:** ${b.effort}`, '');
    L.push(b.rationale, '');
    if (b.delivered) L.push(`**Delivered:** ${b.delivered}`, '');
    if (b.blockers) L.push(`**Blocked on:** ${b.blockers}`, '');
  });

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="seo-workflow-and-automation-backlog.md"');
  res.send(L.join('\n'));
});

module.exports = router;
