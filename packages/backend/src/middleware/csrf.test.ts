import assert from 'node:assert/strict';
import test from 'node:test';
import { crossSiteVerdict } from './csrf.js';

test('a request from their own page passes', () => {
  assert.equal(crossSiteVerdict({ secFetchSite: 'same-origin', origin: 'https://house.example.net', host: 'house.example.net' }), null);
  assert.equal(crossSiteVerdict({ secFetchSite: 'none' }), null);
});

test('another site, or a sibling subdomain, is named', () => {
  assert.match(crossSiteVerdict({ secFetchSite: 'cross-site', origin: 'https://evil.test', host: 'house.example.net' }) ?? '', /cross-site/);
  assert.match(crossSiteVerdict({ secFetchSite: 'same-site', origin: 'https://other.example.net', host: 'house.example.net' }) ?? '', /same-site/);
});

test('with no Sec-Fetch-Site, Origin decides, and no Origin at all is not a browser', () => {
  assert.equal(crossSiteVerdict({ origin: 'https://house.example.ts.net', host: 'house.example.ts.net' }), null);
  assert.match(crossSiteVerdict({ origin: 'https://evil.test', host: 'house.example.net' }) ?? '', /not this house/);
  assert.match(crossSiteVerdict({ origin: 'null', host: 'house.example.net' }) ?? '', /null/);
  assert.equal(crossSiteVerdict({ host: 'house.example.net' }), null);
});

test('a forwarded host counts as this house', () => {
  assert.equal(crossSiteVerdict({ origin: 'https://house.example.net', host: 'localhost:3003', forwardedHost: 'house.example.net' }), null);
});
