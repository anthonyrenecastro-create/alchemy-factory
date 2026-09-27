#!/usr/bin/env node
/**
 * Generate real program keypairs for all 7 Alchemy Factory programs.
 *
 * Output: programs/target/deploy/<program>-keypair.json — gitignored via
 * `programs/target/` and `*_keypair.json` in the repo .gitignore.
 * NEVER commit these files. Prints the pubkey list for Anchor.toml /
 * declare_id! replacement.
 *
 * Run from the repo root: node scripts/gen-program-keypairs.js
 * Requires: cd programs && npm install (for @solana/web3.js)
 */
const fs = require('fs');
const path = require('path');
const { Keypair } = require('../programs/node_modules/@solana/web3.js');

const PROGRAMS = [
  'alchemy_factory',
  'alchemy_curve',
  'alchemy_decay',
  'alchemy_dynamic',
  'alchemy_vessel',
  'alchemy_proofx',
  'alchemy_vault',
];

const repoRoot = path.join(__dirname, '..');
const outDir = path.join(repoRoot, 'programs', 'target', 'deploy');
fs.mkdirSync(outDir, { recursive: true });

const ids = {};
for (const name of PROGRAMS) {
  const kpPath = path.join(outDir, `${name}-keypair.json`);
  let kp;
  if (fs.existsSync(kpPath)) {
    kp = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8')))
    );
    console.error(`reusing existing keypair for ${name}`);
  } else {
    kp = Keypair.generate();
    fs.writeFileSync(kpPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.error(`generated new keypair for ${name}`);
  }
  ids[name] = kp.publicKey.toBase58();
}

console.log(JSON.stringify(ids, null, 2));
