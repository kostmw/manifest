import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Thumbnails come from Scryfall's CDN. These tests shouldn't depend on it, or hit it.
  await page.route('https://cards.scryfall.io/**', (route) => route.abort());
  await page.goto('./');
  await expect(page.getByRole('combobox', { name: 'Card name' })).toBeEnabled();
});

async function chooseCard(page: Page, query: string, cardName: string) {
  const input = page.getByRole('combobox', { name: 'Card name' });
  await input.fill(query);
  await page.getByRole('option', { name: cardName, exact: true }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`^${cardName}`) })).toBeVisible();
}

async function add(page: Page, query: string, cardName: string, button: string) {
  await chooseCard(page, query, cardName);
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.getByText(/^Added /)).toBeVisible();
  await page.getByRole('button', { name: 'New search' }).click();
}

async function openBatch(page: Page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Batch/ }).click();
}

async function openSettings(page: Page) {
  await page.getByText('Batch settings').click();
}

async function exportAs(page: Page, formatLabel: RegExp) {
  const select = page.getByRole('combobox', { name: 'Format' });
  const value = await select.locator('option', { hasText: formatLabel }).getAttribute('value');
  await select.selectOption(value!);
  return page.getByTestId('export-preview');
}

test('finds cards by typo, by back face and with accents', async ({ page }) => {
  const input = page.getByRole('combobox', { name: 'Card name' });

  await input.fill('sol rnig');
  await expect(page.getByRole('option').first()).toHaveText('Sol Ring');

  await input.fill('Insectile');
  await expect(page.getByRole('option').first()).toHaveText('Delver of Secrets // Insectile Aberration');

  await input.fill('lim dul');
  await expect(page.getByRole('option').first()).toHaveText("Lim-Dûl's Vault");

  await input.fill('qqqqqq');
  await expect(page.getByText('No cards match that name.')).toBeVisible();
});

test('can be used with the keyboard alone', async ({ page }) => {
  const input = page.getByRole('combobox', { name: 'Card name' });
  await input.fill('plains');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: /^Plains/ })).toContainText('4 printings');
});

test('leaves out digital-only cards', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Card name' }).fill('Bronze Horse');
  await expect(page.getByRole('option', { name: 'Bronze Horse', exact: true })).toHaveCount(0);
});

test('lists only the finishes a printing really has', async ({ page }) => {
  await chooseCard(page, 'demonic tutor', 'Demonic Tutor');
  await expect(page.getByRole('button', { name: 'Add CMM 509 Etched' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add CMM 509 Nonfoil' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add CMM 150 Foil' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add CMM 150 Etched' })).toHaveCount(0);
});

test('adds cards to a batch, and every export format shows them', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Foil');
  await add(page, 'delver', 'Delver of Secrets // Insectile Aberration', 'Add ISD 51 Nonfoil');
  await add(page, 'hogaak', 'Hogaak, Arisen Necropolis', 'Add MH1 202 Nonfoil');
  await add(page, 'demonic tutor', 'Demonic Tutor', 'Add CMM 509 Etched');

  await expect(page.getByRole('button', { name: 'Batch (6)' })).toBeVisible();
  await openBatch(page);
  await expect(page.getByTestId('batch-total')).toHaveText('6 cards');

  let preview = await exportAs(page, /^Plain list/);
  await expect(preview).toContainText('3 Sol Ring');
  await expect(preview).toContainText('1 Delver of Secrets');
  await expect(preview).not.toContainText('Insectile');

  preview = await exportAs(page, /^Detailed list/);
  await expect(preview).toContainText('2 Sol Ring (CMM) 410');
  await expect(preview).toContainText('1 Sol Ring (CMM) 410 *F*');
  await expect(preview).toContainText('1 Demonic Tutor (CMM) 509 *E*');

  preview = await exportAs(page, /^Markdown for AI/);
  await expect(preview).toContainText('- Cards: 6');
  await expect(preview).toContainText('- Unique: 4');
  await expect(preview).toContainText('| Qty | Name | Set | # | Finish | Lang |');
  await expect(preview).not.toContainText('| Type |');
  await page.getByRole('checkbox', { name: 'Type' }).check();
  await expect(preview).toContainText('| Type |');
  await expect(preview).toContainText('Artifact');

  preview = await exportAs(page, /^Moxfield/);
  await expect(preview).toContainText('"Count","Tradelist Count","Name","Edition"');
  await expect(preview).toContainText('"2","0","Sol Ring","cmm","Near Mint","English","","","","410","False","False",""');
  await expect(preview).toContainText('"Hogaak, Arisen Necropolis"');

  preview = await exportAs(page, /^ManaBox/);
  await expect(preview).toContainText('Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID');
  await expect(preview).toContainText('Sol Ring,CMM,Commander Masters,410,foil,uncommon,1,');

  preview = await exportAs(page, /^Deckbox/);
  await expect(preview).toContainText('Count,Tradelist Count,Name,Edition,Edition Code,Card Number');
  await expect(preview).toContainText('1,0,Demonic Tutor,Commander Masters,cmm,509,Near Mint,English,foil');

  preview = await exportAs(page, /^Archidekt deck list/);
  await expect(preview).toContainText('2x Sol Ring (cmm) 410');
  await expect(preview).toContainText('1x Sol Ring (cmm) 410 *F*');
  await expect(preview).toContainText('1x Demonic Tutor (cmm) 509 *E*');

  preview = await exportAs(page, /^Archidekt collection CSV/);
  await expect(preview).toContainText('Quantity,Name,Finish,Condition,Date Added,Language');
  await expect(preview).toContainText('1,Demonic Tutor,Etched,NM,');
});

test('groups by card name when asked', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 703 Foil');
  await openBatch(page);

  const preview = await exportAs(page, /^Detailed list/);
  await expect(preview).toContainText('1 Sol Ring (CMM) 703 *F*');
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('name');
  await expect(preview).toHaveText(/^2 Sol Ring\s*$/);
});

test('downloads the file with a sensible name and the exact text', async ({ page }) => {
  await add(page, 'hogaak', 'Hogaak, Arisen Necropolis', 'Add MH1 202 Foil');
  await openBatch(page);
  await openSettings(page);
  await page.getByRole('textbox', { name: 'Batch name' }).fill('Box 3');
  await page.getByRole('textbox', { name: 'Batch name' }).blur();
  await exportAs(page, /^Moxfield/);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('box-3-moxfield.csv');
  const text = await readFile(await download.path(), 'utf8');
  expect(text).toBe(
    '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"\n' +
      '"1","0","Hogaak, Arisen Necropolis","mh1","Near Mint","English","foil","","","202","False","False",""\n',
  );
});

test('copies the export to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Copied to clipboard.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('1 Sol Ring\n');
});

