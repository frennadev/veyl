#!/usr/bin/env node
// Compile zk/circuits/<name>.circom with the pinned compiler (circom2 npm = circom 2.2.3, --r1cs --wasm --O2) into
// zk/build/<name>.r1cs + <name>.wasm. The ceremony's `r1cs` command recompiles the same way and checks the wasm is
// byte-identical. Usage: node scripts/compile-circuit.js swap claim
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
for (const name of process.argv.slice(2)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veyl-circom-'));
  try {
    fs.mkdirSync(path.join(tmp, 'circuits')); fs.copyFileSync(path.join(ROOT, `zk/circuits/${name}.circom`), path.join(tmp, `circuits/${name}.circom`));
    fs.cpSync(path.dirname(require.resolve('circomlib/package.json', { paths: [ROOT] })), path.join(tmp, 'node_modules/circomlib'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'build'));
    execFileSync(process.execPath, [require.resolve('circom2/cli.js', { paths: [ROOT] }), `circuits/${name}.circom`, '--r1cs', '--wasm', '--O2', '-o', 'build'], { cwd: tmp, stdio: 'inherit' });
    fs.copyFileSync(path.join(tmp, `build/${name}.r1cs`), path.join(ROOT, `zk/build/${name}.r1cs`));
    fs.copyFileSync(path.join(tmp, `build/${name}_js/${name}.wasm`), path.join(ROOT, `zk/build/${name}.wasm`));
    console.log(`zk/build/${name}.r1cs, zk/build/${name}.wasm`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
