#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const readline = require('node:readline');
const Analysis = require('../src/analysis-api.js');
const Comments = require('../src/comment-search.js');
const Programs = require('../src/program-queries.js');

function boundedFile(file,max){const fd=fs.openSync(file,'r');try{const chunks=[];let size=0;while(true){const b=Buffer.alloc(Math.min(65536,max+1-size)),n=fs.readSync(fd,b,0,b.length,null);if(!n)break;size+=n;if(size>max)throw new Error('Optional comment input exceeds '+max+' bytes');chunks.push(b.subarray(0,n));}return Buffer.concat(chunks,size);}finally{fs.closeSync(fd);}}
function fail(message) { process.stderr.write(message + '\n'); process.exitCode = 2; }
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jsonl') out.jsonl = true;
    else if ((['--graph','--request','--comment-request-file','--comment-provider'].includes(argv[i])) && argv[i + 1]) out[argv[i].slice(2)] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!out.graph) throw new Error('Usage: query-analysis.cjs --graph PATH [--request JSON | --jsonl]');
  if ([out.jsonl,out.request != null,out['comment-request-file'] != null].filter(Boolean).length > 1) throw new Error('--request, --comment-request-file and --jsonl cannot be combined');
  return out;
}
async function main() {
  let opts;
  try { opts = args(process.argv.slice(2)); }
  catch (error) { fail(error.message); return; }
  let api;
  try {
    const bytes = fs.readFileSync(opts.graph);
    const content = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes;
    const graph = JSON.parse(content.toString('utf8'));
    var provider;if(opts['comment-provider']){var configured=boundedFile(opts['comment-provider'],65536);if(configured.length>65536)throw new Error('Provider configuration exceeds 65536 bytes');provider=JSON.parse(configured.toString('utf8'));}
    api = Analysis.create(graph, { commentProvider:provider, sha256: crypto.createHash('sha256').update(content).digest('hex'), source: opts.graph });
  } catch (error) { fail(`Unable to load graph: ${error.message}`); return; }
  async function emit(line) {
    let response;
    try {
      if (Buffer.byteLength(line,'utf8') > 8388608) throw new Error('Comment request exceeds 8388608 bytes');
      const request=JSON.parse(line),comment=Comments.operations.includes(request.op)||request.op==='replay'&&request.replay&&Comments.operations.includes(request.replay.operation);
      if(!comment&&Programs.isReplayRequest(request)){if(Buffer.byteLength(line,'utf8')>Programs.schema().replayInputBytes)throw new Error('Program replay exceeds '+Programs.schema().replayInputBytes+' bytes');}
      else if(!comment&&line.length>65536)throw new Error('Request exceeds 65536 characters');
      response = await api.query(request);
    } catch (error) {
      response = { schemaVersion: Analysis.SCHEMA_VERSION, graph: api.graph,
        error: { code: 'INVALID_JSON', message: error.message } };
    }
    process.stdout.write(JSON.stringify(response) + '\n');
    if (response.error && !opts.jsonl) process.exitCode = 1;
  }
  if(opts['comment-request-file']){var bytes=boundedFile(opts['comment-request-file'],8388608);if(bytes.length>8388608){fail('Comment request file exceeds 8388608 bytes');return;}await emit(bytes.toString('utf8'));return;}
  if (opts.request != null) { await emit(opts.request); return; }
  if (opts.jsonl) {
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.trim()) await emit(line);
    }
    return;
  }
  let request = '';
  for await (const chunk of process.stdin) {
    request += chunk;
    if (Buffer.byteLength(request,'utf8') > 8388608) { fail('Comment request exceeds 8388608 bytes'); return; }
  }
  if (!request.trim()) { fail('Expected JSON request on stdin'); return; }
  await emit(request);
}
main().catch(error => fail(error.message));
