import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForPlayout } from './playout.mjs';

function notify(state) { for (const fn of state.playoutListeners || []) fn(); }

test('farewell audio must drain before hangup is allowed', async () => {
  const state = { assistantAudioActive: true, closed: false };
  let done = false;
  const waiting = waitForPlayout(state, { pauseMs: 5, timeoutMs: 1000 }).then(value => { done = true; return value; });
  await delay(10);
  assert.equal(done, false);
  state.assistantAudioActive = false; notify(state);
  assert.equal(await waiting, true);
  assert.equal(state.playoutListeners.size, 0);
});

test('audio that starts during the quiet pause postpones hangup', async () => {
  const state = { assistantAudioActive: false, closed: false };
  let done = false;
  const waiting = waitForPlayout(state, { pauseMs: 10, timeoutMs: 1000 }).then(value => { done = true; return value; });
  state.assistantAudioActive = true; notify(state);
  await delay(20);
  assert.equal(done, false);
  state.assistantAudioActive = false; notify(state);
  assert.equal(await waiting, true);
});

test('closing the call cancels a pending playback wait', async () => {
  const state = { assistantAudioActive: true, closed: false };
  const waiting = waitForPlayout(state, { timeoutMs: 1000 });
  state.closed = true; notify(state);
  assert.equal(await waiting, false);
  assert.equal(state.playoutListeners.size, 0);
});

test('a missing playback completion event never grants permission to cut audio', async () => {
  const state = { assistantAudioActive: true, closed: false };
  assert.equal(await waitForPlayout(state, { timeoutMs: 10 }), false);
  assert.equal(state.playoutListeners.size, 0);
});
