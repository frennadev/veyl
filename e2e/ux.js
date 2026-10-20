// Focused browser regressions for shared UX behavior. Mock engine; no RPC or transactions.
'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { chromePath } = require('./harness');
const { buildSync } = require('esbuild');
const path = require('path');
const code = buildSync({ stdin: { contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Modal, openModal, closeModal} from './web/components/overlay';
import {session} from './web/features/session/session';
import {runAction} from './web/features/actions/runAction';
import {QueryProvider, useAsyncQuery} from './web/features/session/query';
let release, calls = 0;
const E = { store: { data: {}, save() { throw new Error('storage blocked'); } } };
session.set({rt: {mode: 'chain', engine: E, chainName: 'Test', cfg: {cluster: 'local'}}, status: 'ready'});
function Probe() {
 const [input, setInput] = useState('one');
 const q = useAsyncQuery('probe', async () => {
   if(input === 'fail') throw new Error('offline');
   if(input === 'slow') return await new Promise(r => { window.resolveQuote = r; });
   return input;
 }, [input], 20);
 window.input = setInput;
 return <output id="probe">{JSON.stringify({value:q.value,error:q.error,key:q.key})}</output>;
}
window.fixture = {
 open: () => openModal(<><h3 id="dlgTitle">Test dialog</h3><button id="first">First</button><button id="last">Last</button></>),
 close: closeModal,
 run: () => runAction({ title: 'Test action', kind: 'wallet', exec: () => {calls++; return new Promise(r => {release=r;});}, done: () => {throw new Error('receipt failed');} }),
 fail: () => runAction({title:'Test failure',kind:'wallet',exec:()=>{throw new Error('sync failure');},done:()=>({title:'unused',body:''})}),
 storage: () => runAction({title:'Test storage',kind:'wallet',exec:async()=>1,done:()=>({title:'Confirmed',body:'Settled',activity:{t:'Done',s:'',amt:''}})}),
 release: () => release(1), state: () => ({calls,busy:session.get().busy, version:session.get().version})
};
createRoot(document.getElementById('root')).render(<QueryProvider><main><button id="opener" onClick={window.fixture.open}>Open</button><Probe/></main><Modal/></QueryProvider>);
`, resolveDir: path.resolve('.'), loader: 'tsx' }, tsconfig: 'web/tsconfig.json', bundle: true, write: false, format: 'iife', platform: 'browser', define: {'process.env.NODE_ENV':'"production"'} }).outputFiles[0].text;
const ok = (name, value) => { assert.ok(value, name); console.log('ok -', name); };
(async () => {
 const browser = await chromium.launch({executablePath:chromePath()});
 try {
  const page = await browser.newPage({viewport:{width:1200,height:800}}), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({content:code});
  await page.click('#opener'); await page.waitForFunction(()=>document.activeElement?.id === 'first');
  ok('modal makes background inert and locks scroll',await page.evaluate(()=>document.querySelector('main').inert && document.body.style.overflow === 'hidden'));
  await page.focus('#last'); await page.keyboard.press('Tab');
  ok('Tab wraps inside the modal', await page.evaluate(()=>document.activeElement.id === 'dlgX'));
  await page.keyboard.press('Shift+Tab');
  ok('Shift+Tab wraps inside the modal',await page.evaluate(()=>document.activeElement.id === 'last'));
  await page.evaluate(()=>window.fixture.close()); await page.waitForFunction(()=>!document.querySelector('main').inert);
  ok('close restores focus and scroll',await page.evaluate(()=>document.activeElement.id === 'opener' && document.body.style.overflow === ''));
  await page.evaluate(()=>{window.fixture.run();window.fixture.run();});
  ok('overlapping actions execute once',await page.evaluate(()=>window.fixture.state().calls===1 && window.fixture.state().busy));
  await page.evaluate(()=>window.fixture.release()); await page.waitForSelector('#doneBtn');
  ok('receipt failure still reports successful execution',await page.locator('#dlgBody').innerText().then(t=>/Action completed/.test(t)));
  await page.click('#doneBtn'); await page.evaluate(()=>window.fixture.fail()); await page.waitForSelector('#actErr');
  ok('synchronous engine exceptions unlock the UI',await page.evaluate(()=>!window.fixture.state().busy) && /sync failure/.test(await page.locator('#actErr').innerText()));
  await page.click('#errClose'); await page.evaluate(()=>window.fixture.storage()); await page.waitForSelector('#doneBtn');
  ok('storage failure does not hide a confirmed result', /Confirmed/.test(await page.locator('#dlgBody').innerText()));
  await page.click('#doneBtn');
  await page.waitForFunction(()=>JSON.parse(document.getElementById('probe').textContent).value==='one');
  await page.evaluate(()=>window.input('slow')); await page.waitForFunction(()=>typeof window.resolveQuote==='function');
  ok('changed inputs immediately discard the previous quote',await page.evaluate(()=>JSON.parse(document.getElementById('probe').textContent).value===null));
  await page.evaluate(()=>window.resolveQuote('slow')); await page.waitForFunction(()=>JSON.parse(document.getElementById('probe').textContent).value==='slow');
  await page.evaluate(()=>window.input('fail')); await page.waitForFunction(()=>JSON.parse(document.getElementById('probe').textContent).error==='offline');
  ok('failed quotes expose an error instead of an endless loading state',await page.evaluate(()=>JSON.parse(document.getElementById('probe').textContent).value===null));
  ok('no unhandled browser errors',errors.length===0);
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
