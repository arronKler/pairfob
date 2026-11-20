import assert from 'node:assert/strict';
import test from 'node:test';
import { observeVideo } from './observer.js';

test('a suppressed video callback cannot hide a pixel change or complete a flip twice', async t => {
  let luma = 0;
  const pixels = {drawImage() {}, getImageData: () => ({data: [luma]})};
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.document = {createElement: () => ({getContext: () => pixels})};
  globalThis.location = new URL('http://localhost/');
  t.after(() => {
    for (const [name, descriptor] of [['document', documentDescriptor], ['location', locationDescriptor]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let callback;
  const video = {readyState:2, videoWidth:640, videoHeight:360, requestVideoFrameCallback(fn) {callback = fn;}};
  const s = {traces: []};
  const baseline = Promise.withResolvers();
  const change = Promise.withResolvers();
  let completions = 0;
  const observer = observeVideo(video, s, {
    ready: baseline.resolve,
    complete(row) {
      completions++;
      s.pending = undefined;
      change.resolve(row);
    },
  });
  t.after(() => observer.close());
  await baseline.promise;
  s.pending = performance.now();
  s.traces.push({start:s.pending});
  observer.flip();
  callback(0, {rtpTimestamp:200, presentedFrames:1});
  assert.equal(completions, 0);
  luma = 255;
  const row = await change.promise;
  assert.equal(row.observer, 'timer');
  callback(0, {rtpTimestamp:500, presentedFrames:2});
  assert.equal(completions, 1);
});
