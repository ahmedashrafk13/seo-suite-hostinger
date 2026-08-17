// AI Suggestions — placeholder screen.
//
// Deliberately not wired to any model yet: every AI-shaped feature in this
// app (content brief "questions to answer" / "competitor coverage", a future
// AI insights summary) needs a paid LLM API key to actually run, which is a
// real ongoing per-call cost rather than something to fake. This page exists
// so the feature has a real home and is visibly on the roadmap, without
// pretending it works before an API key and a pricing decision are in place.
const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('ai-suggestions', {
    title: 'AI Suggestions',
    active: 'ai',
    pageTitle: 'AI Suggestions',
  });
});

module.exports = router;
