// What the account picker adds to the official one, through the real SDK in a
// real popup: a random user shown in the form before signing in as them, the
// form filled in at random, and a long list filtered. The official flow itself is `auth-popup-browser.mjs`,
// held to the official fixture; these have no official counterpart to hold them
// to (its form has a fill button, but the fixture never presses it), so they
// say what they expect here. Only synthetic accounts on an isolated Auth peer.
import assert from 'node:assert/strict';
import { popupApp, popupProject } from './auth-popup-browser.mjs';

const COUNT = 8;
const emailOf = index => `person.${index}@example.test`;

export async function observePickerAdditions(origin, { browserHost } = {}) {
  const users = Array.from({length:COUNT},(_,index)=>({localId:`person-${index}`,email:emailOf(index),displayName:`Person ${index}`,
    providerUserInfo:[{providerId:'google.com',rawId:`person-${index}`,email:emailOf(index),displayName:`Person ${index}`}]}));
  const seeded = await fetch(`${origin}/identitytoolkit.googleapis.com/v1/projects/${popupProject}/accounts:batchCreate`,{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer owner'},
    body:JSON.stringify({users}),signal:AbortSignal.timeout(5000)});
  assert.equal(seeded.status,200);
  const browserOrigin = (url => { if (browserHost) url.hostname = browserHost; return url.origin; })(new URL(origin));
  const {appOrigin,browser,stop} = await popupApp(browserOrigin,popupProject,{browserHost});
  const pageErrors = [];
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(20_000);
    context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
    const page = await context.newPage();
    await page.goto(appOrigin);
    await page.waitForFunction('!!window.probe');
    const openPopup = async () => {
      await page.evaluate('window.probe.signOut()');
      const next = page.waitForEvent('popup');
      await page.click('#popup');
      const popup = await next;
      await popup.waitForURL('**/emulator/auth/handler?**');
      await popup.locator('.js-random-account').waitFor();
      assert.equal(await popup.evaluate('isSecureContext'),!browserHost);
      return popup;
    };
    const signedIn = async popup => {
      await page.waitForFunction('window.popupResult || window.popupError');
      assert.equal(await page.evaluate('window.popupError'),null);
      if (!popup.isClosed()) await popup.waitForEvent('close');
      return (await page.evaluate('window.popupResult')).user;
    };

    // A random user is shown before signing in, and Sign in is ready for Enter.
    let popup = await openPopup();
    await popup.locator('.js-random-account').click();
    const shown = {email:await popup.locator('#email-input').inputValue(),
      name:await popup.locator('#display-name-input').inputValue(),
      screenName:await popup.locator('#screen-name-input').inputValue()};
    assert.match(shown.email,/^[a-z]+\.[a-z]+\.\d{5}@example\.test$/);
    assert.match(shown.name,/^[A-Z][a-z]+ [A-Z][a-zA-Z]+$/);
    assert.match(shown.screenName,/^[a-z]+_[a-z]+$/);
    await popup.keyboard.press('Enter');
    const random = await signedIn(popup);
    assert.equal(random.email,shown.email);
    assert.equal(random.displayName,shown.name);
    assert.deepEqual(random.providers,['google.com']);
    assert.ok(!users.some(user=>user.localId===random.uid));

    // It is a real account: the picker offers it next time, as itself.
    popup = await openPopup();
    assert.equal(await popup.locator('.js-reuse-account').count(),COUNT+1);
    await popup.locator('.js-reuse-account').filter({hasText:random.email}).click();
    assert.equal((await signedIn(popup)).uid,random.uid);

    // The form fills itself in, and signs in as what it shows.
    popup = await openPopup();
    await popup.locator('.js-new-account').click();
    await popup.locator('#autogen-button').click();
    const email = await popup.locator('#email-input').inputValue();
    const name = await popup.locator('#display-name-input').inputValue();
    await popup.locator('#sign-in').click();
    const filled = await signedIn(popup);
    assert.equal(filled.email,email);
    assert.equal(filled.displayName,name);

    // A long list is filtered, and Enter takes the account left.
    popup = await openPopup();
    await popup.locator('#account-filter').fill('person 5');
    assert.equal(await popup.locator('.js-reuse-account:visible').count(),1);
    await popup.locator('#account-filter').press('Enter');
    assert.equal((await signedIn(popup)).uid,'person-5');

    assert.deepEqual(pageErrors,[]);
    return {random,filled};
  } finally {
    await stop();
  }
}
