#!/usr/bin/env node
/* Bind an adapter template to exact captured callable IDs, preserving producer artifacts. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const Flow = require('../src/execution-flow.js');
const CallGraph = require('../src/call-graph.js');
const Entries = require('../src/entry-effects.js');

function bindManifest(raw, template, bindings) {
  const inventory = CallGraph.build(raw, Flow.catalog(raw)).nodes;
  const manifest = structuredClone(template), used = new Set();
  function bind(selector) {
    const placeholder = selector.id;
    if (!placeholder || !placeholder.startsWith('$')) throw new Error('template selectors require a $placeholder id');
    const binding = bindings[placeholder];
    if (!binding || Object.keys(binding).some(key => !['id', 'path', 'packageId'].includes(key)) ||
        !Object.values(binding).every(value => typeof value === 'string' && value) || !(binding.id || binding.path))
      throw new Error('missing or invalid binding: ' + placeholder);
    const matches = inventory.filter(node => (!binding.id || node.id === binding.id) &&
      (!binding.path || node.path === binding.path || (node.flowPaths || []).includes(binding.path)) &&
      (!binding.packageId || node.package_id === binding.packageId));
    if (matches.length !== 1) throw new Error(placeholder + ' resolved to ' + matches.length + ' inventoried callables');
    used.add(placeholder);
    return { id: matches[0].id };
  }
  Entries.validateManifest(manifest);
  for (const adapter of manifest.adapters) {
    for (const rule of [...(adapter.entries || []), ...(adapter.summaries || [])]) rule.selector = bind(rule.selector);
    for (const rule of adapter.registrations || []) { rule.caller = bind(rule.caller); rule.target = bind(rule.target); }
  }
  if (Object.keys(bindings).some(key => !used.has(key))) throw new Error('unused binding');
  Entries.validateManifest(manifest);
  return manifest;
}
function readCapture(filename) {
  const bytes = fs.readFileSync(filename);
  return JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
}
function bindCapture(capturePath, htmlPath, templatePath, bindingsPath, outputDir) {
  if (path.resolve(outputDir) === path.dirname(path.resolve(capturePath)) || path.resolve(outputDir) === path.dirname(path.resolve(htmlPath)))
    throw new Error('bound output directory must differ from original capture directories');
  const raw = readCapture(capturePath), html = fs.readFileSync(htmlPath, 'utf8');
  const pattern = /(<script\b[^>]*\bid="graph-data"[^>]*>)([\s\S]*?)(<\/script>)/;
  const data = html.match(pattern);
  if (!data || !data[2].trim()) throw new Error('tiny capture must contain emitted inline graph-data');
  assert.deepEqual(JSON.parse(data[2]), raw, 'HTML must describe the original producer capture');
  const manifest = bindManifest(raw, JSON.parse(fs.readFileSync(templatePath, 'utf8')), JSON.parse(fs.readFileSync(bindingsPath, 'utf8')));
  const carrier = raw.nodes.find(node => node.attributes && node.attributes.kind === 'crate');
  if (!carrier || carrier.attributes.entry_effects != null) throw new Error('capture needs an unannotated crate carrier');
  carrier.attributes.entry_effects = JSON.stringify(manifest);
  const compact = JSON.stringify(raw), embedded = compact.replace(/</g, '\\u003c');
  // A replacement callback preserves literal dollar signs in JSON. Escaping <
  // prevents a manifest value from ending this application/json script block.
  const boundHtml = html.replace(pattern, (_, open, _data, close) => open + embedded + close);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, contents] of [['graph.json', compact], ['graph.html', boundHtml], ['entry-effects.bound.json', JSON.stringify(manifest, null, 2) + '\n']])
    fs.writeFileSync(path.join(outputDir, name), contents, { flag: 'wx' });
  return manifest;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 5) throw new Error('usage: bind-entry-effects-adapter.cjs graph.json graph.html template.json bindings.json new-output-dir');
  const manifest = bindCapture(...args);
  process.stdout.write(JSON.stringify({ outputDir: path.resolve(args[4]), adapters: manifest.adapters.map(adapter => adapter.id + '@' + adapter.version) }) + '\n');
}
module.exports = { bindManifest, bindCapture, readCapture };
