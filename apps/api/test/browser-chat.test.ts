import assert from 'node:assert/strict';
import test from 'node:test';
import { imageUrlsFromJimengTaskHistory, jimengHistoryId } from '../src/providers/browser-chat.js';

test('extracts only the matching Jimeng task images', () => {
  const history = { data: { requested: { history_detail: { item_list: [
    { image_url: 'https://img.example/one.webp' },
    { common_attr: { cover_url: 'https://img.example/two.webp' } }
  ] } }, older: { item_list: [{ image_url: 'https://img.example/wrong.webp' }] } } };
  assert.equal(jimengHistoryId({ data: { aigc_data: { history_record_id: 'requested' } } }), 'requested');
  assert.deepEqual(imageUrlsFromJimengTaskHistory(history, 'requested'), ['https://img.example/one.webp', 'https://img.example/two.webp']);
});
