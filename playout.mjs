// Hang up only after playback has finished and a short quiet pause has elapsed.
export function waitForPlayout(state, { pauseMs = 600, timeoutMs = 30000 } = {}) {
  if (state.closed) return Promise.resolve(false);
  return new Promise(resolve => {
    let quietTimer;
    const listeners = state.playoutListeners ||= new Set();
    const finish = result => {
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      listeners.delete(update);
      resolve(result);
    };
    const update = () => {
      clearTimeout(quietTimer);
      if (state.closed) return finish(false);
      if (!state.assistantAudioActive) quietTimer = setTimeout(() => finish(true), pauseMs);
    };
    const deadline = setTimeout(() => finish(false), timeoutMs);
    listeners.add(update);
    update();
  });
}