test('edits quantity, finish and condition, and the export follows', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);

  await page.getByRole('button', { name: 'One more Sol Ring' }).click();
  await expect(page.getByLabel('Quantity of Sol Ring')).toHaveText('2');

  // Tapped faster than the page redraws, the way a thumb can.
  await page.getByRole('button', { name: 'One more Sol Ring' }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByLabel('Quantity of Sol Ring')).toHaveText('4');
  await page.getByRole('button', { name: 'One fewer Sol Ring' }).click();
  await page.getByRole('button', { name: 'One fewer Sol Ring' }).click();
  await expect(page.getByLabel('Quantity of Sol Ring')).toHaveText('2');

  await page.getByRole('combobox', { name: 'Finish of Sol Ring' }).selectOption('foil');
  await page.getByRole('combobox', { name: 'Condition of Sol Ring' }).selectOption('LP');
  await page.getByRole('combobox', { name: 'Language of Sol Ring' }).selectOption('de');

  const preview = await exportAs(page, /^Moxfield/);
  await expect(preview).toContainText('"2","0","Sol Ring","cmm","Good (Lightly Played)","German","foil"');

  await page.getByRole('button', { name: 'Remove Sol Ring' }).click();
  await expect(page.getByText('This batch is empty.')).toBeVisible();
});

test('applies the batch defaults to new cards', async ({ page }) => {
  await openBatch(page);
  await openSettings(page);
  await page.getByRole('combobox', { name: 'Language for new cards' }).selectOption('ja');
  await page.getByRole('combobox', { name: 'Condition for new cards' }).selectOption('HP');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Add cards' }).click();

  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  const preview = await exportAs(page, /^Archidekt collection CSV/);
  await expect(preview).toContainText(/1,Sol Ring,Normal,HP,\d{4}-\d{2}-\d{2},JP,/);
});

test('keeps batches after a reload, and keeps them separate', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  await page.getByRole('button', { name: 'New batch' }).click();
  await expect(page.getByText('This batch is empty.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Card name' })).toBeEnabled();
  await openBatch(page);
  await expect(page.getByText('This batch is empty.')).toBeVisible();

  const select = page.getByRole('combobox', { name: 'Current batch' });
  await select.selectOption({ label: 'My first batch' });
  await expect(page.getByTestId('batch-total')).toHaveText('1 card');

  await openSettings(page);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete batch' }).click();
  await expect(select.locator('option', { hasText: 'My first batch' })).toHaveCount(0);
});

