import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { prepareTask } from './prepare-task.mjs';

test('loads only the selected specialist and records provenance', () => {
  const result = prepareTask({specialist:'backend', task:'Definir contrato', context:'Código de ejemplo'});
  assert.match(result.prompt, /## Solicitud\n\nDefinir contrato/);
  assert.match(result.prompt, /Arquitectura y backend/);
  assert.doesNotMatch(result.prompt, /# Interfaz|# Revisión de código/);
  assert.match(result.sourceBlob, /^[a-f0-9]{40}$/);
  assert.equal(result.modelCalls, 0);
});

test('rejects unknown profiles, traversal, inherited keys and unbounded input', () => {
  for (const specialist of ['all', '../backend', 'constructor', '__proto__', undefined]) {
    assert.throws(() => prepareTask({specialist, task:'Revisar'}));
  }
  assert.throws(() => prepareTask({specialist:'backend',task:' '}));
  assert.throws(() => prepareTask({specialist:'backend',task:'x'.repeat(4001)}));
  assert.throws(() => prepareTask({specialist:'backend',task:'Revisar',context:'x'.repeat(12001)}));
});

test('CLI works outside repository root and preserves Spanish stdin', () => {
  const file = new URL('./prepare-task.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [file.pathname,'frontend','Revisar navegación'], {cwd:'/tmp',input:'Información de prueba',encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.specialist,'frontend');
  assert.match(parsed.prompt,/Información de prueba/);
});

test('CLI refuses oversize stdin and missing arguments with no packet', () => {
  const file = new URL('./prepare-task.mjs', import.meta.url);
  for (const [args,input] of [[['reviewer','Revisar'],'x'.repeat(50000)],[[],'']]) {
    const result = spawnSync(process.execPath,[file.pathname,...args],{input,encoding:'utf8'});
    assert.equal(result.status,1);
    assert.equal(result.stdout,'');
  }
});
