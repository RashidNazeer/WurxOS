// Which planning block something belongs to, in the words the page uses:
// Now, Next and After for the roadmap's three block columns, Later for
// unscheduled work.
import { dateRange, isoToday } from './devFormat';

const COLUMN_NAMES = ['Now', 'Next', 'After'];

const byStart = (a, b) => a.starts_on.localeCompare(b.starts_on);

export function currentBlock(blocks, today = isoToday()) {
  return blocks.find((block) => block.starts_on <= today && block.ends_on >= today) || null;
}

/** The roadmap's block columns: the running block and the two after it. */
export function roadmapBlocks(blocks, today = isoToday()) {
  return [...blocks]
    .filter((block) => block.ends_on >= today)
    .sort(byStart)
    .slice(0, COLUMN_NAMES.length);
}

export function columnName(block, columns, today = isoToday()) {
  // Before the first block starts there is no "Now", so the first column is "Next".
  const offset = currentBlock(columns, today) ? 0 : 1;
  return COLUMN_NAMES[columns.indexOf(block) + offset] || dateRange(block.starts_on, block.ends_on);
}

/** "Now block", "Later", or the dates of a block outside the roadmap. */
export function blockPhrase(blockId, blocks, today = isoToday()) {
  if (!blockId) return 'Later';
  const block = blocks.find((item) => item.id === blockId);
  if (!block) return 'Scheduled';
  const columns = roadmapBlocks(blocks, today);
  if (columns.includes(block)) return `${columnName(block, columns, today)} block`;
  const when = block.ends_on < today ? 'Past' : 'Future';
  return `${when} block · ${dateRange(block.starts_on, block.ends_on)}`;
}
