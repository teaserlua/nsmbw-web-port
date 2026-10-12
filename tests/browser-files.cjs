'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const vm = require('node:vm');

const decoded = zlib.gunzipSync(fs.readFileSync('web/rgh.wasm.gz'));
const moduleWasm = new WebAssembly.Module(decoded);
const imports = new Set(WebAssembly.Module.imports(moduleWasm).map(x=>`${x.module}.${x.name}`));
for(const name of ['rgh.file_size','rgh.file_read','rgh.nand_save','rgh.ring_ready']) assert(imports.has(name),name);
console.log(`PASS NSMBW WebAssembly (${decoded.length} bytes, ${imports.size} imports)`);

const fake = Uint8Array.from({length:600_000},(_,i)=>i%251);
const file={size:fake.length,slice:(start,end)=>fake.slice(start,end)};
const c=vm.createContext({Map,Uint8Array,DataView,TextDecoder,TextEncoder,ArrayBuffer,onmessage:null,
  XMLHttpRequest:class{constructor(){throw Error('Unexpected network I/O with local selected files');}},
  FileReaderSync:class{readAsArrayBuffer(bytes){return bytes.buffer;}}});
vm.runInContext(fs.readFileSync('web/rgh-worker.js','utf8'),c);
c._mem={buffer:new ArrayBuffer(1024*1024)};
c._cfg={base:'https://example.invalid/',localFiles:[['game/files/test.bin',file]]};
vm.runInContext('mem=_mem;cfg=_cfg;localFiles=new Map(cfg.localFiles);localReader=new FileReaderSync()',c);
assert.equal(vm.runInContext("fileSize('game/files/test.bin')",c),600_000);
assert.equal(vm.runInContext("fileSize('game/files/missing.bin')",c),-1);
assert.equal(vm.runInContext("fileRead('game/files/test.bin',260000,100,300000)",c),300_000);
assert.deepEqual(new Uint8Array(c._mem.buffer,100,300_000),fake.subarray(260000,560000));
assert.equal(vm.runInContext("fileRead('game/files/test.bin',599990,0,100)",c),10);
console.log('PASS selected folder read, block boundary, EOF and missing file');
