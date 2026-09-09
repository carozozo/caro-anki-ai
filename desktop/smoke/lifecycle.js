const runLifecycleSmoke = async ({ assert, delay, evaluate, touch, until, window }) => {
await delay(500);
// A watched-source change is answered on the watcher's own debounce, and a backend change also restarts the
// backend process, so both waits carry a larger budget than a state assertion.
let stamp = await evaluate('performance.timeOrigin');
touch('frontend/index.html');
await until(async () => await evaluate('performance.timeOrigin') !== stamp,
  () => 'the window never reloaded after the frontend source change', 300);
console.log('PASS: frontend changes reload the window');
await delay(500);
stamp = await evaluate('performance.timeOrigin');
touch('backend/server.js');
await until(async () => await evaluate('performance.timeOrigin') !== stamp,
  () => 'the window never reloaded after the backend source change', 300);
console.log('PASS: backend changes restart and reconnect');
for (const width of [900, 640]) {
  window.setSize(width, 800);
  await delay(200);
  assert.equal(await evaluate(`(() => {
    const search = document.querySelector('#ankiSearchForm').getBoundingClientRect();
    const chat = document.querySelector('#ankiChat').getBoundingClientRect();
    return chat.top >= search.bottom;
  })()`), true);
}
window.setSize(1400, 950);
console.log('PASS: expanded Anki Agent stays below search at narrow widths');
};

module.exports = { runLifecycleSmoke };

