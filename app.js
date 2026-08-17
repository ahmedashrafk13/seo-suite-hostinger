// Startup file for Passenger / hPanel.
//
// Hostinger's Node.js setup asks for an "Application startup file" and defaults
// to app.js in the application root. The real application lives in src/app.js;
// this exists so the panel's default works without anyone having to know that,
// and so the startup file never has to be edited.
//
// Passenger LOADS this file rather than running it as a program, and it expects
// the app to listen on the port it supplies in process.env.PORT — which
// src/config.js already reads.
module.exports = require('./src/app');