test('still works offline once the cards are cached', async ({ page, context }) => {
  await chooseCard(page, 'sol ring', 'Sol Ring');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The worker must control the page before an offline reload can be served.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Card name' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Card name' })).toBeEnabled();
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  await expect(page.getByTestId('batch-total')).toHaveText('1 card');
});

test('never sends card data or batches to a server', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') requests.push(`${request.method()} ${request.url()}`);
  });
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  expect(requests).toEqual([]);
});

test('asks before deleting a batch, and keeps it when told no', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  await openSettings(page);
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: 'Delete batch' }).click();
  await expect(page.getByTestId('batch-total')).toHaveText('1 card');
});

test('starts a fresh batch after the last one is deleted', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  await openSettings(page);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete batch' }).click();
  await expect(page.getByText('This batch is empty.')).toBeVisible();
});

test('changes the printing of a card in the batch', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Foil');
  await openBatch(page);
  await page.getByRole('button', { name: 'Change printing of Sol Ring' }).click();
  const picker = page.getByRole('region', { name: 'Choose a printing' });
  await expect(picker.getByRole('list', { name: 'Printings' }).getByRole('listitem')).toHaveCount(2);
  await picker.getByRole('button', { name: 'Use CMM 703' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByText('CMM 703 · Commander Masters')).toBeVisible();
  // The finish is kept, since the new printing comes in foil too.
  await expect(page.getByRole('combobox', { name: 'Finish of Sol Ring' })).toHaveValue('foil');

  // Or another card altogether, found by name.
  await page.getByRole('button', { name: 'Change printing of Sol Ring' }).click();
  await picker.getByRole('combobox', { name: 'Search another card' }).fill('lightning bolt');
  await picker.getByRole('option', { name: 'Lightning Bolt', exact: true }).click();
  await picker.getByRole('button', { name: 'Use M11 149' }).click();
  await expect(page.getByText('M11 149 · Magic 2011')).toBeVisible();
  await expect(page.getByTestId('batch-total')).toHaveText('1 card');
});

test('merges one batch into another', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await openBatch(page);
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Add cards' }).click();
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Nonfoil');
  await add(page, 'lightning bolt', 'Lightning Bolt', 'Add M11 149 Nonfoil');
  await openBatch(page);
  await expect(page.getByTestId('batch-total')).toHaveText('2 cards');

  await page.getByText('Merge, back up, restore').click();
  await page.getByRole('combobox', { name: 'Merge another batch into this one' }).selectOption({ label: 'My first batch' });
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText('Merged “My first batch” into “Batch 2”.')).toBeVisible();
  await expect(page.getByTestId('batch-total')).toHaveText('3 cards');
  await expect(page.getByLabel('Quantity of Sol Ring')).toHaveText('2');
  await expect(page.getByRole('combobox', { name: 'Current batch' }).locator('option')).toHaveCount(1);
});

test('backs up every batch to a file and restores it after the data is gone', async ({ page }) => {
  await add(page, 'sol ring', 'Sol Ring', 'Add CMM 410 Foil');
  await openBatch(page);
  await openSettings(page);
  await page.getByRole('textbox', { name: 'Batch name' }).fill('Box 3');
  await page.getByRole('textbox', { name: 'Batch name' }).blur();
  await page.getByText('Merge, back up, restore').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^manifest-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(backup)).toMatchObject({ format: 'manifest-backup', version: 1, batches: [{ name: 'Box 3', items: [{ qty: 1, finish: 'foil' }] }] });

  // Storage cleared: deleting the only batch leaves a fresh empty one.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete batch' }).click();
  await expect(page.getByText('This batch is empty.')).toBeVisible();

  await page.getByText('Merge, back up, restore').click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByLabel('Restore from backup').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.getByText('Restored 1 batch, 1 card and 0 to review.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Current batch' }).selectOption({ label: 'Box 3' });
  await expect(page.getByTestId('batch-total')).toHaveText('1 card');
  await expect(page.getByRole('combobox', { name: 'Finish of Sol Ring' })).toHaveValue('foil');
});

test('refuses a file that is not a backup', async ({ page }) => {
  await openBatch(page);
  await page.getByText('Merge, back up, restore').click();
  await page.getByLabel('Restore from backup').setInputFiles({ name: 'list.json', mimeType: 'application/json', buffer: Buffer.from('{"cards":[]}') });
  await expect(page.getByRole('alert')).toContainText("This file isn't a Manifest backup.");
});
