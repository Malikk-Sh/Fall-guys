import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_THEMES,
  campaignChapterNumber,
  campaignThemeFor
} from '../client/game/CampaignPresentation.js';

test('campaign chapters map to four presentation worlds', () => {
  for (const id of ['ch1', 'ch2', 'ch3']) assert.equal(campaignThemeFor(id)?.id, 'cloud-factory');
  for (const id of ['ch4', 'ch5', 'ch6']) assert.equal(campaignThemeFor(id)?.id, 'storm-zone');
  for (const id of ['ch7', 'ch8', 'ch9']) assert.equal(campaignThemeFor(id)?.id, 'reactor');
  assert.equal(campaignThemeFor('ch10')?.id, 'collapse');
});

test('unknown chapters do not receive a presentation theme', () => {
  assert.equal(campaignChapterNumber('ch7'), 7);
  assert.equal(campaignChapterNumber('chapter7'), null);
  assert.equal(campaignThemeFor('ch0'), null);
  assert.equal(campaignThemeFor('ch11'), null);
  assert.equal(campaignThemeFor(null), null);
});

test('every world defines a distinct valid scene palette', () => {
  const themes = Object.values(CAMPAIGN_THEMES);
  assert.equal(themes.length, 4);
  assert.equal(new Set(themes.map(theme => theme.world)).size, 4);
  assert.equal(new Set(themes.map(theme => theme.background)).size, 4);
  for (const theme of themes) {
    assert.ok(Number.isInteger(theme.background));
    assert.ok(Number.isInteger(theme.fog));
    assert.ok(Number.isInteger(theme.accent));
    assert.ok(theme.fogNear < theme.fogFar);
    assert.ok(theme.sunIntensity > 0);
    assert.ok(theme.exposure > 0);
  }
});
