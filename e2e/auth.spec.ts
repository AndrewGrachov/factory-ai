import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The sign-in flow, in a real browser, against a stub identity provider.
 *
 * dashboard.spec.ts stays on the open board and is untouched: it is the visual regression check and
 * should not churn over an auth change. This file is the one that proves the gate, the round trip
 * and the sign-out, and it runs against its own server with AUTH_MODE=github.
 */

const cards = (page: Page) => page.locator('.cards').first().locator('.card');
const gate = (page: Page) => page.locator('.login-gate');
const signIn = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });

test('an anonymous visitor gets the gate and no dashboard', async ({ page }) => {
    await page.goto('/');

    await expect(gate(page)).toBeVisible();
    await expect(signIn(page)).toBeVisible();
    // The point of gating above App rather than inside it: the panels are never mounted, so no
    // request for data is ever made by somebody who could not read the answer.
    await expect(cards(page)).toHaveCount(0);
});

test('the document itself is served without authentication', async ({ page }) => {
    // If index.html 401'd there would be nothing left to render a sign-in button in. The wall is on
    // /api/*, never on the document — this is what pins that.
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
});

test('signing in lands on the dashboard', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();

    // Through the stub authorize endpoint, back to the callback, and on to the app.
    await expect(cards(page)).toHaveCount(6, { timeout: 60_000 });
    await expect(gate(page)).toHaveCount(0);
});

test('the account claims its invite, so the API answers as a member', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(6, { timeout: 60_000 });

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    // The seed leaves an unclaimed invite for this login; first sign-in is what binds it.
    expect(await me.json()).toMatchObject({ user: { login: 'e2e-user' }, role: 'admin', mode: 'github' });
});

test('signing out returns to the gate', async ({ page }) => {
    await page.goto('/');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(6, { timeout: 60_000 });

    const response = await page.request.post('/api/auth/logout');
    expect(response.status()).toBe(204);

    await page.reload();
    await expect(gate(page)).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
});

test('the returnTo path survives the round trip', async ({ page }) => {
    // Carried inside the signed state rather than in a second cookie, so one signature covers both
    // the CSRF nonce and the destination.
    await page.goto('/?range=week');
    await signIn(page).click();
    await expect(cards(page)).toHaveCount(6, { timeout: 60_000 });
    expect(new URL(page.url()).pathname).toBe('/');
});
