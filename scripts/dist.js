#!/usr/bin/env node
// Builds dist/ (or OUT): the static site, through build-site.js (the Next.js pages, the engine bundle, the circuits).
// PREVIEW=1 builds the shareable preview: no deployment config, so the app shows the listed pools and can't transact.
// NETWORK picks the deployment otherwise (default devnet).
'use strict';
const path = require('path');
const { build } = require('./build-site.js');
const out = path.resolve(__dirname, '..', process.env.OUT || 'dist');
build(process.env.NETWORK || 'devnet', { out, noDeploy: !!process.env.PREVIEW });
console.log('dist built:', out, process.env.PREVIEW ? '(preview: no deployment)' : '');
