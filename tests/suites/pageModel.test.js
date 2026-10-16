// Decoding window.__PAGE_MODEL from a property page, in both of Rightmove's formats.
import { test, equal, assert, fixture } from '../lib/t.js';
import { extractPageModel } from '/src/pageModel.js';

test('real page with a Size field (flattened encoding)', async () => {
  const pd = extractPageModel(await fixture('page-models/173701142.html')).propertyData;
  equal(pd.id, '173701142', 'id');
  equal(pd.sizings.find((s) => s.unit === 'sqft')?.minimumSize, 1475, 'sqft sizing');
  equal(pd.floorplans.length, 1, 'floorplans');
  assert(pd.text.description.startsWith('Century 21 Heritage'), 'description decoded');
  equal(pd.keyFeatures.length, 7, 'key features');
});

test('real page with no Size field (flattened encoding)', async () => {
  const pd = extractPageModel(await fixture('page-models/94142151.html')).propertyData;
  equal(pd.id, '94142151', 'id');
  equal(pd.sizings, [], 'sizings');
  assert(pd.floorplans[0].url.startsWith('https://media.rightmove.co.uk/'), 'floorplan url');
  equal(pd.brochures.length, 1, 'brochures');
});

test('plain JSON form', () => {
  const html = '<script>window.__PAGE_MODEL = {"propertyData":{"id":1,"sizings":[]}};</script>';
  equal(extractPageModel(html).propertyData.id, 1);
});

test('braces and quotes inside strings do not end the object early', () => {
  const html = String.raw`<script>window.__PAGE_MODEL = {"propertyData":{"id":2,"text":{"description":"a } \" { b"}}}; window.x = {};</script>`;
  equal(extractPageModel(html).propertyData.text.description, 'a } " { b');
});

test('flattened form: shared references and negative (null) indices', () => {
  const table = [{ propertyData: 1 }, { id: 2, a: 3, b: 3, missing: -1 }, 7, ['x']];
  const html = `<script>window.__PAGE_MODEL = ${JSON.stringify({ encoding: 'on', data: JSON.stringify(table) })};</script>`;
  const pd = extractPageModel(html).propertyData;
  equal([pd.id, pd.a, pd.b === pd.a, pd.missing], [7, ['x'], true, null]);
});

test('page without a model', () => equal(extractPageModel('<html></html>'), null));
